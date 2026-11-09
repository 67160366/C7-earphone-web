/* Developer page: board state, sensors, formula breakdown, raw log, commands, API save, CSV and simulator. */
(function () {
    'use strict';
    const C7 = window.C7;
    const $ = (id) => document.getElementById(id);
    const device = new C7.Device();
    const LOG_MAX = 300;
    const CHIP = { idle: 'ยังไม่เชื่อมต่อ', connecting: 'กำลังเชื่อมต่อ', waiting: 'รอข้อมูลที่ใช้ได้', live: 'รับข้อมูลอยู่', stale: 'สัญญาณขาด', error: 'ผิดพลาด' };
    let filter = 'all', sim = null;
    const frameTimes = [];
    const rows = [];

    /* ---------- log ---------- */
    const logEl = $('log');
    const time = () => { const d = new Date(); return `${d.toLocaleTimeString('en-GB')}.${String(d.getMilliseconds()).padStart(3, '0').slice(0, 1)}`; };
    function log(type, text, tone) {
        const li = document.createElement('li');
        li.dataset.t = type; if (tone) li.dataset.tone = tone;
        li.hidden = filter !== 'all' && filter !== type;
        const label = { json: 'JSON', log: 'ESP', i2c: 'I2C', app: 'WEB', raw: 'RAW' }[type] || type;
        li.innerHTML = `<time></time><b></b><span></span>`;
        li.children[0].textContent = time(); li.children[1].textContent = label; li.children[2].textContent = text;
        logEl.appendChild(li);
        while (logEl.children.length > LOG_MAX) logEl.firstChild.remove();
        if ($('follow').checked && !li.hidden) logEl.scrollTop = logEl.scrollHeight;
    }
    document.querySelectorAll('input[name="lf"]').forEach((r) => r.addEventListener('change', () => {
        filter = r.value;
        for (const li of logEl.children) li.hidden = filter !== 'all' && li.dataset.t !== filter;
        logEl.scrollTop = logEl.scrollHeight;
    }));
    $('logClear').addEventListener('click', () => { logEl.textContent = ''; });

    /* ---------- device events ---------- */
    let lastJsonLogAt = 0;
    device.on('line', (m) => {
        if (m.type === 'json') {
            $('lastJson').textContent = JSON.stringify(m.data, null, 2);
            const now = Date.now(); // keep the log readable at 5 Hz: one JSON line per second
            if (now - lastJsonLogAt >= 1000) { lastJsonLogAt = now; log('json', m.raw.trim()); }
        } else if (m.type === 'log') log('log', m.text, /error|fail|stale|disconnect/i.test(m.text) ? 'warn' : '');
        else if (m.type === 'i2c') log('i2c', m.raw.trim(), m.kind === 'ack' && !m.ack ? 'warn' : '');
        else log('raw', m.text, m.error ? 'warn' : '');
    });
    device.on('status', ({ state, message }) => {
        const chip = $('conn');
        chip.dataset.state = state;
        chip.classList.toggle('sim', device.simulated);
        chip.textContent = (device.simulated ? 'ข้อมูลจำลอง: ' : '') + (CHIP[state] || state);
        log('app', `status ${state}${message ? ` (${message})` : ''}`, state === 'error' || state === 'stale' ? 'bad' : '');
        $('simStart').textContent = device.simulated ? 'หยุดข้อมูลจำลอง' : 'เริ่มข้อมูลจำลอง';
    });
    device.on('sample', (s) => {
        frameTimes.push(Date.now());
        $('aTiltName').textContent = s.legacy ? 'c7_angle (v1)' : 'mpu_tilt';
        $('aTiltRange').textContent = s.legacy ? '−15 ถึง 35' : '−30 ถึง 40';
        $('aC7').textContent = s.legacy ? s.c7.toFixed(2) : s.tiltEstimated ? 'null' : s.tilt.toFixed(2); $('aPitch').textContent = s.pitch.toFixed(2);
        $('aRoll').textContent = s.roll.toFixed(2); $('aYaw').textContent = s.yaw.toFixed(2);
        $('aFw').textContent = s.fwCva === null ? 'ไม่ได้ส่งมา' : s.fwCva.toFixed(2);
        $('aWeb').textContent = s.cva.toFixed(3);
        // v1 firmware computed the old formula, so its parity is against cvaLegacy.
        const d = s.fwCva === null ? null : s.fwCva - (s.legacy ? s.legacyCva : s.cva);
        $('aDelta').textContent = d === null ? '–' : `${d >= 0 ? '+' : ''}${d.toFixed(3)}`;
        $('aDelta').dataset.tone = d !== null && Math.abs(d) > 0.15 ? 'bad' : 'ok';
        const p = C7.classify(s.cva, 'normal');
        $('aClass').textContent = { good: 'ท่าดี', warn: 'เริ่มก้มคอ', bad: 'คอยื่น' }[p] + ' (เกณฑ์ปกติ)';
        $('aEst').textContent = (s.tiltEstimated ? 'ไม่มี MPU6050 ที่ต้นคอ: tilt ประมาณจาก head_pitch' : 'tilt มาจาก MPU6050 ที่ต้นคอ')
            + (s.legacy ? ' · เฟิร์มแวร์ v1: หน้าเว็บถอด 0.35 × pitch ออกจาก c7_angle เอง ควรอัปเดตเป็น v2' : '');
        if (window.C7Formula) window.C7Formula.render(s, { simulated: device.simulated });
        sensors(s.sensors);
        queueSave(s);
        rows.push([s.protocol, s.tiltEstimated ? null : s.tilt, s.c7, s.pitch, s.roll, s.yaw, s.cva, s.fwCva, s.bootId, s.calibrationId, new Date().toISOString(), device.simulated ? 1 : 0]);
        if (rows.length > 20000) rows.shift();
        $('csvCount').textContent = `${rows.length} แถว`;
    });
    let lastInvalidCode = '';
    device.on('invalid', (r) => {
        sensors(r.sensors);
        if (r.code !== lastInvalidCode) { lastInvalidCode = r.code; log('app', `invalid ${r.code}: ${r.dev}`, 'warn'); }
    });
    device.on('zero', (z) => {
        if (z.phase === 'sent') log('app', 'ส่ง z แล้ว รอ calibration_id เปลี่ยน');
        else log('app', z.ok ? `Zero สำเร็จ calibration_id=${z.calibrationId}` : `Zero ไม่สำเร็จ (${z.code})`, z.ok ? '' : 'bad');
    });
    device.on('scan', (r) => {
        $('scanResult').textContent = r.ok
            ? `พบ ${r.addresses.length ? r.addresses.join(', ') : 'ไม่มีอุปกรณ์'}${r.summary ? ` (${r.summary})` : ''}`
            : `สแกนไม่ครบ หมดเวลารอ ได้ ${r.addresses.join(', ') || 'ไม่มี'}`;
    });

    function sensors(s) {
        s = s || {};
        [['sL', 'left'], ['sR', 'right'], ['sC', 'c7']].forEach(([id, k]) => {
            const node = $(id);
            const present = !!s[`${k}_present`], fresh = !!s[`${k}_fresh`];
            node.dataset.s = present ? (fresh ? 'fresh' : 'stale') : 'absent';
            node.querySelector('em').textContent = present ? (fresh ? 'ส่งข้อมูลอยู่' : 'พบแต่ข้อมูลค้าง') : 'ไม่พบ';
        });
    }

    /* ---------- periodic board panel ---------- */
    setInterval(() => {
        const now = Date.now();
        while (frameTimes.length && now - frameTimes[0] > 5000) frameTimes.shift();
        $('kBoot').textContent = device.bootId ?? '–';
        $('kCal').textContent = device.calibrationId ?? '–';
        $('kFps').textContent = device.connected ? `${(frameTimes.length / 5).toFixed(1)} ต่อวินาที` : '–';
        $('kAge').textContent = device.lastPacketAt ? `${now - device.lastPacketAt} ms` : '–';
        $('kCount').textContent = `${device.stats.valid} / ${device.stats.invalid}`;
        $('kReason').textContent = device.lastInvalid ? `${device.lastInvalid.code}` : (device.state === 'live' ? 'ไม่มี' : '–');
    }, 500);

    /* ---------- commands ---------- */
    $('connect').addEventListener('click', () => device.connect());
    $('disconnect').addEventListener('click', () => device.disconnect());
    const need = (fn) => () => { if (!device.connected) { log('app', 'ยังไม่ได้เชื่อมต่อ', 'warn'); return; } fn(); };
    $('cmdZero').addEventListener('click', need(() => device.zero()));
    $('cmdCheck').addEventListener('click', need(() => { log('app', 'ส่ง i'); device.checkAddresses(); }));
    $('cmdScan').addEventListener('click', need(() => { log('app', 'ส่ง s'); $('scanResult').textContent = 'กำลังสแกน'; device.scanBus(); }));
    $('rawForm').addEventListener('submit', (e) => {
        e.preventDefault();
        const v = $('rawCmd').value;
        if (!v) return;
        need(async () => { const ok = await device.send(`${v}\n`); log('app', ok ? `ส่ง "${v}"` : `ส่ง "${v}" ไม่ได้`, ok ? '' : 'bad'); })();
        $('rawCmd').value = '';
    });

    /* ---------- simulator ---------- */
    const simInputs = [['simTilt', 'oTilt', 'tilt'], ['simPitch', 'oPitch', 'pitch'], ['simRoll', 'oRoll', 'roll'], ['simYaw', 'oYaw', 'yaw']];
    function simValues() { const v = { mpu: $('simMpu').checked }; simInputs.forEach(([i, , k]) => { v[k] = Number($(i).value); }); return v; }
    simInputs.forEach(([i, o]) => $(i).addEventListener('input', () => { $(o).textContent = $(i).value; if (sim) sim.set(simValues()); }));
    $('simMpu').addEventListener('change', () => { if (sim) sim.set(simValues()); });
    $('simStart').addEventListener('click', () => {
        if (device.simulated) { device.disconnect(); sim = null; return; }
        sim = new C7.Simulator({ script: 'manual' });
        sim.set(simValues());
        device.startSimulation(sim);
    });
    $('simInject').addEventListener('click', () => {
        if (!device.connected) { log('app', 'เริ่มข้อมูลจำลองหรือเชื่อมต่อก่อน', 'warn'); return; }
        device.feed(JSON.stringify({ protocol_version: C7.PROTOCOL_VERSION, geometry_id: C7.GEOMETRY.id, boot_id: device.bootId || 1, calibration_id: device.calibrationId || 1, calibrated: true, valid: false, tilt_estimated: true,
            sensors: { left_present: true, right_present: true, c7_present: false, left_fresh: false, right_fresh: false, c7_fresh: false },
            mpu_tilt: null, mpu_tilt_raw: null, head_pitch: null, head_roll: null, head_yaw: null, cva_angle: null }));
    });

    /* ---------- API save (opt-in) ---------- */
    let inFlight = false, lastSaveAt = 0, sent = 0;
    function queueSave(s) {
        if (!$('apiOn').checked || device.simulated || inFlight || Date.now() - lastSaveAt < 500) return;
        inFlight = true; lastSaveAt = Date.now();
        const started = performance.now();
        // Always saved as v2 (unmixed tilt); the server recomputes CVA with the same geometry and checks it.
        const body = { protocol_version: 2, geometry_id: C7.GEOMETRY.id, boot_id: s.bootId, calibration_id: s.calibrationId, calibrated: true, valid: true, tilt_estimated: s.tiltEstimated,
            mpu_tilt: s.tiltEstimated ? null : Number(s.tilt.toFixed(2)), head_pitch: s.pitch, head_roll: s.roll, head_yaw: s.yaw, cva_angle: Number(s.cva.toFixed(2)) };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        fetch('api/save_angle.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
            .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
            .then(({ ok, j }) => {
                const ms = Math.round(performance.now() - started);
                if (ok && j.status === 'ok') {
                    sent++; $('apiCount').textContent = sent;
                    $('apiLast').textContent = `#${j.id} CSV ${j.csv_saved ? 'บันทึก' : 'ไม่บันทึก'} MySQL ${j.mysql_saved ? 'บันทึก' : 'ไม่บันทึก'} ${ms} ms`;
                } else { $('apiLast').textContent = `ผิดพลาด: ${j.message || 'ไม่ทราบสาเหตุ'}`; log('app', `API error ${j.message || ''}`, 'bad'); }
            })
            .catch((e) => { $('apiLast').textContent = e.name === 'AbortError' ? 'หมดเวลา 15 วินาที' : 'ติดต่อ API ไม่ได้ เปิดหน้านี้ผ่าน PHP server'; log('app', `API ${e.message}`, 'bad'); })
            .finally(() => { clearTimeout(timer); inFlight = false; });
    }

    /* ---------- CSV export ---------- */
    $('csvExport').addEventListener('click', () => {
        const head = 'protocol,mpu_tilt,c7_angle_v1,head_pitch,head_roll,head_yaw,cva_web,cva_fw,boot_id,calibration_id,received_at,simulated';
        const csv = [head].concat(rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : typeof v === 'number' ? Number(v.toFixed(3)) : v)).join(','))).join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
        a.download = `c7-session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });

    /* ---------- sensor direction check ----------
       Expected convention (docs/SENSOR_AXES.md, used by c7-core.js and the firmware):
       chin down = +head_pitch, right ear down = +head_roll, face turns to the person's left = +head_yaw. */
    const AXIS_STEPS = [
        { say: 'นั่งตรง มองตรง อยู่นิ่ง', key: null },
        { say: 'ก้มหน้า คางลงประมาณ 20° ค้างไว้', key: 'pitch' },
        { say: 'เอียงหูขวาลงหาไหล่ขวา ค้างไว้', key: 'roll' },
        { say: 'หันหน้าไปทางซ้ายของตัวเอง ค้างไว้', key: 'yaw' },
    ];
    let axisRun = null;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function averagePose(ms) {
        const acc = { pitch: 0, roll: 0, yaw: 0 }; let n = 0;
        const off = device.on('sample', (s) => { acc.pitch += s.pitch; acc.roll += s.roll; acc.yaw += s.yaw; n++; });
        await sleep(ms); off();
        if (!n) throw new Error('NO_SAMPLES');
        return { pitch: acc.pitch / n, roll: acc.roll / n, yaw: acc.yaw / n };
    }
    function judge(expectKey, d) {
        const ranked = Object.entries(d).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        const [topKey, topVal] = ranked[0];
        if (Math.abs(topVal) < 5) return { ok: false, text: 'แทบไม่ขยับ', tone: 'bad', hint: 'ขยับไม่พอ หรือค่าจากสองหูหักล้างกัน' };
        if (topKey !== expectKey) return { ok: false, text: `ไปออกที่ head_${topKey}`, tone: 'bad', hint: `แกนสลับ: ท่านี้ควรเป็น head_${expectKey}` };
        if (topVal < 0) return { ok: false, text: 'เครื่องหมายกลับ', tone: 'bad', hint: `head_${expectKey} ต้องกลับเครื่องหมาย` };
        return { ok: true, text: 'ตรง', tone: 'ok' };
    }
    $('axisStart').addEventListener('click', async () => {
        if (axisRun) { axisRun.cancel = true; return; }
        if (!device.connected || device.state !== 'live') { $('axisStatus').textContent = 'ต้องมีข้อมูลจริงที่ใช้ได้ก่อน (สถานะ "รับข้อมูลอยู่")'; return; }
        if (device.simulated) log('app', 'กำลังตรวจกับข้อมูลจำลอง ผลไม่ได้บอกอะไรเกี่ยวกับบอร์ดจริง', 'warn');
        axisRun = { cancel: false };
        $('axisStart').textContent = 'หยุด';
        const rows = $('axisRows').children, hints = [];
        try {
            let base = null;
            for (let i = 0; i < AXIS_STEPS.length; i++) {
                const step = AXIS_STEPS[i];
                for (let c = 3; c > 0; c--) { if (axisRun.cancel) throw new Error('CANCELLED'); $('axisStatus').textContent = `${i + 1}/4 ${step.say} (เริ่มวัดใน ${c})`; await sleep(1000); }
                $('axisStatus').textContent = `${i + 1}/4 ${step.say} กำลังวัด`;
                const avg = await averagePose(1500);
                if (!step.key) { base = avg; continue; }
                const d = { pitch: avg.pitch - base.pitch, roll: avg.roll - base.roll, yaw: avg.yaw - base.yaw };
                const r = judge(step.key, d);
                const row = rows[i - 1];
                row.children[2].textContent = `p ${d.pitch.toFixed(1)}  r ${d.roll.toFixed(1)}  y ${d.yaw.toFixed(1)}`;
                row.children[3].textContent = r.text; row.children[3].dataset.tone = r.tone;
                if (!r.ok) hints.push(r.hint);
                log('app', `axis check ${step.key}: Δ ${JSON.stringify(d)} -> ${r.text}`, r.ok ? '' : 'warn');
            }
            $('axisStatus').textContent = 'ตรวจเสร็จแล้ว';
            $('axisAdvice').textContent = hints.length
                ? `ทิศทางยังไม่ตรง: ${hints.join(' / ')} ต้องแก้การแปลงแกนต่อหูในเฟิร์มแวร์ (ดู docs/SENSOR_AXES.md) ไม่ควรสลับแกนที่หน้าเว็บ`
                : 'ทั้งสามแกนตรงกับที่หน้าเว็บใช้แล้ว';
        } catch (e) {
            $('axisStatus').textContent = e.message === 'CANCELLED' ? 'หยุดแล้ว' : 'ไม่ได้รับข้อมูลระหว่างวัด ตรวจการเชื่อมต่อแล้วลองใหม่';
        } finally {
            axisRun = null; $('axisStart').textContent = 'เริ่มตรวจ';
        }
    });

    /* ---------- start ---------- */
    sensors({});
    if (!device.supported) { log('app', 'เบราว์เซอร์นี้ไม่มี Web Serial ใช้ Chrome หรือ Edge (ข้อมูลจำลองยังใช้ได้)', 'warn'); $('connect').disabled = true; }
    else device.connect({ auto: true }).catch(() => {});
})();
