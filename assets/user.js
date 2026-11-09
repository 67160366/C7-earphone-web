/* User page: 3D neck model, posture state, head direction meters and alert. Depends on c7-core.js. */
(function () {
    'use strict';
    const C7 = window.C7;
    const $ = (id) => document.getElementById(id);
    const demo = new URLSearchParams(location.search).has('demo');

    /* ---------- settings (per-browser convenience) ---------- */
    const store = {
        get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } },
        set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked */ } },
    };
    const saved = store.get('c7.settings', {}) || {};
    const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
    const settings = {
        level: pick(saved.level, Object.keys(C7.SENSITIVITY), 'normal'),
        delay: pick(saved.delay, [5, 10, 20], 10),
        sound: saved.sound === true,
        mirror: saved.mirror !== false,
        theme: pick(saved.theme, ['system', 'light', 'dark'], 'system'),
        view: pick(saved.view, ['angle', 'side', 'front'], 'angle'),
    };
    const saveSettings = () => store.set('c7.settings', settings);
    function applyTheme() {
        if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', settings.theme);
    }
    applyTheme();

    /* ---------- 3D model (ES module; needs http://, not file://) ---------- */
    let model = null;
    const pending = { pose: { tilt: 0, pitch: 0, roll: 0, yaw: 0 }, live: false, sensors: {} };
    function modelError(text) { const e = $('modelError'); e.textContent = text; e.hidden = false; }
    if (location.protocol === 'file:') {
        modelError('เปิดหน้านี้ผ่าน http://localhost เพื่อดูโมเดล 3 มิติ ค่ามุมด้านข้างยังใช้งานได้');
    } else {
        import(new URL('assets/neck-model.js', document.baseURI).href)
            .then((m) => m.createNeckModel($('model'), {
                modelUrl: new URL('assets/models/head/LeePerrySmith.glb', document.baseURI).href,
                normalUrl: new URL('assets/models/head/Infinite-Level_02_Tangent_SmoothUV.jpg', document.baseURI).href,
            }))
            .then((m) => {
                model = m;
                model.setMirror(settings.mirror);
                model.setView(settings.view);
                model.setPose(pending.pose);
                model.setLive(pending.live);
                model.setSensors(pending.sensors);
                const tag = $('cvaTag');
                model.onLabel(({ x, y, visible }) => { tag.style.left = `${x}px`; tag.style.top = `${y}px`; tag.hidden = !visible || !pending.live; });
            })
            .catch((e) => { console.error(e); modelError('แสดงโมเดล 3 มิติไม่ได้ในเบราว์เซอร์นี้ ค่ามุมด้านข้างยังใช้งานได้'); });
    }
    function showPose(pose, live, sensors) {
        pending.pose = pose; pending.live = live; if (sensors) pending.sensors = sensors;
        if (!model) return;
        model.setPose(pose); model.setLive(live); if (sensors) model.setSensors(sensors);
    }
    document.querySelectorAll('input[name="view"]').forEach((r) => {
        r.checked = r.value === settings.view;
        r.addEventListener('change', () => { settings.view = r.value; saveSettings(); if (model) model.setView(r.value); });
    });

    /* ---------- direction meters (convention documented in neck-model.js) ---------- */
    const AXES = {
        pitch: { el: 'mPitch', range: C7.LIMITS.pitch, words: ['เงย', 'ก้ม'] },
        roll: { el: 'mRoll', range: C7.LIMITS.roll, words: ['ซ้าย', 'ขวา'] },     // +roll = right ear down
        yaw: { el: 'mYaw', range: C7.LIMITS.yaw, words: ['ขวา', 'ซ้าย'] },      // +yaw = face turns left
    };
    const DEAD = 2; // degrees treated as "straight"
    function describe(axis, v) {
        if (Math.abs(v) < DEAD) return 'ตรง';
        const [neg, pos] = AXES[axis].words;
        const verb = axis === 'pitch' ? '' : axis === 'roll' ? 'เอียง' : 'หัน';
        return `${verb}${v > 0 ? pos : neg} ${Math.abs(v).toFixed(0)}°`;
    }
    function setMeters(s) {
        for (const [axis, cfg] of Object.entries(AXES)) {
            const meter = document.querySelector(`.meter[data-axis="${axis}"]`);
            const dot = meter.querySelector('.dot');
            if (!s) { $(cfg.el).textContent = '–'; dot.style.left = '50%'; meter.setAttribute('data-off', ''); continue; }
            meter.removeAttribute('data-off');
            const v = s[axis];
            $(cfg.el).textContent = describe(axis, v);
            // Track: left end = negative words[0]/right end = positive, except yaw where the track reads left->right as the person sees it.
            const span = Math.max(Math.abs(cfg.range[0]), Math.abs(cfg.range[1]));
            let x = v / span;
            if (axis === 'pitch') x = v / (v >= 0 ? Math.abs(cfg.range[1]) : Math.abs(cfg.range[0]));
            if (axis === 'yaw') x = -x; // +yaw is the person's left, drawn on the left
            dot.style.left = `${50 + Math.max(-1, Math.min(1, x)) * 46}%`;
        }
    }

    /* ---------- alert ---------- */
    let badSince = 0, alerted = false, audio = null;
    function beep() {
        if (!settings.sound) return;
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            const o = audio.createOscillator(), g = audio.createGain();
            o.type = 'sine'; o.frequency.value = 660;
            g.gain.setValueAtTime(0.0001, audio.currentTime);
            g.gain.exponentialRampToValueAtTime(0.08, audio.currentTime + 0.03);
            g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
            o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.4);
        } catch (e) { /* audio unavailable */ }
    }
    function updateAlert(p, now) {
        if (p !== 'bad') { clearAlert(); return; }
        if (!badSince) badSince = now;
        const held = (now - badSince) / 1000;
        if (held >= settings.delay) {
            if (!alerted) { alerted = true; beep(); }
            $('alertTitle').textContent = `คอยื่นมา ${Math.floor(held)} วินาทีแล้ว`;
            $('alert').hidden = false;
        }
    }
    function clearAlert() { badSince = 0; alerted = false; $('alert').hidden = true; }

    /* ---------- device and readout ---------- */
    const device = new C7.Device();
    const WORDS = { good: 'ท่าดี', warn: 'เริ่มก้มคอ', bad: 'คอยื่น' };
    const ADVICE = {
        good: 'คอตั้งตรงดี ทำงานต่อได้เลย',
        warn: 'ศีรษะเริ่มยื่นไปข้างหน้า ยืดคอขึ้นเล็กน้อย',
        bad: 'คอยื่นไปข้างหน้ามาก ดึงคางเข้าแล้วยืดคอขึ้น',
    };
    const CHIP = { idle: 'ยังไม่เชื่อมต่อ', connecting: 'กำลังเชื่อมต่อ', waiting: 'รอข้อมูล', live: 'พร้อมใช้งาน', stale: 'สัญญาณขาด', error: 'เชื่อมต่อไม่ได้' };

    function setReadout({ word, advice, p }) {
        const row = $('stateRow');
        if (p) { row.dataset.p = p; $('stateMark').dataset.p = p; } else { delete row.dataset.p; }
        if ($('stateWord').textContent !== word) $('stateWord').textContent = word;
        if ($('advice').textContent !== advice) $('advice').textContent = advice;
    }
    function showConnected(on) {
        $('onboard').hidden = on;
        $('live').hidden = !on;
        $('disconnect').hidden = demo;
    }

    device.on('status', ({ state, message }) => {
        const chip = $('conn');
        chip.dataset.state = state;
        chip.classList.toggle('sim', device.simulated);
        chip.textContent = device.simulated ? 'ข้อมูลจำลอง' : CHIP[state] || state;
        showConnected(device.connected);
        const err = $('connectError');
        err.hidden = !(state === 'error' && message);
        err.textContent = state === 'error' ? message : '';
        if (state === 'live') return; // samples drive the readout
        clearAlert();
        $('angleLine').textContent = '';
        setMeters(null);
        showPose(device.lastSample ? poseOf(device.lastSample) : { tilt: 0, pitch: 0, roll: 0, yaw: 0 }, false, {});
        if (!device.connected) return;
        if (state === 'stale') setReadout({ word: 'สัญญาณขาด', advice: message });
        else setReadout({ word: state === 'connecting' ? 'กำลังเชื่อมต่อ' : 'กำลังรอข้อมูล', advice: message || 'รอข้อมูลจากเซ็นเซอร์' });
    });

    // tilt is the MPU change since zero, or the estimate from head pitch when no MPU is fitted.
    const poseOf = (s) => ({ tilt: s.tilt, pitch: s.pitch, roll: s.roll, yaw: s.yaw });
    device.on('sample', (s) => {
        const now = Date.now();
        const p = C7.classify(s.cva, settings.level);
        setReadout({ word: WORDS[p], advice: ADVICE[p], p });
        $('angleLine').textContent = `มุมคอ (ค่าประมาณ) ${s.cva.toFixed(0)}° ท่าเริ่มต้น ${C7.NEUTRAL_CVA.toFixed(0)}°${s.tiltEstimated ? ' · ไม่มีเซ็นเซอร์ที่ต้นคอ' : ''}`;
        $('cvaTag').textContent = `${s.cva.toFixed(0)}°`;
        setMeters(s);
        showPose(poseOf(s), true, s.sensors);
        updateAlert(p, now);
    });

    /* ---------- actions ---------- */
    $('connect').addEventListener('click', () => { $('zeroMsg').textContent = ''; device.connect(); });
    $('disconnect').addEventListener('click', () => { cancelCountdown(); device.disconnect(); });

    let countdown = null;
    function cancelCountdown() {
        if (!countdown) return;
        clearInterval(countdown); countdown = null;
        $('zeroLabel').textContent = 'ตั้งท่าเริ่มต้น';
        $('zeroMsg').textContent = '';
    }
    $('zero').addEventListener('click', () => {
        if (countdown) { cancelCountdown(); return; }
        if (!device.connected) return;
        let n = 3;
        const msg = $('zeroMsg');
        msg.dataset.tone = '';
        msg.textContent = 'นั่งหลังตรง มองตรงไปข้างหน้า ค้างไว้';
        $('zeroLabel').textContent = `ยกเลิก (${n})`;
        countdown = setInterval(async () => {
            n--;
            if (n > 0) { $('zeroLabel').textContent = `ยกเลิก (${n})`; return; }
            clearInterval(countdown); countdown = null;
            $('zeroLabel').textContent = 'กำลังตั้งค่า';
            $('zero').disabled = true;
            const r = await device.zero();
            $('zero').disabled = false;
            $('zeroLabel').textContent = 'ตั้งท่าเริ่มต้นใหม่';
            if (r.ok) { msg.dataset.tone = 'ok'; msg.textContent = 'ตั้งท่าเริ่มต้นแล้ว'; clearAlert(); }
            else {
                msg.dataset.tone = 'bad';
                msg.textContent = { TIMEOUT: 'หูฟังไม่ตอบกลับ ตรวจว่าไฟเซ็นเซอร์ติด แล้วกดอีกครั้ง', NO_DATA_YET: 'ยังไม่ได้รับข้อมูลจากหูฟัง รอสักครู่แล้วกดอีกครั้ง' }[r.code] || 'ตั้งท่าเริ่มต้นไม่สำเร็จ ลองเชื่อมต่อใหม่';
            }
        }, 1000);
    });

    /* ---------- settings dialog ---------- */
    const dlg = $('settings');
    function syncSettingsForm() {
        document.querySelector(`input[name="level"][value="${settings.level}"]`).checked = true;
        document.querySelector(`input[name="delay"][value="${settings.delay}"]`).checked = true;
        document.querySelector(`input[name="theme"][value="${settings.theme}"]`).checked = true;
        $('sound').checked = settings.sound;
        $('mirror').checked = settings.mirror;
        const t = C7.SENSITIVITY[settings.level];
        $('levelHint').textContent = `ท่าดีเมื่อมุมคอ ${t.good}° ขึ้นไป เตือนเมื่อต่ำกว่า ${t.warn}°`;
    }
    $('openSettings').addEventListener('click', () => { syncSettingsForm(); dlg.showModal(); });
    dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    $('settingsForm').addEventListener('change', (e) => {
        const t = e.target;
        if (t.name === 'level') settings.level = t.value;
        if (t.name === 'delay') settings.delay = Number(t.value);
        if (t.name === 'theme') { settings.theme = t.value; applyTheme(); }
        if (t.id === 'sound') { settings.sound = t.checked; if (t.checked) beep(); }
        if (t.id === 'mirror') { settings.mirror = t.checked; if (model) model.setMirror(t.checked); }
        saveSettings(); syncSettingsForm();
    });

    /* ---------- start ---------- */
    showConnected(false);
    setMeters(null);
    if (demo) {
        $('simNote').hidden = false;
        document.title = 'C7-BioSync (ข้อมูลจำลอง)';
        device.startSimulation(new C7.Simulator({ script: 'demo' }));
    } else if (!device.supported) {
        $('unsupported').hidden = false;
        $('connect').disabled = true;
    } else {
        device.connect({ auto: true }).catch(() => {});
    }
})();
