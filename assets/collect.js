/* Data collection page: raw 50 Hz stream of both ears + C7, live charts, guided postures, CSV download. */
(function () {
    'use strict';
    const C7 = window.C7, K = C7.Collect;
    const $ = (id) => document.getElementById(id);
    const demo = new URLSearchParams(location.search).has('demo');
    const device = new C7.Device();
    const CHIP = { idle: 'ยังไม่เชื่อมต่อ', connecting: 'กำลังเชื่อมต่อ', waiting: 'รอข้อมูล', live: 'รับข้อมูลอยู่', stale: 'สัญญาณขาด', error: 'ผิดพลาด' };
    const WINDOW_MS = 10000;
    const STORE = 'c7.collect.';

    /* ---------- small storage helpers (per-viewer conveniences only) ---------- */
    const load = (k, d) => { try { const v = localStorage.getItem(STORE + k); return v === null ? d : v; } catch (e) { return d; } };
    const save = (k, v) => { try { localStorage.setItem(STORE + k, v); } catch (e) { /* private mode */ } };

    /* ---------- state ---------- */
    const st = {
        header: null, lastSeq: null, lost: 0, bad: 0, lines: 0,
        tare: null, needTare: true, cz: new K.Integrator(), last: null, lr: null,
        htare: null, needHeadTare: true, head: null, // zero posture + head angles computed like the firmware
        // per-second counters of new values per sensor (from the flags "updated" bits)
        win: { L: 0, R: 0, C: 0, lines: 0 }, rate: { L: 0, R: 0, C: 0, lines: 0 }, seen: { L: 0, R: 0, C: 0 },
        rec: { on: false, rows: [], t0: 0, lostAt0: 0, downloaded: true, startedIso: '', endedIso: '', boot: null, cal: null },
        label: 'free', step: null, ref: null, refs: [], stepLog: [],
        run: null, // {steps, i, start}
    };
    const series = { L: [], R: [], C: [], LR: [] }; // {t, euler[3], acc[3], gyro[3]} / {t, v}

    /* ---------- log ---------- */
    const logEl = $('log');
    function log(text, tone) {
        const li = document.createElement('li');
        if (tone) li.dataset.tone = tone;
        li.innerHTML = '<time></time><span></span>';
        li.children[0].textContent = new Date().toLocaleTimeString('en-GB');
        li.children[1].textContent = text;
        logEl.appendChild(li);
        while (logEl.children.length > 80) logEl.firstChild.remove();
        logEl.scrollTop = logEl.scrollHeight;
    }

    /* ---------- device events ---------- */
    device.on('status', ({ state, message }) => {
        const chip = $('conn');
        chip.dataset.state = state;
        chip.classList.toggle('sim', device.simulated);
        chip.textContent = (device.simulated ? 'ข้อมูลจำลอง: ' : '') + (CHIP[state] || state);
        chip.title = message || '';
        if (state === 'error' || state === 'stale') log(message || state, 'bad');
    });
    device.on('line', (m) => {
        if (m.type === 'log') log(m.text, /RATE/.test(m.text) ? '' : /error|fail|stale|disconnect|NO_ACK/i.test(m.text) ? 'warn' : '');
        else if (m.type === 'raw' && m.text && !/^[\x00-\x1f�]+$/.test(m.text)) log(m.text.slice(0, 160), 'warn');
    });
    device.on('collectHeader', (m) => {
        const h = K.parseHeader(m.text);
        if (!h) return;
        const first = !st.header;
        st.header = h;
        if (h.format !== K.FORMAT) log(`เฟิร์มแวร์ส่งรูปแบบ ${h.format} แต่หน้านี้อ่านรูปแบบ ${K.FORMAT} ต้องอัปเดตให้ตรงกัน`, 'bad');
        else if (first) log(`เริ่มรับค่าดิบ ${h.rate_hz} Hz (I2C ${h.i2c_hz} Hz)`);
    });
    device.on('collect', (m) => onLine(m.text));

    function onLine(text) {
        const s = K.parseData(text);
        if (!s) { st.bad++; return; }
        const now = performance.now();
        st.lines++; st.win.lines++;
        st.lost += K.seqGap(st.lastSeq, s.seq);
        st.lastSeq = s.seq;
        for (const k of ['L', 'R', 'C']) {
            if (s[k]) { st.seen[k] = now; if (s[k].updated) st.win[k]++; }
        }
        if (s.L && s.R && st.needTare) { st.tare = { L: s.L.q, R: s.R.q }; st.needTare = false; }
        st.lr = K.lrDeg(s.L && s.L.q, s.R && s.R.q, st.tare);
        if ((s.L || s.R) && (st.needHeadTare || (s.L && st.htare && !st.htare.L) || (s.R && st.htare && !st.htare.R))) {
            st.htare = K.headTare(s); st.needHeadTare = false;
        }
        st.head = K.firmwareHead(s, st.htare);
        const cz = s.C ? st.cz.add(s.tDev, s.C.gyro[2]) : null;
        st.last = s;

        const t = s.tDev;
        for (const k of ['L', 'R']) if (s[k]) series[k].push({ t, euler: s[k].euler, acc: s[k].acc, gyro: s[k].gyro });
        if (s.C) series.C.push({ t, euler: [s.C.tilt[0], s.C.tilt[1], null], acc: s.C.acc, gyro: s.C.gyro });
        if (st.lr !== null) series.LR.push({ t, v: st.lr });
        for (const k in series) { const a = series[k]; while (a.length && a[0].t < t - WINDOW_MS) a.shift(); if (a.length && a[a.length - 1].t < t - WINDOW_MS) a.length = 0; }

        if (st.rec.on) {
            st.rec.rows.push(K.rowFromSample(s, { tHost: now - st.rec.t0, label: st.label, step: st.step, ref: st.ref, lr: st.lr, cz, simulated: device.simulated }));
        }
    }

    setInterval(() => {
        st.rate = Object.assign({}, st.win);
        st.win = { L: 0, R: 0, C: 0, lines: 0 };
    }, 1000);

    /* ---------- toolbar ---------- */
    $('connect').addEventListener('click', async () => {
        if (demo) return startDemo();
        const ok = await device.connect();
        if (ok) log('เชื่อมต่อแล้ว กด "เริ่มส่งค่าดิบ" ให้บอร์ดส่งค่า 50 Hz');
    });
    $('disconnect').addEventListener('click', async () => {
        if (st.rec.on) stopRecording();
        stopRun();
        await device.disconnect();
    });
    $('streamOn').addEventListener('click', () => streamOn());
    $('streamOff').addEventListener('click', () => { if (device.connected) device.send('n\n'); });
    $('zero').addEventListener('click', async () => {
        st.needTare = true; st.needHeadTare = true; st.cz.reset();
        if (!device.connected) return;
        const r = await device.zero();
        log(r.ok ? `ตั้งท่าเริ่มต้นแล้ว (calibration_id ${r.calibrationId})` : `ตั้งท่าเริ่มต้นไม่สำเร็จ (${r.code})`, r.ok ? '' : 'warn');
    });
    function streamOn() {
        if (!device.connected) { log('ยังไม่ได้เชื่อมต่อ', 'warn'); return false; }
        st.lastSeq = null; st.needTare = true; st.needHeadTare = true;
        device.send('r\n');
        return true;
    }
    async function startDemo() {
        await device.startSimulation(new K.CollectSimulator());
        streamOn();
    }

    /* ---------- recording ---------- */
    $('record').addEventListener('click', () => (st.rec.on ? stopRecording() : startRecording()));
    function startRecording() {
        if (!device.connected) { log('เชื่อมต่อก่อนเริ่มบันทึก', 'warn'); return false; }
        if (st.rec.rows.length && !st.rec.downloaded && !confirm('ข้อมูลรอบก่อนยังไม่ได้ดาวน์โหลด เริ่มใหม่จะลบทิ้ง ต้องการเริ่มใหม่หรือไม่')) return false;
        if (Date.now() - device.lastCollectAt > 1000) streamOn(); // board still in v2 mode: start the raw stream
        Object.assign(st.rec, { on: true, rows: [], t0: performance.now(), lostAt0: st.lost, downloaded: false, startedIso: new Date().toISOString(), endedIso: '', boot: device.bootId, cal: device.calibrationId });
        st.refs = []; st.stepLog = []; st.cz.reset();
        setLabel(st.label, st.step);
        log('เริ่มบันทึก');
        renderRecButtons();
        return true;
    }
    function stopRecording() {
        if (!st.rec.on) return;
        st.rec.on = false; st.rec.endedIso = new Date().toISOString();
        closeStepLog();
        log(`หยุดบันทึก ${st.rec.rows.length} แถว`);
        renderRecButtons();
    }
    function renderRecButtons() {
        const b = $('record');
        b.setAttribute('aria-pressed', String(st.rec.on));
        b.textContent = st.rec.on ? 'หยุดบันทึก' : 'เริ่มบันทึก';
        const has = st.rec.rows.length > 0;
        $('dlCsv').disabled = !has; $('dlJson').disabled = !has;
        document.querySelector('.now-label').dataset.rec = st.rec.on ? 'on' : 'off';
    }

    /* ---------- labels, steps and reference angle ---------- */
    function setLabel(label, step) {
        if (st.rec.on && (label !== st.label || step !== st.step)) closeStepLog();
        st.label = label; st.step = step; st.ref = null;
        $('refNow').textContent = '';
        if (st.rec.on) st.stepLog.push({ step, label, start_ms: Math.round(performance.now() - st.rec.t0), end_ms: null });
        $('curLabel').textContent = label;
        $('curLabelTh').textContent = K.LABELS[label] || '';
        renderLabelButtons(); renderSteps();
    }
    function closeStepLog() {
        const last = st.stepLog[st.stepLog.length - 1];
        if (last && last.end_ms === null) last.end_ms = Math.round(performance.now() - st.rec.t0);
    }
    $('refApply').addEventListener('click', () => {
        const v = Number(String($('refAngle').value).replace(',', '.'));
        if (!$('refAngle').value.trim() || !Number.isFinite(v) || v < 0 || v > 90) { $('refNow').textContent = 'ใส่ตัวเลข 0–90'; return; }
        st.ref = v;
        $('refNow').textContent = `ใช้ ${v}° กับ ${st.label}`;
        if (st.rec.on) st.refs.push({ t_ms: Math.round(performance.now() - st.rec.t0), label: st.label, step: st.step, ref_angle_deg: v });
    });

    function protocolSteps() {
        const { steps, errors } = K.parseProtocol($('protocol').value);
        $('protocolErr').textContent = errors.length ? `อ่านบรรทัด ${errors.join(', ')} ไม่ได้ (ข้ามไป)` : '';
        const trans = Math.max(0, Math.min(30, Number($('transSec').value) || 0));
        return K.withTransitions(steps, trans);
    }
    function renderSteps() {
        const list = $('stepList');
        const steps = st.run ? st.run.steps : protocolSteps();
        list.textContent = '';
        steps.forEach((s, i) => {
            const li = document.createElement('li');
            if (s.auto) li.dataset.auto = '';
            if (st.run) li.dataset.state = i < st.run.i ? 'done' : i === st.run.i ? 'now' : '';
            li.innerHTML = '<span></span><span class="sec"></span>';
            li.children[0].textContent = s.auto ? K.LABELS.transition : `${s.label}  ${K.LABELS[s.label] ? '· ' + K.LABELS[s.label] : ''}`;
            li.children[1].textContent = `${s.seconds} วิ`;
            list.appendChild(li);
        });
        const now = list.querySelector('[data-state="now"]');
        if (now) now.scrollIntoView({ block: 'nearest' });
    }
    function manualLabels() {
        const seen = new Set();
        K.parseProtocol($('protocol').value).steps.forEach((s) => seen.add(s.label));
        seen.add('free'); seen.add('transition');
        return [...seen];
    }
    function renderLabelButtons() {
        const box = $('labelButtons');
        box.textContent = '';
        manualLabels().forEach((label, i) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'btn btn-sm';
            b.setAttribute('aria-pressed', String(st.label === label && st.step === null));
            b.title = K.LABELS[label] || label;
            b.innerHTML = i < 9 ? '<kbd></kbd><span></span>' : '<span></span>';
            if (i < 9) b.firstChild.textContent = String(i + 1);
            b.lastChild.textContent = label;
            b.addEventListener('click', () => { stopRun(); setLabel(label, null); });
            box.appendChild(b);
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
        const n = Number(e.key);
        if (n >= 1 && n <= 9) {
            const label = manualLabels()[n - 1];
            if (label) { stopRun(); setLabel(label, null); e.preventDefault(); }
        }
    });

    /* ---------- guided protocol ---------- */
    let audio = null;
    function beep(freq, ms) {
        if (!$('beep').checked) return;
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            const o = audio.createOscillator(), g = audio.createGain();
            o.frequency.value = freq; g.gain.value = 0.08;
            o.connect(g); g.connect(audio.destination);
            o.start(); o.stop(audio.currentTime + ms / 1000);
        } catch (e) { /* no audio */ }
    }
    $('runStart').addEventListener('click', () => {
        const steps = protocolSteps();
        if (!steps.length) { $('protocolErr').textContent = 'ยังไม่มีท่าในรายการ'; return; }
        if (!st.rec.on && !startRecording()) return;
        st.run = { steps, i: -1, start: 0, lastTick: -1 };
        nextStep();
    });
    $('runSkip').addEventListener('click', () => { if (st.run) nextStep(); });
    $('runStop').addEventListener('click', () => { stopRun(); setLabel('free', null); });
    function nextStep() {
        const r = st.run;
        r.i++;
        if (r.i >= r.steps.length) { stopRun(); setLabel('free', null); beep(660, 150); setTimeout(() => beep(880, 300), 200); log('ครบทุกท่าแล้ว'); return; }
        r.start = performance.now(); r.lastTick = -1;
        const s = r.steps[r.i];
        setLabel(s.label, r.i);
        if (!s.auto) beep(880, 250);
        renderRun();
    }
    function stopRun() {
        if (!st.run) return;
        st.run = null;
        renderRun(); renderSteps();
    }
    function renderRun() {
        const on = !!st.run;
        $('runSkip').disabled = !on; $('runStop').disabled = !on; $('runStart').disabled = on;
        $('countdown').hidden = !on;
        if (!on) $('nextLabel').textContent = '';
    }
    setInterval(() => {
        const r = st.run;
        if (!r) return;
        const s = r.steps[r.i];
        const left = s.seconds - (performance.now() - r.start) / 1000;
        if (left <= 0) { nextStep(); return; }
        const sec = Math.ceil(left);
        $('countdown').textContent = `${sec} วิ`;
        const next = r.steps[r.i + 1];
        $('nextLabel').textContent = next ? `ถัดไป: ${next.auto ? K.LABELS.transition : (K.LABELS[next.label] || next.label)}` : 'ท่าสุดท้าย';
        // count-in during the transition before a posture
        if (s.auto && sec <= 3 && sec !== r.lastTick) { r.lastTick = sec; beep(520, 80); }
    }, 100);

    /* ---------- protocol editor ---------- */
    $('protocol').value = load('protocol', K.DEFAULT_PROTOCOL);
    $('transSec').value = load('transSec', '3');
    const onProtoChange = () => { save('protocol', $('protocol').value); save('transSec', $('transSec').value); if (!st.run) { renderSteps(); renderLabelButtons(); } };
    $('protocol').addEventListener('input', onProtoChange);
    $('transSec').addEventListener('input', onProtoChange);
    $('protoReset').addEventListener('click', () => { $('protocol').value = K.DEFAULT_PROTOCOL; onProtoChange(); });
    $('protoShuffle').addEventListener('click', () => {
        const { steps } = K.parseProtocol($('protocol').value);
        $('protocol').value = K.shuffleMiddle(steps).map((s) => `${s.label},${s.seconds}`).join('\n');
        onProtoChange();
    });

    /* ---------- session metadata ---------- */
    ['mSubject', 'mSession', 'mPlacement', 'mNotes'].forEach((id) => {
        $(id).value = load(id, $(id).value);
        $(id).addEventListener('input', () => save(id, $(id).value));
    });

    /* ---------- download ---------- */
    function baseName() {
        const subject = ($('mSubject').value.trim() || 'P00').replace(/[^A-Za-z0-9_-]/g, '');
        const session = ($('mSession').value.trim() || '1').replace(/[^A-Za-z0-9_-]/g, '');
        const d = st.rec.startedIso ? new Date(st.rec.startedIso) : new Date();
        const p = (n) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
        return `${device.simulated ? 'SIM_' : ''}${subject || 'P00'}_s${session || '1'}_${stamp}`;
    }
    function download(name, parts, type) {
        const url = URL.createObjectURL(new Blob(parts, { type }));
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
    function metadata() {
        const rows = st.rec.rows;
        return {
            note: 'ข้อมูลเพื่อพัฒนาแบบจำลอง ไม่ใช่การวินิจฉัยทางการแพทย์',
            simulated: device.simulated,
            collect_format: K.FORMAT,
            started: st.rec.startedIso, ended: st.rec.endedIso || null,
            subject: $('mSubject').value.trim(), session: $('mSession').value.trim(),
            placement: $('mPlacement').value.trim(), notes: $('mNotes').value.trim(),
            firmware_header: st.header,
            boot_id: st.rec.boot, calibration_id_at_start: st.rec.cal, calibration_id_now: device.calibrationId,
            rows: rows.length,
            duration_s: rows.length ? Math.round(rows[rows.length - 1][0]) / 1000 : 0,
            lost_lines: st.lost - st.rec.lostAt0,
            protocol: protocolSteps(), steps: st.stepLog, reference_angles: st.refs,
            columns: K.COLUMNS,
            units: {
                t_host_ms: 'ms since recording start (browser clock)', t_dev_ms: 'ms (ESP32 millis)',
                q: 'unit quaternion w,x,y,z (BNO085 report 0x28)', acc: 'm/s² (BNO085 0x01 / MPU6050 ±2 g)', gyro: '°/s (BNO085 0x02 / MPU6050 ±250 °/s)',
                ex_ey_ez: '° Euler in the chip axes (quaternionToEulerDeg), not head pitch/roll/yaw',
                C_ex_C_ey: '° tilt from MPU accel: atan2(ay,az), atan2(ax,az)', C_ez_gyro: '° integrated MPU z gyro since recording start (drifts)',
                lr_deg: '° rotation difference between ears since tare', acc_status: 'BNO085 rotation vector accuracy 0-3',
                flags: 'bit0-2 L/R/C7 fresh, bit3-5 L/R/C7 new value since previous line',
            },
        };
    }
    $('dlCsv').addEventListener('click', () => {
        download(`${baseName()}.csv`, K.csvChunks(st.rec.rows), 'text/csv;charset=utf-8');
        if (!st.rec.on) st.rec.downloaded = true;
    });
    $('dlJson').addEventListener('click', () => download(`${baseName()}.json`, [JSON.stringify(metadata(), null, 2)], 'application/json'));
    window.addEventListener('beforeunload', (e) => {
        if (st.rec.rows.length && (!st.rec.downloaded || st.rec.on)) { e.preventDefault(); e.returnValue = ''; }
    });

    /* ---------- 3D model beside the charts: posture from the same head angles the firmware would send ---------- */
    let model = null;
    if (location.protocol !== 'file:') {
        import(new URL('assets/neck-model.js', document.baseURI).href)
            .then((m) => m.createNeckModel($('cModel'), {
                modelUrl: new URL('assets/models/head/LeePerrySmith.glb', document.baseURI).href,
                normalUrl: new URL('assets/models/head/Infinite-Level_02_Tangent_SmoothUV.jpg', document.baseURI).href,
            }))
            .then((m) => { model = m; model.setMirror(true); model.setView('front'); model.setLive(false); })
            .catch((e) => { console.error(e); $('mSource').textContent = 'แสดงโมเดลไม่ได้'; });
    }
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (model) model.refreshTheme(); });

    function renderModel(now) {
        const h = st.head;
        const fresh = !!h && now - Math.max(st.seen.L, st.seen.R) < 1500;
        const chip = $('mSource');
        chip.classList.toggle('sim', device.simulated);
        chip.dataset.state = fresh ? 'live' : 'idle';
        chip.textContent = !fresh ? 'ยังไม่มีค่า' : device.simulated ? 'ข้อมูลจำลอง' : 'จากเซ็นเซอร์';
        if (!model) return;
        model.setLive(fresh);
        model.setSensors({ left_fresh: fresh && !!h.dL, right_fresh: fresh && !!h.dR });
        model.setPose(fresh ? { tilt: h.tilt === null ? 0 : h.tilt, pitch: h.pitch, roll: h.roll, yaw: h.yaw } : { tilt: 0, pitch: 0, roll: 0, yaw: 0 });
    }

    /* ---------- charts ---------- */
    let colors = null;
    function readColors() {
        const cs = getComputedStyle(document.documentElement);
        const v = (n) => cs.getPropertyValue(n).trim();
        colors = { x: v('--sx'), y: v('--sy'), z: v('--sz'), line: v('--line'), ink2: v('--ink-2'), warn: v('--warn') };
    }
    readColors();
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);

    function drawChart(canvas, pts, pick, n) {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        if (!pts.length) return;
        let lo = Infinity, hi = -Infinity;
        for (const p of pts) for (let i = 0; i < n; i++) { const v = pick(p, i); if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
        if (!Number.isFinite(lo)) return;
        if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
        const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
        const tEnd = pts[pts.length - 1].t, tStart = tEnd - WINDOW_MS;
        const X = (t) => ((t - tStart) / WINDOW_MS) * w, Y = (v) => h - 4 - ((v - lo) / (hi - lo)) * (h - 8);
        if (lo < 0 && hi > 0) { g.strokeStyle = colors.line; g.lineWidth = 1; g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(w, Y(0)); g.stroke(); }
        const cols = n === 1 ? [colors.warn] : [colors.x, colors.y, colors.z];
        for (let i = 0; i < n; i++) {
            g.strokeStyle = cols[i]; g.lineWidth = 1.5; g.beginPath();
            let pen = false, prevT = null;
            for (const p of pts) {
                const v = pick(p, i);
                if (!Number.isFinite(v) || (prevT !== null && p.t - prevT > 200)) { pen = false; prevT = p.t; if (!Number.isFinite(v)) continue; }
                if (pen) g.lineTo(X(p.t), Y(v)); else { g.moveTo(X(p.t), Y(v)); pen = true; }
                prevT = p.t;
            }
            g.stroke();
        }
        g.fillStyle = colors.ink2; g.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
        g.fillText((hi - pad).toFixed(1), 4, 11); g.fillText((lo + pad).toFixed(1), 4, h - 4);
    }
    const canvases = [...document.querySelectorAll('.chart-group canvas')].map((c) => ({ c, s: c.closest('.chart-group').dataset.s, k: c.dataset.k }));
    function drawAll() {
        for (const { c, s, k } of canvases) {
            if (k === 'lr') drawChart(c, series.LR, (p) => p.v, 1);
            else drawChart(c, series[s], (p, i) => p[k][i], 3);
        }
    }

    /* ---------- render loop ---------- */
    const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
    const vec = (a, d) => (a ? a.map((v) => f(v, d)).join('  ') : '–');
    function render() {
        const now = performance.now();
        const s = st.last;
        const age = (k) => (st.seen[k] ? now - st.seen[k] : Infinity);
        const card = (id, k, extra) => {
            const el = $(id), a = age(k);
            const state = !device.connected || a > 1500 ? 'absent' : st.rate[k] < 5 ? 'stale' : 'fresh';
            el.dataset.s = state;
            el.querySelector('em').textContent = state === 'fresh' ? 'ส่งค่าอยู่' : state === 'stale' ? 'ค่าไม่ขยับ' : 'ไม่มีค่า';
            $(id + 'info').textContent = state === 'absent' ? '–' : `${st.rate[k]} Hz${extra ? ' · ' + extra : ''}`;
        };
        card('sL', 'L', s && s.L ? `ความแม่นยำ ${s.L.accuracy}` : '');
        card('sR', 'R', s && s.R ? `ความแม่นยำ ${s.R.accuracy}` : '');
        card('sC', 'C', '');
        $('kRate').textContent = `${st.rate.lines} / ${K.RATE_HZ}`;
        $('kLost').textContent = st.lines ? `${st.lost} (${(100 * st.lost / (st.lines + st.lost)).toFixed(2)}%)` : '–';
        $('kBad').textContent = String(st.bad);
        $('kLr').textContent = st.lr === null ? '–' : `${st.lr.toFixed(1)}°`;
        $('kHeader').textContent = st.header ? `${st.header.format} / ${st.header.i2c_hz} Hz` : '–';
        $('kBoot').textContent = `${device.bootId ?? '–'} / ${device.calibrationId ?? '–'}`;

        // quality hint before recording
        const q = $('quality');
        const lostPct = st.lines ? 100 * st.lost / (st.lines + st.lost) : 0;
        let msg = '', tone = '';
        if (!device.connected) { msg = 'ยังไม่ได้เชื่อมต่อ'; tone = ''; }
        else if (!st.header && !st.lines) { msg = 'ยังไม่ได้รับค่าดิบ กด "เริ่มส่งค่าดิบ"'; tone = 'warn'; }
        else if (st.rate.lines < K.RATE_HZ * 0.9) { msg = `ได้แค่ ${st.rate.lines} บรรทัดต่อวินาที (ควรได้ ${K.RATE_HZ})`; tone = 'warn'; }
        else if (s && ((s.L && s.L.accuracy < 2) || (s.R && s.R.accuracy < 2))) { msg = 'ความแม่นยำของ BNO ต่ำกว่า 2 หมุนศีรษะเป็นเลข 8 สักครู่'; tone = 'warn'; }
        else if (st.lr !== null && st.lr > 10) { msg = `สองหูหมุนต่างกัน ${st.lr.toFixed(1)}° หูฟังอาจหลวม ตรวจแล้วกดตั้งท่าเริ่มต้นใหม่`; tone = 'bad'; }
        else if (lostPct > 1) { msg = `บรรทัดหาย ${lostPct.toFixed(1)}% ตรวจสาย USB`; tone = 'warn'; }
        else { msg = 'สัญญาณพร้อมบันทึก'; tone = 'ok'; }
        q.textContent = msg; q.dataset.tone = tone;

        // latest values
        $('vLe').textContent = s && s.L ? vec(s.L.euler, 1) : '–';
        $('vRe').textContent = s && s.R ? vec(s.R.euler, 1) : '–';
        $('vCe').textContent = s && s.C ? `${f(s.C.tilt[0], 1)}  ${f(s.C.tilt[1], 1)}  –` : '–';
        $('vLq').textContent = s && s.L ? vec(s.L.q, 3) : '–';
        $('vRq').textContent = s && s.R ? vec(s.R.q, 3) : '–';
        $('vLa').textContent = s && s.L ? vec(s.L.acc, 2) : '–';
        $('vRa').textContent = s && s.R ? vec(s.R.acc, 2) : '–';
        $('vCa').textContent = s && s.C ? vec(s.C.acc, 2) : '–';
        $('vLg').textContent = s && s.L ? vec(s.L.gyro, 1) : '–';
        $('vRg').textContent = s && s.R ? vec(s.R.gyro, 1) : '–';
        $('vCg').textContent = s && s.C ? vec(s.C.gyro, 1) : '–';

        // recording panel
        const rows = st.rec.rows.length;
        $('rStatus').textContent = st.rec.on ? 'กำลังบันทึก' : rows ? (st.rec.downloaded ? 'หยุดแล้ว ดาวน์โหลดแล้ว' : 'หยุดแล้ว ยังไม่ได้ดาวน์โหลด') : 'ยังไม่ได้บันทึก';
        $('rRows').textContent = rows.toLocaleString('en-US');
        const secs = rows ? Math.floor(st.rec.rows[rows - 1][0] / 1000) : 0;
        $('rTime').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        $('rLost').textContent = String(st.rec.on || rows ? st.lost - st.rec.lostAt0 : 0);
        $('rSize').textContent = rows ? `${(rows * 300 / 1048576).toFixed(1)} MB` : '–';

        drawAll();
        renderModel(now);
    }
    setInterval(render, 100);

    /* ---------- start ---------- */
    renderSteps(); renderLabelButtons(); renderRecButtons(); renderRun();
    if (demo) {
        $('simBanner').hidden = false;
        $('connect').textContent = 'เริ่มข้อมูลจำลอง';
        startDemo();
    } else if (!device.supported) {
        log('เบราว์เซอร์นี้เชื่อมต่อ USB ไม่ได้ ใช้ Chrome หรือ Edge บนคอมพิวเตอร์ หรือเปิด ?demo เพื่อดูข้อมูลจำลอง', 'warn');
    } else {
        device.connect({ auto: true }).then((ok) => { if (ok) log('เชื่อมต่อพอร์ตเดิมแล้ว กด "เริ่มส่งค่าดิบ"'); });
    }
})();
