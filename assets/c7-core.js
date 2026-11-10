/*
 * C7-BioSync shared core (classic script, no build step, works offline and from file:).
 * Exposes window.C7: CVA model, protocol v2 (and legacy v1) validation, serial line parser,
 * posture classification, the Web Serial device session and a labelled simulator.
 *
 * CVA model (geometry 1, explained in docs/FORMULA.md). Two links in the side (sagittal) plane, in cm:
 *   C7 at the origin, z forward, y up. Positive angles lean forward / chin down.
 *   phi = phi0 + gain * tilt            neck line C7 -> C0 measured from vertical
 *   C0  = R(phi)   * (0, L)             head-on-neck joint
 *   T   = C0 + R(pitch) * (tz, ty)       mid-tragus, carried by the skull around C0
 *   CVA = atan2(T.y, T.z)               line C7 -> tragus against the horizontal
 * phi0 is solved so the zero posture is exactly NEUTRAL_CVA. Roll and yaw do not enter CVA.
 * The same formula lives in calculateCVA() (esp32_c7_prototype.ino) and api/save_angle.php.
 */
(function (root) {
    'use strict';

    const DEG = Math.PI / 180;
    const STALE_MS = 1200;
    const ZERO_TIMEOUT_MS = 5000;
    const SCAN_TIMEOUT_MS = 3500;
    const PARITY_TOLERANCE = 0.15;
    const LIMITS = { tilt: [-30, 40], pitch: [-25, 45], roll: [-30, 30], yaw: [-40, 40], c7: [-15, 35] };
    const NEUTRAL_CVA = 52.05;
    const PROTOCOL_VERSION = 2;
    // USB baud of esp32_c7_prototype.ino (SERIAL_BAUD). 460800 leaves room for the 50 Hz collect stream.
    const BAUD = 460800;

    /* ---------- CVA model, geometry 1 ---------- */
    // kind: 'measured' = read from a sensor, 'assumed' = chosen value to be calibrated, 'derived' = calculated.
    const GEOMETRY = Object.freeze({
        id: 1,
        neckLength: { value: 12, unit: 'cm', kind: 'assumed', source: 'ระยะ C7 ถึง C0 ของผู้ใหญ่ อยู่ในช่วง 10–13 cm (base_plan.md 4.3)' },
        tragusForward: { value: 1.0, unit: 'cm', kind: 'assumed', source: 'ติ่งหูอยู่หน้าข้อต่อหัวกับคอ (C0) ประมาณ 1 cm' },
        tragusUp: { value: 2.0, unit: 'cm', kind: 'assumed', source: 'ติ่งหูอยู่สูงกว่า C0 ประมาณ 2 cm' },
        tiltGain: { value: 1.0, unit: '°/°', kind: 'assumed', source: 'แนวคอ C7→C0 หมุนเท่ากับมุม MPU ที่เปลี่ยน (ยังไม่ได้ปรับเทียบ)' },
        estimateGain: { value: 0.5, unit: '°/°', kind: 'assumed', source: 'เมื่อไม่มี MPU: เดาว่าคอส่วนล่างงอครึ่งหนึ่งของมุมก้มหน้า (เฉพาะตอนก้ม)' },
        neutralCva: { value: NEUTRAL_CVA, unit: '°', kind: 'assumed', source: 'ค่าเฉลี่ยกลุ่มปกติ 52.05° (base_plan.md) ใช้เป็นท่าตั้งศูนย์' },
    });
    const G = {
        L: GEOMETRY.neckLength.value, tz: GEOMETRY.tragusForward.value, ty: GEOMETRY.tragusUp.value,
        gain: GEOMETRY.tiltGain.value, est: GEOMETRY.estimateGain.value,
    };

    /** Rotate (z, y) forward/down by deg (positive = lean forward or chin down). */
    function rot(deg, z, y) {
        const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
        return { z: z * c + y * s, y: y * c - z * s };
    }
    /**
     * Neck angle phi0 (deg from vertical) that makes the zero posture read neutralCva.
     * Solves L*cos(phi + N) = tz*sin N - ty*cos N, from atan2(L cos phi + ty, L sin phi + tz) = N.
     */
    function solvePhi0(neutral = NEUTRAL_CVA) {
        const n = neutral * DEG;
        const k = (G.tz * Math.sin(n) - G.ty * Math.cos(n)) / G.L;
        return Math.acos(Math.max(-1, Math.min(1, k))) / DEG - neutral;
    }
    const PHI0 = solvePhi0();

    /**
     * Every intermediate value of the CVA model, for the dev page and tests.
     * tilt = MPU change since zero (deg) or null when no MPU; pitch = head pitch since zero (deg).
     */
    function cvaParts(tilt, pitch) {
        const tiltEstimated = !isNum(tilt);
        // Without an MPU only flexion is guessed; looking up is not assumed to straighten the lower neck.
        const tiltUsed = tiltEstimated ? G.est * Math.max(0, pitch) : tilt;
        const phi = PHI0 + G.gain * tiltUsed;
        const c0 = rot(phi, 0, G.L);
        const head = rot(pitch, G.tz, G.ty);
        const t = { z: c0.z + head.z, y: c0.y + head.y };
        return {
            geometryId: GEOMETRY.id, phi0: PHI0, tilt: tiltUsed, tiltEstimated, pitch, phi, c0, head, t,
            distance: Math.hypot(t.z, t.y), cva: Math.atan2(t.y, t.z) / DEG,
        };
    }
    /** CVA in degrees (angle between the horizontal through C7 and the line C7 -> mid-tragus). */
    function cva(tilt, pitch) { return cvaParts(tilt, pitch).cva; }

    /* ---------- Legacy CVA (protocol v1 firmware, kept only to compare on the dev page) ---------- */
    function quatFromEulerDeg(pitchDeg, yawDeg, rollDeg) {
        const rx = pitchDeg * DEG * 0.5, ry = yawDeg * DEG * 0.5, rz = rollDeg * DEG * 0.5;
        const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
        const q = [cy * cx * cz + sy * sx * sz, cy * sx * cz + sy * cx * sz, sy * cx * cz - cy * sx * sz, cy * cx * sz - sy * sx * cz];
        const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
        return q.map((v) => v / len);
    }
    function rotate(q, v) {
        const [w, x, y, z] = q;
        const uv = [y * v[2] - z * v[1], z * v[0] - x * v[2], x * v[1] - y * v[0]];
        const uuv = [y * uv[2] - z * uv[1], z * uv[0] - x * uv[2], x * uv[1] - y * uv[0]];
        return [v[0] + 2 * (w * uv[0] + uuv[0]), v[1] + 2 * (w * uv[1] + uuv[1]), v[2] + 2 * (w * uv[2] + uuv[2])];
    }
    /** Old v1 model: counts head pitch three times and lets roll/yaw change CVA. Do not use for decisions. */
    function cvaLegacy(c7Deg, pitchDeg, rollDeg, yawDeg) {
        const neckTilt = 4.2 + c7Deg * 1.02 + Math.max(0, pitchDeg * 0.16);
        // Top of the neck chain (vertebra index 6: lordosis term sin(pi)*0.11 is ~0).
        const neck = rotate(quatFromEulerDeg(neckTilt, yawDeg * 0.35, rollDeg * 0.4), [0, 0.985, Math.sin(Math.PI) * 0.11]);
        const skull = quatFromEulerDeg(pitchDeg, yawDeg, rollDeg);
        const earL = rotate(skull, [0.52, 0.12, 0.2505]);
        const earR = rotate(skull, [-0.52, 0.12, 0.2505]);
        const dy = 0.04 + neck[1] + (earL[1] + earR[1]) / 2;
        const dz = 0.725 + neck[2] + (earL[2] + earR[2]) / 2;
        return Math.atan2(dy, Math.max(0.15, dz)) / DEG;
    }

    /* ---------- Posture classification ---------- */
    // Thresholds from the original "normal" cohort, which matches the firmware neutral (52.05).
    const SENSITIVITY = {
        strict: { label: 'เข้มงวด', good: 50, warn: 46 },
        normal: { label: 'ปกติ', good: 48, warn: 43.5 },
        relaxed: { label: 'ผ่อนคลาย', good: 46, warn: 42 },
    };
    function classify(cvaDeg, level) {
        const t = SENSITIVITY[level] || SENSITIVITY.normal;
        if (!Number.isFinite(cvaDeg)) return null;
        if (cvaDeg >= t.good) return 'good';
        if (cvaDeg >= t.warn) return 'warn';
        return 'bad';
    }

    /* ---------- Protocol v2 (and legacy v1) validation ---------- */
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    function inRange(v, [lo, hi]) { return v >= lo && v <= hi; }

    /**
     * Returns {ok:true, sample} or {ok:false, code, user, dev}.
     * user = short Thai text for end users; dev = detail for the developer page.
     * v2 sends mpu_tilt (MPU change since zero, null without MPU) separately from head_pitch.
     * v1 mixed 0.35*pitch into c7_angle; it is unmixed here and flagged legacy.
     */
    function validatePacket(p) {
        if (!p || typeof p !== 'object') return fail('NOT_OBJECT', 'ข้อมูลจากหูฟังอ่านไม่ได้', 'packet is not an object');
        const version = p.protocol_version;
        if (version !== 1 && version !== 2) {
            return fail('LEGACY_FIRMWARE', 'หูฟังใช้เฟิร์มแวร์รุ่นเก่า ต้องอัปเดตก่อนใช้งาน', `protocol_version=${version}`);
        }
        const legacy = version === 1;
        const s = p.sensors || {};
        const calOk = Number.isInteger(p.calibration_id) && p.calibration_id >= 1;
        const head = [p.head_pitch, p.head_roll, p.head_yaw];
        const tiltOk = legacy ? isNum(p.c7_angle) : (p.mpu_tilt === null || p.mpu_tilt === undefined || isNum(p.mpu_tilt));
        if (!(p.valid === true && p.calibrated === true && calOk) || !head.every(isNum) || !tiltOk) {
            if (!s.left_present && !s.right_present) {
                return fail('NO_EAR_SENSOR', 'ไม่พบเซ็นเซอร์ที่หู เสียบสายหูฟังให้แน่นแล้วรอสักครู่', `left_present=${!!s.left_present} right_present=${!!s.right_present} c7_present=${!!s.c7_present}`);
            }
            if (p.calibrated !== true) {
                return fail('WARMING_UP', 'กำลังเริ่มเซ็นเซอร์ นั่งนิ่ง ๆ สักครู่', `calibrated=${p.calibrated} L_fresh=${!!s.left_fresh} R_fresh=${!!s.right_fresh}`);
            }
            return fail('SENSOR_STALE', 'สัญญาณเซ็นเซอร์ขาดเป็นช่วง ๆ ตรวจสายหูฟัง', `valid=${p.valid} L_fresh=${!!s.left_fresh} R_fresh=${!!s.right_fresh} C7_fresh=${!!s.c7_fresh}`);
        }
        const [pitch, roll, yaw] = head;
        let tilt = null, c7 = null, legacyCva = null;
        if (legacy) {
            c7 = p.c7_angle;
            if (!inRange(c7, LIMITS.c7)) return outOfRange(`c7=${c7}`);
            // v1 firmware: c7_angle = -9 + dMPU + 0.35*pitch (MPU) or -9 + 0.65*pitch (no MPU).
            if (p.c7_estimated !== true) tilt = c7 + 9 - 0.35 * pitch;
            legacyCva = cvaLegacy(c7, pitch, roll, yaw);
        } else if (isNum(p.mpu_tilt) && p.tilt_estimated !== true) {
            tilt = p.mpu_tilt;
        }
        if ((tilt !== null && !inRange(tilt, LIMITS.tilt)) || !inRange(pitch, LIMITS.pitch) || !inRange(roll, LIMITS.roll) || !inRange(yaw, LIMITS.yaw)) {
            return outOfRange(`tilt=${tilt} pitch=${pitch} roll=${roll} yaw=${yaw}`);
        }
        if (!legacy && Number.isInteger(p.geometry_id) && p.geometry_id !== GEOMETRY.id) {
            return fail('GEOMETRY_MISMATCH', 'ค่าจากหูฟังไม่ตรงกับหน้าเว็บ ต้องอัปเดตเฟิร์มแวร์', `geometry_id fw=${p.geometry_id} web=${GEOMETRY.id}`);
        }
        const parts = cvaParts(tilt, pitch);
        // v1 firmware computed the old formula, so its parity is checked against cvaLegacy.
        const parityRef = legacy ? legacyCva : parts.cva;
        if (isNum(p.cva_angle) && Math.abs(p.cva_angle - parityRef) > PARITY_TOLERANCE) {
            return fail('CVA_PARITY', 'ค่าจากหูฟังไม่ตรงกับหน้าเว็บ ต้องอัปเดตเฟิร์มแวร์', `fw=${p.cva_angle} web=${parityRef.toFixed(3)}`);
        }
        return {
            ok: true,
            sample: {
                protocol: version, legacy,
                tilt: parts.tilt, tiltEstimated: parts.tiltEstimated, pitch, roll, yaw,
                cva: parts.cva, parts,
                fwCva: isNum(p.cva_angle) ? p.cva_angle : null,
                legacyCva, c7,
                mpuRaw: isNum(p.mpu_tilt_raw) ? p.mpu_tilt_raw : null,
                bootId: p.boot_id,
                calibrationId: p.calibration_id,
                sensors: s,
            },
        };
        function outOfRange(dev) { return fail('OUT_OF_RANGE', 'ค่ามุมผิดปกติ ลองตั้งท่าเริ่มต้นใหม่', dev); }
        function fail(code, user, dev) { return { ok: false, code, user, dev, sensors: (p && p.sensors) || {} }; }
    }

    /* ---------- Serial line parser (formats printed by esp32_c7_prototype.ino) ---------- */
    function parseLine(line) {
        const text = String(line).replace(/\r$/, '');
        const t = text.trim();
        if (!t) return null;
        if (t.startsWith('[ESP-LOG]')) return { type: 'log', text: t.slice(9).trim(), raw: text };
        if (t === 'I2C FULL_SCAN_BEGIN') return { type: 'i2c', kind: 'begin', raw: text };
        if (t === 'I2C FULL_SCAN_END') return { type: 'i2c', kind: 'end', raw: text };
        if (t.startsWith('I2C BUS_SUMMARY:')) return { type: 'i2c', kind: 'summary', text: t.slice(16).trim(), raw: text };
        // Collect mode (docs/DATA_COLLECTION.md): H = header with key=value pairs, D = one raw sample line.
        if (t.startsWith('H,')) return { type: 'collect-header', text: t, raw: text };
        if (/^D,\d/.test(t)) return { type: 'collect', text: t, raw: text };
        const ack = /^I2C (0x[0-9A-Fa-f]{2}): (ACK|NO_ACK)\b/.exec(t);
        if (ack) return { type: 'i2c', kind: 'ack', addr: ack[1].toUpperCase().replace('0X', '0x'), ack: ack[2] === 'ACK', raw: text };
        const a = t.indexOf('{'), b = t.lastIndexOf('}');
        if (a !== -1 && b > a) {
            try { return { type: 'json', data: JSON.parse(t.slice(a, b + 1)), raw: text }; } catch (e) { return { type: 'raw', text: t, raw: text, error: 'bad JSON' }; }
        }
        return { type: 'raw', text: t, raw: text };
    }

    /* ---------- Tiny event emitter ---------- */
    class Emitter {
        constructor() { this._h = {}; }
        on(type, fn) { (this._h[type] = this._h[type] || []).push(fn); return () => this.off(type, fn); }
        off(type, fn) { this._h[type] = (this._h[type] || []).filter((f) => f !== fn); }
        emit(type, detail) { (this._h[type] || []).slice().forEach((fn) => { try { fn(detail); } catch (e) { console.error(e); } }); }
    }

    /* ---------- Device session (Web Serial or simulator share one pipeline) ---------- */
    // states: idle | connecting | waiting | live | stale | error
    class Device extends Emitter {
        constructor(opts = {}) {
            super();
            this.now = opts.now || (() => Date.now());
            this.serial = opts.serial !== undefined ? opts.serial : (root.navigator && root.navigator.serial) || null;
            this.state = 'idle';
            this.message = '';
            this.port = null; this.reader = null; this.sim = null;
            this.gen = 0; this.timer = null;
            this.lastValidAt = 0; this.lastPacketAt = 0; this.lastCollectAt = 0;
            this.bootId = null; this.calibrationId = null;
            this.lastPacket = null; this.lastSample = null; this.lastInvalid = null;
            this.stats = { packets: 0, valid: 0, invalid: 0, lines: 0, collect: 0 };
            this.pendingZero = null; this.scan = null;
            this._onSerialDisconnect = (e) => {
                if (this.port && (e.target === this.port || e.port === this.port)) {
                    this._teardown();
                    this._set('error', 'ถอดสายหูฟังแล้ว เสียบกลับแล้วกดเชื่อมต่ออีกครั้ง');
                }
            };
            this.busy = false; this._loop = null; this._writes = null;
        }
        get supported() { return !!this.serial; }
        get connected() { return !!(this.port || this.sim); }
        get simulated() { return !!this.sim; }

        _set(state, message) {
            if (state === this.state && message === this.message) return;
            this.state = state; this.message = message || '';
            this.emit('status', { state, message: this.message });
        }

        /** Ask the user for a port (or reuse a granted one when auto=true). */
        async connect({ auto = false } = {}) {
            if (!this.serial) { this._set('error', 'เบราว์เซอร์นี้เชื่อมต่อ USB ไม่ได้ ใช้ Chrome หรือ Edge บนคอมพิวเตอร์'); return false; }
            if (this.busy) return false;
            let port = null;
            if (auto) {
                const ports = await this.serial.getPorts();
                port = ports.find((p) => (p.getInfo ? p.getInfo().usbVendorId : 0) === 0x10c4) || ports[0] || null;
                if (!port) return false;
            } else {
                try { port = await this.serial.requestPort(); } catch (e) { if (!this.connected) this._set('idle', ''); return false; }
            }
            if (this.busy) return false;
            this.busy = true;
            try { return await this._open(port); } finally { this.busy = false; }
        }

        async _open(port) {
            await this._teardown();
            const gen = ++this.gen;
            this._set('connecting', 'กำลังเชื่อมต่อหูฟัง');
            try {
                await port.open({ baudRate: BAUD });
            } catch (e) {
                if (gen === this.gen) {
                    this._set('error', 'เปิดพอร์ตไม่ได้ ปิดโปรแกรมอื่นที่ใช้พอร์ตนี้อยู่ (เช่น Serial Monitor) แล้วลองใหม่');
                    this.emit('line', { type: 'raw', text: `open failed: ${e.message}`, raw: '' });
                }
                return false;
            }
            if (gen !== this.gen) { await port.close().catch(() => {}); return false; } // disconnected while opening
            try { if (port.setSignals) await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch (e) { /* optional */ }
            this.port = port;
            if (this.serial.addEventListener) this.serial.addEventListener('disconnect', this._onSerialDisconnect);
            this._resetSession();
            this._set('waiting', 'เชื่อมต่อแล้ว กำลังรอข้อมูลจากเซ็นเซอร์');
            this._startTimer();
            this._loop = this._readLoop(gen);
            return true;
        }

        async _readLoop(gen) {
            const decoder = new TextDecoder('utf-8', { fatal: false });
            let buffer = '';
            while (gen === this.gen && this.port && this.port.readable) {
                let reader;
                try { reader = this.port.readable.getReader(); } catch (e) { break; }
                this.reader = reader;
                try {
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done || gen !== this.gen) break;
                        buffer += decoder.decode(value, { stream: true });
                        if (buffer.length > 8192 && buffer.indexOf('\n') === -1) buffer = '';
                        const parts = buffer.split(/\r?\n/);
                        buffer = parts.pop();
                        parts.forEach((l) => this.feed(l));
                    }
                } catch (e) {
                    if (gen === this.gen) this.emit('line', { type: 'raw', text: `read error: ${e.message}`, raw: '' });
                } finally {
                    try { reader.releaseLock(); } catch (e) { /* ignore */ }
                    if (this.reader === reader) this.reader = null;
                }
                if (gen !== this.gen) return;
                await new Promise((r) => setTimeout(r, 80));
            }
        }

        async disconnect({ silent = false } = {}) {
            const hadConnection = this.connected;
            await this._teardown();
            if (!silent && hadConnection) this._set('idle', 'ตัดการเชื่อมต่อแล้ว');
        }

        /** Stop everything; resolves after the reader lock is released and the port is closed. */
        async _teardown() {
            this.gen++;
            if (this.timer) { clearInterval(this.timer); this.timer = null; }
            if (this.sim) { this.sim.stop(); this.sim = null; }
            const reader = this.reader, port = this.port, loop = this._loop, writes = this._writes;
            this.reader = null; this.port = null; this._loop = null; this._writes = null;
            if (this.serial && this.serial.removeEventListener) this.serial.removeEventListener('disconnect', this._onSerialDisconnect);
            this._finishZero(false, 'DISCONNECTED');
            if (this.scan) {
                clearTimeout(this.scan.timer);
                const partial = this.scan; this.scan = null;
                this.emit('scan', { ok: false, code: 'DISCONNECTED', addresses: partial.addresses, summary: partial.summary });
            }
            if (reader) await reader.cancel().catch(() => {});
            if (loop) await loop.catch(() => {});
            if (writes) await writes.catch(() => {});
            if (port) await port.close().catch(() => {});
        }

        _resetSession() {
            this.lastValidAt = 0; this.lastPacketAt = 0; this.lastCollectAt = 0; this.bootId = null; this.calibrationId = null;
            this.lastPacket = null; this.lastSample = null; this.lastInvalid = null; this._waitSince = 0;
            this.stats = { packets: 0, valid: 0, invalid: 0, lines: 0, collect: 0 };
        }

        /** Latest time the board proved it is measuring: a valid v2 packet or a collect-mode D line. */
        get liveAt() { return Math.max(this.lastValidAt, this.lastCollectAt); }

        _startTimer() {
            if (this.timer) clearInterval(this.timer);
            this.timer = setInterval(() => this.tick(), 300);
        }

        /** Periodic freshness check; exposed for tests. */
        tick() {
            const now = this.now();
            if (this.pendingZero && now - this.pendingZero.started > ZERO_TIMEOUT_MS) this._finishZero(false, 'TIMEOUT');
            if (!this.connected) return;
            const lastSeen = Math.max(this.liveAt, this.lastPacketAt);
            if ((this.state === 'live' && now - this.liveAt > STALE_MS) || (this.state === 'waiting' && lastSeen && now - lastSeen > STALE_MS)) {
                this._set('stale', 'สัญญาณจากหูฟังขาดหาย ตรวจสาย USB');
            } else if (this.state === 'waiting' && !this.lastPacketAt && now - (this._waitSince || (this._waitSince = now)) > 4000) {
                this._set('waiting', 'ยังไม่ได้รับข้อมูล ลองกดปุ่ม EN บนบอร์ด หรือถอดเสียบสายใหม่');
            }
        }

        /** Push one serial line through the pipeline (serial reader, simulator and tests). */
        feed(line) {
            const msg = parseLine(line);
            if (!msg) return;
            this.stats.lines++;
            this.emit('line', msg);
            if (msg.type === 'json') this._packet(msg.data);
            else if (msg.type === 'i2c') this._i2c(msg);
            else if (msg.type === 'collect') this._collect(msg);
            else if (msg.type === 'collect-header') this.emit('collectHeader', msg);
        }

        /** Collect-mode line: keeps the session live; decoding is done by assets/c7-collect.js. */
        _collect(msg) {
            this.stats.collect++;
            this.lastCollectAt = this.now();
            if (this.state !== 'live') this._set('live', this.sim ? 'ข้อมูลจำลอง' : 'กำลังส่งค่าดิบ');
            this.emit('collect', msg);
        }

        _packet(p) {
            const now = this.now();
            this.stats.packets++;
            this.lastPacket = p; this.lastPacketAt = now;
            if (Number.isInteger(p.boot_id)) this.bootId = p.boot_id;
            if (Number.isInteger(p.calibration_id)) this.calibrationId = p.calibration_id;
            if (this.pendingZero && p.calibrated === true && Number.isInteger(p.calibration_id) && p.calibration_id >= 1) {
                const z = this.pendingZero;
                if (p.calibration_id !== z.calibrationId || (Number.isInteger(p.boot_id) && p.boot_id !== z.bootId)) this._finishZero(true);
            }
            const r = validatePacket(p);
            if (r.ok) {
                this.stats.valid++;
                this.lastValidAt = now; this.lastSample = r.sample; this.lastInvalid = null;
                this._set('live', this.sim ? 'ข้อมูลจำลอง' : 'กำลังวัด');
                this.emit('sample', r.sample);
            } else {
                this.stats.invalid++;
                this.lastInvalid = r;
                // A short flicker of invalid packets keeps the live state; only a sustained gap leaves it.
                if (!this.liveAt || now - this.liveAt > STALE_MS) this._set('waiting', r.user);
                this.emit('invalid', r);
            }
        }

        _i2c(msg) {
            if (msg.kind === 'begin') {
                if (this.scan) this.scan.addresses = [];
                else this.scan = { addresses: [], summary: '', timer: null, passive: true };
            } else if (msg.kind === 'ack' && this.scan && msg.ack && !this.scan.addresses.includes(msg.addr)) {
                this.scan.addresses.push(msg.addr);
            } else if (msg.kind === 'summary' && this.scan) {
                this.scan.summary = msg.text;
            } else if (msg.kind === 'end' && this.scan) {
                clearTimeout(this.scan.timer);
                const { addresses, summary } = this.scan;
                this.scan = null;
                this.emit('scan', { ok: true, addresses, summary });
            }
            this.emit('i2c', msg);
        }

        /** Writes are queued so two commands never compete for the writer lock. Resolves true/false. */
        send(text) {
            if (this.sim) { this.sim.command(text); return Promise.resolve(true); }
            const port = this.port;
            if (!port || !port.writable) return Promise.resolve(false);
            const run = async () => {
                if (port !== this.port || !port.writable) return false;
                const writer = port.writable.getWriter();
                try { await writer.write(new TextEncoder().encode(text)); return true; } catch (e) { return false; } finally { writer.releaseLock(); }
            };
            const next = (this._writes || Promise.resolve(true)).then(run, run);
            this._writes = next;
            return next;
        }

        /** Firmware-owned tare: send z and wait for calibration_id (or boot_id) to change. */
        zero() {
            if (!this.connected) return Promise.resolve({ ok: false, code: 'NOT_CONNECTED' });
            if (this.pendingZero) return this.pendingZero.promise;
            // Without a known calibration_id the first packet could look like an acknowledgement.
            if (!Number.isInteger(this.calibrationId)) return Promise.resolve({ ok: false, code: 'NO_DATA_YET' });
            let resolve;
            const promise = new Promise((r) => { resolve = r; });
            this.pendingZero = { started: this.now(), bootId: this.bootId, calibrationId: this.calibrationId, resolve, promise };
            this.emit('zero', { phase: 'sent' });
            this.send('z\n').then((ok) => { if (!ok) this._finishZero(false, 'WRITE_FAILED'); }, () => this._finishZero(false, 'WRITE_FAILED'));
            return promise;
        }

        _finishZero(ok, code) {
            const z = this.pendingZero;
            if (!z) return;
            this.pendingZero = null; // always cleared, so a lost ack never blocks later packets
            const result = ok ? { ok: true, calibrationId: this.calibrationId } : { ok: false, code };
            this.emit('zero', Object.assign({ phase: 'done' }, result));
            z.resolve(result);
        }

        scanBus() {
            if (!this.connected) return Promise.resolve({ ok: false, code: 'NOT_CONNECTED' });
            return new Promise((resolve) => {
                if (this.scan && this.scan.timer) clearTimeout(this.scan.timer);
                const timer = setTimeout(() => {
                    const partial = this.scan; this.scan = null;
                    const r = { ok: false, code: 'TIMEOUT', addresses: partial ? partial.addresses : [], summary: partial ? partial.summary : '' };
                    this.emit('scan', r); resolve(r);
                }, SCAN_TIMEOUT_MS);
                this.scan = { addresses: [], summary: '', timer };
                const off = this.on('scan', (r) => { off(); resolve(r); });
                this.send('s\n');
            });
        }

        checkAddresses() { return this.send('i\n'); }

        /** Run a labelled simulator through the same pipeline. */
        async startSimulation(sim) {
            await this._teardown();
            this.sim = sim;
            this._resetSession();
            this._set('waiting', 'ข้อมูลจำลอง');
            this._startTimer();
            sim.start((line) => this.feed(line));
        }
    }

    /* ---------- Simulator (always labelled as simulated by the pages) ---------- */
    class Simulator {
        constructor({ script = 'demo', now } = {}) {
            this.script = script; this.now = now || (() => Date.now());
            this.manual = { tilt: 0, pitch: 0, roll: 0, yaw: 0, mpu: true };
            this.bootId = 1000 + Math.floor(Math.random() * 9000);
            this.calibrationId = 1; this.offset = { tilt: 0, pitch: 0, roll: 0, yaw: 0 };
            this.timer = null; this.t0 = 0; this.out = null;
        }
        set(values) { Object.assign(this.manual, values); }
        start(out) {
            this.out = out; this.t0 = this.now();
            this.out('[ESP-LOG] simulator started (not a real device)');
            this.timer = setInterval(() => this.emitPacket(), 200);
        }
        stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
        /**
         * Scripted 72 s loop with an MPU at C7: upright, tilt right/left, turn left/right,
         * forward head (lower neck leans, head tips up to keep the eyes level), held, recover,
         * then looking down at a desk (mostly head pitch, a little lower neck), upright.
         */
        scripted(t) {
            const s = (t / 1000) % 72;
            const bell = (a, b) => (s > a && s < b ? Math.sin(((s - a) / (b - a)) * Math.PI) : 0);
            const fwd = s < 30 ? 0 : s < 40 ? (s - 30) / 10 : s < 52 ? 1 : s < 56 ? 1 - (s - 52) / 4 : 0;
            const down = bell(56, 67);
            const wobble = Math.sin(t / 1300) * 1.2;
            return {
                tilt: fwd * 15 + down * 5 + wobble * 0.4,
                pitch: -fwd * 6 + down * 26 + wobble,
                roll: 18 * bell(6, 11) - 18 * bell(12, 17) + Math.sin(t / 2700) * 1.5,
                yaw: 28 * bell(18, 23) - 28 * bell(24, 29) + Math.sin(t / 4100) * 2,
                mpu: true,
            };
        }
        current() {
            const raw = this.script === 'demo' ? this.scripted(this.now() - this.t0) : this.manual;
            const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
            return {
                tilt: clamp(raw.tilt - this.offset.tilt, LIMITS.tilt),
                pitch: clamp(raw.pitch - this.offset.pitch, LIMITS.pitch),
                roll: clamp(raw.roll - this.offset.roll, LIMITS.roll),
                yaw: clamp(raw.yaw - this.offset.yaw, LIMITS.yaw),
                mpu: raw.mpu !== false,
            };
        }
        emitPacket() {
            const a = this.current();
            const r2 = (v) => Math.round(v * 100) / 100;
            const tilt = a.mpu ? r2(a.tilt) : null, pitch = r2(a.pitch), roll = r2(a.roll), yaw = r2(a.yaw);
            const raw = this.script === 'demo' ? this.scripted(this.now() - this.t0) : this.manual;
            const packet = {
                protocol_version: PROTOCOL_VERSION, geometry_id: GEOMETRY.id, boot_id: this.bootId, calibration_id: this.calibrationId,
                calibrated: true, valid: true, tilt_estimated: !a.mpu,
                sensors: { left_present: true, right_present: true, c7_present: a.mpu, left_fresh: true, right_fresh: true, c7_fresh: a.mpu },
                mpu_tilt: tilt, mpu_tilt_raw: a.mpu ? r2(raw.tilt) : null,
                head_pitch: pitch, head_roll: roll, head_yaw: yaw, cva_angle: r2(cva(tilt, pitch)),
            };
            this.out(JSON.stringify(packet));
        }
        command(text) {
            const c = String(text).trim().charAt(0).toLowerCase();
            if (c === 'z' || c === 'c') {
                // Mirror the firmware: the current posture becomes the neutral reference.
                const raw = this.script === 'demo' ? this.scripted(this.now() - this.t0) : this.manual;
                this.offset = { tilt: raw.tilt, pitch: raw.pitch, roll: raw.roll, yaw: raw.yaw };
                this.calibrationId++;
                this.out(`[ESP-LOG] Calibrated zero posture! calibration_id=#${this.calibrationId}`);
            } else if (c === 'i') {
                ['0x4B: ACK', '0x4A: ACK', '0x68: ACK'].forEach((l) => this.out(`I2C ${l}`));
            } else if (c === 's') {
                ['I2C FULL_SCAN_BEGIN', 'I2C 0x4A: ACK', 'I2C 0x4B: ACK', 'I2C 0x68: ACK', 'I2C BUS_SUMMARY: Wire(21/22)=[0x4A,0x4B,0x68] Wire1(18/19)=[OFF]', 'I2C FULL_SCAN_END'].forEach((l) => this.out(l));
            }
        }
    }

    root.C7 = {
        cva, cvaParts, cvaLegacy, solvePhi0, classify, validatePacket, parseLine, Device, Simulator, Emitter,
        GEOMETRY, PHI0, SENSITIVITY, LIMITS, NEUTRAL_CVA, PROTOCOL_VERSION, STALE_MS, ZERO_TIMEOUT_MS, BAUD,
    };
})(typeof window !== 'undefined' ? window : globalThis);
