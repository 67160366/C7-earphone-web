/*
 * C7-BioSync collect mode (classic script, load after c7-core.js). Exposes window.C7.Collect.
 * Decodes the raw 50 Hz lines that esp32_c7_prototype.ino prints after the `r` command,
 * turns them into SI-ish units, builds CSV rows and runs a labelled simulator.
 * Line formats and units: docs/DATA_COLLECTION.md.
 *
 *   H,format=1,boot_id=..,calibration_id=..,rate_hz=50,...      header (key=value)
 *   D,seq,t_ms,flags, L(qw qx qy qz ax ay az gx gy gz acc), R(same), C7(ax ay az gx gy gz)
 *
 * Angles x/y/z of the ear sensors are Euler angles in the chip's own axes (same formula as
 * quaternionToEulerDeg() in the firmware). They are NOT head pitch/roll/yaw: the axis mapping
 * to the head is still open (docs/SENSOR_AXES.md), so pages must label them "แกนของชิป".
 */
(function (root) {
    'use strict';
    const C7 = root.C7;
    if (!C7) throw new Error('load c7-core.js before c7-collect.js');

    const FORMAT = 1;
    const RATE_HZ = 50;
    const G = 9.80665;
    const DEG = Math.PI / 180;
    const EAR_FIELDS = 11, C7_FIELDS = 6;
    const D_FIELDS = 1 + 3 + EAR_FIELDS * 2 + C7_FIELDS; // 'D' + seq,t,flags + L + R + C7 = 32
    // Raw integer -> unit. BNO085 (SH-2): quaternion Q14, accel Q8 m/s², calibrated gyro Q9 rad/s.
    // MPU6050 at ±2 g / ±250 °/s: 16384 LSB/g, 131 LSB/(°/s).
    const SCALE = Object.freeze({
        q: 1 / 16384,
        bnoAcc: 1 / 256,              // -> m/s²
        bnoGyro: (1 / 512) / DEG,     // -> °/s
        mpuAcc: G / 16384,            // -> m/s²
        mpuGyro: 1 / 131,             // -> °/s
    });
    const FLAG = Object.freeze({ L: 1, R: 2, C: 4, L_NEW: 8, R_NEW: 16, C_NEW: 32 });

    /* ---------- quaternion helpers, [w, x, y, z] ---------- */
    const qMul = (a, b) => [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
    const qConj = (q) => [q[0], -q[1], -q[2], -q[3]];
    function qNorm(q) { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return q.map((v) => v / n); }
    function qAxisAngle(axis, deg) {
        const h = deg * DEG / 2, s = Math.sin(h), n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
        return [Math.cos(h), axis[0] / n * s, axis[1] / n * s, axis[2] / n * s];
    }
    /** Rotate vector v by unit quaternion q (q v q*). */
    function qRotate(q, v) { const r = qMul(qMul(q, [0, v[0], v[1], v[2]]), qConj(q)); return [r[1], r[2], r[3]]; }
    /** Angle (deg, 0..180) of the rotation between two unit quaternions. */
    function qAngleDeg(aIn, bIn) {
        // Normalise first: Q14 quaternions are a little off unit length and acos near 1 magnifies that.
        const a = qNorm(aIn), b = qNorm(bIn);
        const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
        return 2 * Math.acos(Math.min(1, d)) / DEG;
    }

    /** Euler angles in the chip's axes, same formula and order as quaternionToEulerDeg() in the firmware. */
    function chipEulerDeg(qIn) {
        const [w, x, y, z] = qNorm(qIn);
        const ex = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) / DEG;
        const sy = 2 * (w * y - z * x);
        const ey = Math.abs(sy) >= 1 ? Math.sign(sy) * 90 : Math.asin(sy) / DEG;
        const ez = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) / DEG;
        return [ex, ey, ez];
    }
    /**
     * Tilt of the MPU from its accelerometer: x = atan2(ay, az), y = atan2(ax, az).
     * y is the same quantity as mpu_tilt_raw in protocol v2. There is no z: gravity cannot see heading.
     */
    function accTiltDeg(acc) { return [Math.atan2(acc[1], acc[2]) / DEG, Math.atan2(acc[0], acc[2]) / DEG]; }

    /**
     * Left/right disagreement (deg). Uses each ear's world-frame change since its tare, q * q_tare^-1,
     * which is the same rotation for both ears on a rigid skull whatever the mounting (base_plan.md 4.2).
     * Without a tare it compares the raw orientations (mounting difference included).
     */
    function lrDeg(qL, qR, tare) {
        if (!qL || !qR) return null;
        if (tare && tare.L && tare.R) return qAngleDeg(qMul(qNorm(qL), qConj(tare.L)), qMul(qNorm(qR), qConj(tare.R)));
        return qAngleDeg(qNorm(qL), qNorm(qR));
    }

    const wrap180 = (d) => { let v = d % 360; if (v > 180) v -= 360; if (v < -180) v += 360; return v; };
    const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
    /** Snapshot of the zero posture, taken by the page at "ตั้งท่าเริ่มต้น" (same moment the firmware tares). */
    function headTare(s) {
        return { L: s && s.L ? s.L.euler.slice() : null, R: s && s.R ? s.R.euler.slice() : null, C: s && s.C ? s.C.tilt[1] : null };
    }
    /**
     * Head pitch/roll/yaw and MPU tilt computed exactly like the firmware loop (protocol v2):
     * per-ear chip Euler minus its zero, circular midpoint of both ears, then the protocol limits.
     * Nothing is remapped here: if the chip axes do not match the head, this shows it (docs/SENSOR_AXES.md).
     * Returns raw (before limits) and clamped values plus each ear's own change, for the axis check.
     */
    function firmwareHead(s, tare) {
        if (!s || !tare) return null;
        const delta = (e, z) => (e && z ? e.euler.map((v, i) => wrap180(v - z[i])) : null);
        const dL = delta(s.L, tare.L), dR = delta(s.R, tare.R);
        if (!dL && !dR) return null;
        const mid = (a, b) => wrap180(a + wrap180(b - a) * 0.5);
        const both = dL && dR ? dL.map((v, i) => mid(v, dR[i])) : (dL || dR);
        const raw = { pitch: both[0], roll: both[1], yaw: both[2] };
        const tilt = s.C && Number.isFinite(tare.C) ? wrap180(s.C.tilt[1] - tare.C) : null;
        const lim = C7.LIMITS;
        return {
            raw, dL, dR, source: dL && dR ? 'LR' : dL ? 'L' : 'R',
            pitch: clamp(raw.pitch, lim.pitch), roll: clamp(raw.roll, lim.roll), yaw: clamp(raw.yaw, lim.yaw),
            tilt: tilt === null ? null : clamp(tilt, lim.tilt), tiltRaw: tilt,
        };
    }

    /** Lost lines between two 16-bit sequence numbers; a jump backwards (stream restarted) counts as 0. */
    function seqGap(prev, cur) {
        if (!Number.isInteger(prev) || !Number.isInteger(cur)) return 0;
        const gap = (cur - prev - 1) & 0xFFFF;
        return gap > 30000 ? 0 : gap;
    }

    /* ---------- line decoding ---------- */
    function parseHeader(text) {
        const parts = String(text).trim().split(',');
        if (parts[0] !== 'H') return null;
        const h = {};
        for (const kv of parts.slice(1)) {
            const i = kv.indexOf('=');
            if (i <= 0) continue;
            const k = kv.slice(0, i), v = kv.slice(i + 1);
            h[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
        }
        return h;
    }

    const toInt = (s) => (/^-?\d+$/.test(s) ? Number(s) : NaN);
    /** Returns {seq, tDev, flags, L, R, C} (missing sensor = null) or null when the line is malformed. */
    function parseData(text) {
        const f = String(text).trim().split(',');
        if (f[0] !== 'D' || f.length !== D_FIELDS) return null;
        const seq = toInt(f[1]), tDev = toInt(f[2]), flags = toInt(f[3]);
        if (![seq, tDev, flags].every(Number.isFinite)) return null;
        const block = (start, n) => {
            const vals = f.slice(start, start + n);
            if (vals.every((v) => v === '')) return { empty: true };
            const ints = vals.map(toInt);
            return ints.every(Number.isFinite) ? { ints } : null;
        };
        const ear = (start, freshBit, newBit) => {
            const b = block(start, EAR_FIELDS);
            if (!b) return undefined;
            if (b.empty || !(flags & freshBit)) return null;
            const v = b.ints;
            return {
                q: [v[0], v[1], v[2], v[3]].map((x) => x * SCALE.q),
                acc: [v[4], v[5], v[6]].map((x) => x * SCALE.bnoAcc),
                gyro: [v[7], v[8], v[9]].map((x) => x * SCALE.bnoGyro),
                accuracy: v[10], updated: !!(flags & newBit), raw: v,
            };
        };
        const L = ear(4, FLAG.L, FLAG.L_NEW), R = ear(4 + EAR_FIELDS, FLAG.R, FLAG.R_NEW);
        const cb = block(4 + EAR_FIELDS * 2, C7_FIELDS);
        if (L === undefined || R === undefined || !cb) return null;
        let C = null;
        if (!cb.empty && (flags & FLAG.C)) {
            const v = cb.ints;
            C = { acc: [v[0], v[1], v[2]].map((x) => x * SCALE.mpuAcc), gyro: [v[3], v[4], v[5]].map((x) => x * SCALE.mpuGyro), updated: !!(flags & FLAG.C_NEW), raw: v };
        }
        if (L) L.euler = chipEulerDeg(L.q);
        if (R) R.euler = chipEulerDeg(R.q);
        if (C) C.tilt = accTiltDeg(C.acc);
        return { seq, tDev, flags, L, R, C };
    }

    /** Integrates the MPU z gyro into a heading that drifts; reset at every recording start. */
    class Integrator {
        constructor() { this.reset(); }
        reset() { this.value = 0; this.lastT = null; }
        add(tMs, rateDps) {
            if (Number.isFinite(rateDps) && this.lastT !== null) {
                const dt = (tMs - this.lastT) / 1000;
                if (dt > 0 && dt < 0.5) this.value += rateDps * dt; // skip gaps instead of jumping
            }
            this.lastT = tMs;
            return this.value;
        }
    }

    /* ---------- CSV ---------- */
    const EAR_COLS = ['qw', 'qx', 'qy', 'qz', 'ax', 'ay', 'az', 'gx', 'gy', 'gz', 'acc', 'ex', 'ey', 'ez'];
    const COLUMNS = Object.freeze([
        't_host_ms', 'seq', 't_dev_ms', 'flags', 'label', 'step', 'ref_angle_deg',
        ...EAR_COLS.map((c) => `L_${c}`), ...EAR_COLS.map((c) => `R_${c}`),
        'C_ax', 'C_ay', 'C_az', 'C_gx', 'C_gy', 'C_gz', 'C_ex', 'C_ey', 'C_ez_gyro',
        'lr_deg', 'simulated',
    ]);
    const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
    /** One CSV row (array in COLUMNS order). ctx = {tHost, label, step, ref, lr, cz, simulated}. */
    function rowFromSample(s, ctx) {
        const ear = (e) => (e ? [...e.q.map((v) => round(v, 6)), ...e.acc.map((v) => round(v, 4)), ...e.gyro.map((v) => round(v, 3)), e.accuracy, ...e.euler.map((v) => round(v, 3))] : new Array(EAR_COLS.length).fill(null));
        const c = s.C ? [...s.C.acc.map((v) => round(v, 4)), ...s.C.gyro.map((v) => round(v, 3)), ...s.C.tilt.map((v) => round(v, 3)), round(ctx.cz, 3)] : new Array(9).fill(null);
        return [
            Math.round(ctx.tHost), s.seq, s.tDev, s.flags, ctx.label || '', ctx.step === null || ctx.step === undefined ? null : ctx.step,
            round(ctx.ref, 2), ...ear(s.L), ...ear(s.R), ...c, round(ctx.lr, 3), ctx.simulated ? 1 : 0,
        ];
    }
    function csvCell(v) {
        if (v === null || v === undefined) return '';
        if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
        const t = String(v);
        return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    }
    /** CSV text in chunks (array of strings) so a long session never builds one giant string. */
    function csvChunks(rows, chunkRows = 5000) {
        const out = [COLUMNS.join(',') + '\n'];
        for (let i = 0; i < rows.length; i += chunkRows) {
            out.push(rows.slice(i, i + chunkRows).map((r) => r.map(csvCell).join(',')).join('\n') + '\n');
        }
        return out;
    }

    /* ---------- protocol (list of postures) ---------- */
    // Thai names for the recommended postures; any other label is shown as typed.
    const LABELS = Object.freeze({
        calib_fig8: 'หมุนศีรษะเป็นเลข 8 (ให้เซ็นเซอร์ปรับตัว)',
        neutral: 'นั่งตรง มองตรง',
        forward_head: 'ยื่นคอไปหน้า ตามองจอ',
        text_neck: 'ก้มดูมือถือ',
        desk_down: 'ก้มดูโต๊ะ',
        look_up: 'เงยหน้า',
        tilt_left: 'เอียงหูซ้ายลง',
        tilt_right: 'เอียงหูขวาลง',
        turn_left: 'หันซ้าย',
        turn_right: 'หันขวา',
        lean_back: 'เอนหลังพิงเก้าอี้',
        trunk_forward: 'โน้มตัวทั้งตัวไปหน้า (คอตรง)',
        chin_tuck: 'เก็บคาง',
        free: 'ทำงานตามปกติ',
        transition: 'เปลี่ยนท่า',
    });
    const DEFAULT_PROTOCOL = [
        'calib_fig8,10', 'neutral,30', 'forward_head,30', 'neutral,15', 'text_neck,30', 'neutral,15', 'desk_down,30',
        'look_up,20', 'chin_tuck,20', 'tilt_left,20', 'tilt_right,20', 'turn_left,20', 'turn_right,20',
        'lean_back,30', 'trunk_forward,30', 'neutral,30',
    ].join('\n');
    /** "label,seconds" per line (# = comment). Returns {steps:[{label, seconds}], errors:[line numbers]}. */
    function parseProtocol(text) {
        const steps = [], errors = [];
        String(text).split(/\r?\n/).forEach((line, i) => {
            const t = line.trim();
            if (!t || t.startsWith('#')) return;
            const m = /^([A-Za-z0-9_\-]+)\s*,\s*(\d+(?:\.\d+)?)$/.exec(t);
            if (!m || Number(m[2]) <= 0) { errors.push(i + 1); return; }
            steps.push({ label: m[1], seconds: Number(m[2]) });
        });
        return { steps, errors };
    }
    /** Interleave a 'transition' step between postures; the first posture keeps its lead-in too. */
    function withTransitions(steps, seconds = 3) {
        const out = [];
        steps.forEach((s) => { if (seconds > 0) out.push({ label: 'transition', seconds, auto: true }); out.push(Object.assign({}, s)); });
        return out;
    }
    /** Shuffle the postures between the first two steps (calibration + baseline) and the last one, keeping those fixed. */
    function shuffleMiddle(steps, rand = Math.random) {
        if (steps.length < 5) return steps.slice();
        const head = steps.slice(0, 2), mid = steps.slice(2, -1), tail = steps.slice(-1);
        for (let i = mid.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [mid[i], mid[j]] = [mid[j], mid[i]]; }
        return [...head, ...mid, ...tail];
    }

    /* ---------- simulator (pages must label everything it produces as simulated) ---------- */
    const r16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
    const noise = (a) => (Math.random() * 2 - 1) * a;
    class CollectSimulator extends C7.Simulator {
        constructor(opts = {}) {
            super(Object.assign({ script: 'demo' }, opts));
            this.streaming = false; this.seq = 0; this.dataTimer = null; this.jsonTick = 0;
            this.prev = { L: null, R: null, tilt: null, t: null };
            // Each ear board sits on the side of the head, turned differently (+ a few degrees of mounting error).
            this.mount = {
                L: qMul(qAxisAngle([0, 0, 1], 90), qAxisAngle([1, 0, 0], 4)),
                R: qMul(qMul(qAxisAngle([0, 0, 1], -90), qAxisAngle([0, 1, 0], 180)), qAxisAngle([0, 1, 0], -3)),
            };
        }
        start(out) {
            this.out = out; this.t0 = this.now();
            this.out('[ESP-LOG] simulator started (not a real device)');
            this.timer = setInterval(() => {
                // v2 JSON at 5 Hz, or 1 Hz while streaming, like the firmware.
                if (!this.streaming || ++this.jsonTick % 5 === 0) this.emitPacket();
            }, 200);
            this.dataTimer = setInterval(() => { if (this.streaming) this.emitData(); }, 1000 / RATE_HZ);
        }
        stop() {
            super.stop();
            if (this.dataTimer) clearInterval(this.dataTimer);
            this.dataTimer = null;
        }
        header() {
            return `H,format=${FORMAT},boot_id=${this.bootId},calibration_id=${this.calibrationId},rate_hz=${RATE_HZ},i2c_hz=400000,bno_q=14,bno_acc_q=8,bno_gyro_q=9,mpu_acc_lsb_g=16384,mpu_gyro_lsb_dps=131,left=1,right=1,c7=1,simulated=1`;
        }
        command(text) {
            const c = String(text).trim().charAt(0).toLowerCase();
            if (c === 'r') {
                if (!this.streaming) { this.streaming = true; this.seq = 0; this.prev = { L: null, R: null, tilt: null, t: null }; this.out('[ESP-LOG] COLLECT mode ON -> D lines 50 Hz (simulated)'); }
                this.out(this.header());
            } else if (c === 'n') {
                if (this.streaming) this.out('[ESP-LOG] COLLECT mode OFF -> protocol v2 JSON 5 Hz (simulated)');
                this.streaming = false;
            } else super.command(text);
        }
        /** Head orientation in a y-up, z-forward world: yaw about y, pitch about x, roll about z. */
        headQuat(p) { return qMul(qMul(qAxisAngle([0, 1, 0], p.yaw), qAxisAngle([1, 0, 0], p.pitch)), qAxisAngle([0, 0, 1], -p.roll)); }
        /** One ear: quaternion, specific force (gravity reaction) and body-rate gyro, as raw firmware integers. */
        earRaw(side, head, dt) {
            const q = qMul(head, this.mount[side]);
            const acc = qRotate(qConj(q), [0, G, 0]).map((v) => v + noise(0.04));
            let gyro = [0, 0, 0];
            const prev = this.prev[side];
            if (prev && dt > 0) {
                const d = qMul(qConj(prev), q);
                const s = d[0] < 0 ? -1 : 1;
                const ang = 2 * Math.acos(Math.min(1, Math.abs(d[0])));
                const sin = Math.sin(ang / 2) || 1;
                gyro = [d[1] * s / sin, d[2] * s / sin, d[3] * s / sin].map((a) => (ang > 1e-9 ? a * ang / dt : 0));
            }
            this.prev[side] = q;
            gyro = gyro.map((v) => v + noise(0.004));
            return [...q.map((v) => r16(v * 16384)), ...acc.map((v) => r16(v * 256)), ...gyro.map((v) => r16(v * 512)), 3];
        }
        emitData() {
            const t = this.now() - this.t0;
            const dt = this.prev.t === null ? 0 : (t - this.prev.t) / 1000;
            const p = this.scripted(t);
            const head = this.headQuat(p);
            const L = this.earRaw('L', head, dt), R = this.earRaw('R', head, dt);
            // MPU on the back of the neck: tilt turns the board about its own y axis (same quantity as mpu_tilt_raw).
            const a = (60 + p.tilt) * DEG;
            const gyroY = this.prev.tilt === null || dt <= 0 ? 0 : (p.tilt - this.prev.tilt) / dt;
            this.prev.tilt = p.tilt; this.prev.t = t;
            const C = [G * Math.sin(a) + noise(0.05), noise(0.05), G * Math.cos(a) + noise(0.05)].map((v) => r16(v / G * 16384))
                .concat([noise(0.3), gyroY + noise(0.3), noise(0.3)].map((v) => r16(v * 131)));
            const seq = this.seq; this.seq = (this.seq + 1) & 0xFFFF;
            if (Math.random() < 0.002) return; // a rare lost line, so the page's gap counter is exercised
            this.out(['D', seq, Math.round(t), 0x3F, ...L, ...R, ...C].join(','));
        }
    }

    C7.Collect = {
        FORMAT, RATE_HZ, SCALE, FLAG, COLUMNS, LABELS, DEFAULT_PROTOCOL,
        parseHeader, parseData, chipEulerDeg, accTiltDeg, lrDeg, seqGap, headTare, firmwareHead, qMul, qConj, qNorm, qAxisAngle, qRotate, qAngleDeg,
        rowFromSample, csvCell, csvChunks, parseProtocol, withTransitions, shuffleMiddle, Integrator, CollectSimulator,
    };
})(typeof window !== 'undefined' ? window : globalThis);
