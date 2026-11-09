/*
 * Dev page: CVA formula breakdown (inputs, constants, each step with real numbers, side-view SVG,
 * the 3D model driven by the same numbers, and a comparison with the old v1 formula).
 * Depends on c7-core.js. Exposes window.C7Formula.render(sample | null, { simulated }).
 */
(function () {
    'use strict';
    const C7 = window.C7;
    const $ = (id) => document.getElementById(id);
    const G = C7.GEOMETRY;
    const DEG = Math.PI / 180;
    const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
    const sgn = (v, d = 2) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}` : '–');
    const KIND = { measured: 'วัดได้', assumed: 'สมมติ', derived: 'คำนวณ', estimated: 'ประมาณ', ignored: 'ไม่เข้าสูตร' };
    const tag = (kind) => `<span class="kind" data-kind="${kind}">${KIND[kind]}</span>`;

    /* ---------- table rows built once, values updated by id ---------- */
    function row(tbody, cells, ids = []) {
        const tr = document.createElement('tr');
        cells.forEach((html, i) => {
            const el = document.createElement(i === 0 ? 'th' : 'td');
            if (i === 0) el.scope = 'row';
            el.innerHTML = html;
            if (ids[i]) el.id = ids[i];
            tr.appendChild(el);
        });
        tbody.appendChild(tr);
    }
    const inputs = $('fInputs');
    row(inputs, ['<code>protocol_version</code>', '–', 'รุ่นรูปแบบข้อมูลจากเฟิร์มแวร์ (v2 ส่งมุม MPU แยกจาก pitch, v1 ผสมกัน)', tag('measured')], [null, 'fiVer', 'fiVerSrc']);
    row(inputs, ['<code>mpu_tilt</code>', '–', 'MPU6050 ที่ต้นคอ (C7): <code>atan2(ax, az)</code> ลบค่าตอนตั้งศูนย์', '–'], [null, 'fiTilt', 'fiTiltSrc', 'fiTiltKind']);
    row(inputs, ['<code>head_pitch</code>', '–', 'BNO085 ที่หู (0x4A ซ้าย, 0x4B ขวา) เฉลี่ยสองข้าง ลบค่าตอนตั้งศูนย์ บวก = ก้ม', tag('measured')], [null, 'fiPitch']);
    row(inputs, ['<code>head_roll</code>', '–', 'BNO085 บวก = หูขวาลง ใช้กับแถบเอียงศีรษะเท่านั้น', tag('ignored')], [null, 'fiRoll']);
    row(inputs, ['<code>head_yaw</code>', '–', 'BNO085 บวก = หันซ้าย ใช้กับแถบหันหน้าเท่านั้น', tag('ignored')], [null, 'fiYaw']);
    row(inputs, ['<code>cva_angle</code>', '–', 'เฟิร์มแวร์คำนวณด้วยสูตรเดียวกัน ใช้ตรวจว่าตรงกับหน้าเว็บ (ต่างได้ไม่เกิน 0.15°)', tag('derived')], [null, 'fiFw']);

    const consts = $('fConsts');
    const constRows = [
        ['L', 'neckLength', 'ความยาวแนวคอ C7 → C0'],
        ['t<sub>z</sub>', 'tragusForward', 'ติ่งหูอยู่หน้า C0'],
        ['t<sub>y</sub>', 'tragusUp', 'ติ่งหูอยู่สูงกว่า C0'],
        ['g', 'tiltGain', 'อัตราที่แนวคอหมุนต่อมุม MPU'],
        ['k', 'estimateGain', 'ใช้เมื่อไม่มี MPU'],
        ['N', 'neutralCva', 'CVA ของท่าตั้งศูนย์'],
    ];
    for (const [sym, key, what] of constRows) {
        const c = G[key];
        row(consts, [sym, `${c.value} ${c.unit}`, `${what}: ${c.source}`, tag(c.kind)]);
    }
    row(consts, ['φ<sub>0</sub>', `${f(C7.PHI0, 3)}°`, 'มุมแนวคอจากแนวดิ่งตอนตั้งศูนย์ แก้สมการจาก L, t<sub>z</sub>, t<sub>y</sub>, N (ขั้นที่ 1) ไม่ได้ตั้งเอง', tag('derived')]);

    /* ---------- steps ---------- */
    const STEPS = [
        { id: 'phi0', title: 'มุมแนวคอตอนตั้งศูนย์ φ₀', eq: 'φ₀ = acos((t_z·sin N − t_y·cos N) / L) − N' },
        { id: 'tilt', title: 'มุมที่แนวคอเปลี่ยน', eq: '' },
        { id: 'phi', title: 'มุมแนวคอตอนนี้ φ', eq: 'φ = φ₀ + g × tilt' },
        { id: 'c0', title: 'ตำแหน่งข้อต่อหัวกับคอ C0 (เทียบ C7)', eq: 'C0 = (L·sin φ, L·cos φ)' },
        { id: 'head', title: 'ติ่งหูหมุนรอบ C0 ตามหัว', eq: 'h = (t_z·cos θ + t_y·sin θ,  t_y·cos θ − t_z·sin θ),  θ = head_pitch' },
        { id: 't', title: 'ตำแหน่งติ่งหู T (เทียบ C7)', eq: 'T = C0 + h' },
        { id: 'cva', title: 'มุมคอ CVA', eq: 'CVA = atan2(T_y, T_z)' },
        { id: 'dist', title: 'ระยะ C7 ถึงติ่งหู', eq: '|T| = √(T_z² + T_y²)' },
    ];
    const stepsEl = $('fSteps');
    for (const s of STEPS) {
        const li = document.createElement('li');
        li.innerHTML = `<b></b><code class="eq"></code><code class="val" id="fs_${s.id}"></code>`;
        li.children[0].textContent = s.title;
        li.children[1].textContent = s.eq;
        if (!s.eq) li.children[1].id = 'fsEq_tilt';
        stepsEl.appendChild(li);
    }

    /* ---------- SVG side view (cm, y up -> SVG y down) ---------- */
    const svgNS = 'http://www.w3.org/2000/svg';
    const grid = $('fGrid');
    for (let z = -4; z <= 18; z += 2) { const l = document.createElementNS(svgNS, 'line'); l.setAttribute('x1', z); l.setAttribute('x2', z); l.setAttribute('y1', -18.5); l.setAttribute('y2', 2.5); grid.appendChild(l); }
    for (let y = -2; y <= 18; y += 2) { const l = document.createElementNS(svgNS, 'line'); l.setAttribute('x1', -5); l.setAttribute('x2', 18); l.setAttribute('y1', -y); l.setAttribute('y2', -y); grid.appendChild(l); }
    const attr = (id, o) => { const el = $(id); for (const [k, v] of Object.entries(o)) el.setAttribute(k, typeof v === 'number' ? v.toFixed(3) : v); };
    const text = (id, x, y, s) => { attr(id, { x, y: -y }); $(id).textContent = s; };
    function arcPath(r, a0, a1) { // angles in deg from +z (horizontal forward), CCW = up
        const p = (a) => [r * Math.cos(a * DEG), -r * Math.sin(a * DEG)];
        const [x0, y0] = p(a0), [x1, y1] = p(a1);
        return `M ${x0.toFixed(3)} ${y0.toFixed(3)} A ${r} ${r} 0 0 ${a1 > a0 ? 0 : 1} ${x1.toFixed(3)} ${y1.toFixed(3)}`;
    }
    function drawSvg(p) {
        attr('fHoriz', { x1: 0, y1: 0, x2: 16, y2: 0 });
        attr('fVert', { x1: 0, y1: 0, x2: 0, y2: -15 });
        attr('fNeck', { x1: 0, y1: 0, x2: p.c0.z, y2: -p.c0.y });
        attr('fHead', { x1: p.c0.z, y1: -p.c0.y, x2: p.t.z, y2: -p.t.y });
        attr('fCvaLine', { x1: 0, y1: 0, x2: p.t.z, y2: -p.t.y });
        attr('fP7', { cx: 0, cy: 0 }); attr('fP0', { cx: p.c0.z, cy: -p.c0.y }); attr('fPT', { cx: p.t.z, cy: -p.t.y });
        attr('fArcCva', { d: arcPath(4, 0, p.cva) });
        attr('fArcPhi', { d: arcPath(6.5, 90, 90 - p.phi) });
        text('fL7', -3.2, -1.6, 'C7');
        text('fL0', p.c0.z - 3.6, p.c0.y + 0.2, 'C0');
        text('fLT', p.t.z + 0.8, p.t.y + 0.6, 'ติ่งหู');
        const mid = (a, b) => (a + b) / 2;
        text('fLNeck', mid(0, p.c0.z) - 4.6, mid(0, p.c0.y) + 0.6, `L ${f(G.neckLength.value, 0)} cm`);
        text('fLDist', mid(0, p.t.z) + 1.2, mid(0, p.t.y) - 1.4, `${f(p.distance, 1)} cm`);
        const a = (p.cva / 2) * DEG;
        text('fLCva', 4.8 * Math.cos(a), 4.8 * Math.sin(a) - 0.4, `CVA ${f(p.cva, 1)}°`);
        const b = (90 - p.phi / 2) * DEG;
        text('fLPhi', 7.2 * Math.cos(b) - 0.5, 7.2 * Math.sin(b) + 0.4, `φ ${f(p.phi, 1)}°`);
    }

    /* ---------- 3D model (same numbers) ---------- */
    let model = null, pendingPose = { tilt: 0, pitch: 0, roll: 0, yaw: 0 };
    if (location.protocol === 'file:') {
        $('fModelInfo').textContent = 'เปิดผ่าน http://localhost เพื่อดูโมเดล 3 มิติ';
    } else {
        import(new URL('assets/neck-model.js', document.baseURI).href)
            .then((m) => m.createNeckModel($('fModel'), {
                modelUrl: new URL('assets/models/head/LeePerrySmith.glb', document.baseURI).href,
                normalUrl: new URL('assets/models/head/Infinite-Level_02_Tangent_SmoothUV.jpg', document.baseURI).href,
            }))
            .then((m) => {
                model = m;
                model.setMirror(false); model.setView('side'); model.setLive(true); model.setSensors({ left_fresh: true, right_fresh: true });
                model.setPose(pendingPose);
                window.C7Model = model; // inspection from the console
                const i = model.info();
                $('fModelInfo').textContent = `โมเดล ${i.model === 'scan' ? 'หัวสแกน' : 'สำรอง'} · 1 cm = ${f(i.scenePerCm, 4)} หน่วยฉาก · หมุนสแกนให้ตรงท่าศูนย์ ${sgn(i.fitDeg)}° · กระดูก chest → c7 → c5 → c3 → C0 ผิวชิ้นเดียว`;
            })
            .catch((e) => { console.error(e); $('fModelInfo').textContent = 'แสดงโมเดล 3 มิติไม่ได้ในเบราว์เซอร์นี้'; });
    }
    document.querySelectorAll('input[name="fView"]').forEach((r) => r.addEventListener('change', () => { if (model) model.setView(r.value); }));

    /* ---------- render ---------- */
    function render(s, { simulated = false } = {}) {
        const tilt = s ? (s.tiltEstimated ? null : s.tilt) : 0;
        const pitch = s ? s.pitch : 0;
        const p = C7.cvaParts(tilt, pitch);
        const src = $('fSource');
        src.textContent = !s ? 'ท่าตั้งศูนย์ (ยังไม่มีข้อมูล)' : simulated ? 'ข้อมูลจำลอง' : s.legacy ? 'บอร์ดจริง (เฟิร์มแวร์ v1)' : 'บอร์ดจริง';
        src.classList.toggle('sim', !!s && simulated);

        // 1. inputs
        $('fiVer').textContent = s ? `v${s.protocol}${s.legacy ? ' (เก่า)' : ''}` : '–';
        $('fiTilt').textContent = s ? (p.tiltEstimated ? 'null' : `${f(s.tilt)}°`) : '0.00°';
        $('fiTiltSrc').innerHTML = s && s.legacy && !p.tiltEstimated
            ? `เฟิร์มแวร์ v1 ส่ง <code>c7_angle = ${f(s.c7)}</code> หน้าเว็บถอดกลับ: <code>${f(s.c7)} + 9 − 0.35 × ${f(pitch)} = ${f(s.tilt)}</code>`
            : 'MPU6050 ที่ต้นคอ (C7): <code>atan2(ax, az)</code> ลบค่าตอนตั้งศูนย์ ไม่ผสม pitch';
        $('fiTiltKind').innerHTML = p.tiltEstimated ? tag('estimated') : tag('measured');
        $('fiPitch').textContent = `${f(pitch)}°`;
        $('fiRoll').textContent = s ? `${f(s.roll)}°` : '–';
        $('fiYaw').textContent = s ? `${f(s.yaw)}°` : '–';
        $('fiFw').textContent = s && s.fwCva !== null ? `${f(s.fwCva)}°` : '–';

        // 3. steps with the real numbers substituted
        const N = G.neutralCva.value, L = G.neckLength.value, tz = G.tragusForward.value, ty = G.tragusUp.value, g = G.tiltGain.value;
        $('fs_phi0').textContent = `= acos((${tz} × ${f(Math.sin(N * DEG), 4)} − ${ty} × ${f(Math.cos(N * DEG), 4)}) / ${L}) − ${N} = ${f(p.phi0, 3)}°`;
        $('fsEq_tilt').textContent = p.tiltEstimated ? 'tilt ≈ k × max(0, head_pitch)  (ไม่มี MPU: ประมาณ)' : 'tilt = mpu_tilt  (วัดจาก MPU ที่ C7)';
        $('fs_tilt').textContent = p.tiltEstimated ? `= ${G.estimateGain.value} × max(0, ${f(pitch)}) = ${f(p.tilt)}°` : `= ${f(p.tilt)}°`;
        $('fs_phi').textContent = `= ${f(p.phi0, 3)} + ${g} × ${f(p.tilt)} = ${f(p.phi, 3)}°`;
        $('fs_c0').textContent = `= (${L} × sin ${f(p.phi, 2)}°, ${L} × cos ${f(p.phi, 2)}°) = (${f(p.c0.z, 3)}, ${f(p.c0.y, 3)}) cm`;
        $('fs_head').textContent = `θ = ${f(pitch)}° → h = (${f(p.head.z, 3)}, ${f(p.head.y, 3)}) cm`;
        $('fs_t').textContent = `= (${f(p.c0.z, 3)} + ${f(p.head.z, 3)}, ${f(p.c0.y, 3)} + ${f(p.head.y, 3)}) = (${f(p.t.z, 3)}, ${f(p.t.y, 3)}) cm`;
        $('fs_cva').textContent = `= atan2(${f(p.t.y, 3)}, ${f(p.t.z, 3)}) = ${f(p.cva, 3)}°  (${sgn(p.cva - N)}° จากท่าตั้งศูนย์)`;
        $('fs_dist').textContent = `= ${f(p.distance, 2)} cm`;

        // 4. compare
        $('fcWeb').textContent = `${f(p.cva, 3)}°`;
        const fw = s && s.fwCva !== null ? s.fwCva : null;
        $('fcFw').textContent = fw === null ? '–' : `${f(fw)}° (Δ ${sgn(fw - (s.legacy ? s.legacyCva : p.cva), 3)})`;
        // What v1 firmware would have reported for this pose: c7 = -9 + tilt + 0.35*pitch (or 0.65*pitch without MPU).
        const c7v1 = s && s.legacy ? s.c7 : -9 + (p.tiltEstimated ? 0.65 * pitch : p.tilt + 0.35 * pitch);
        const old = C7.cvaLegacy(Math.min(35, Math.max(-15, c7v1)), pitch, s ? s.roll : 0, s ? s.yaw : 0);
        $('fcOld').textContent = `${f(old)}° (${sgn(old - p.cva)}° จากสูตรใหม่)`;
        const cls = C7.classify(p.cva, 'normal'), t = C7.SENSITIVITY.normal;
        $('fcClass').textContent = `${{ good: 'ท่าดี', warn: 'เริ่มก้มคอ', bad: 'คอยื่น' }[cls]} (ดี ≥ ${t.good}°, เตือน ≥ ${t.warn}°)`;
        $('fcClass').dataset.p = cls;

        drawSvg(p);
        pendingPose = { tilt: p.tilt, pitch, roll: s ? s.roll : 0, yaw: s ? s.yaw : 0 };
        if (model) model.setPose(pendingPose);
    }

    render(null);
    window.C7Formula = { render };
})();
