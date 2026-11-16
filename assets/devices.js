/* devices.html: อ่าน api/devices.php ทุก 1 วินาที แสดงหูฟังทุกเครื่องที่ส่งข้อมูลผ่าน Wi-Fi
   หน้านี้แสดงค่าที่เซิร์ฟเวอร์เก็บไว้เท่านั้น ไม่คำนวณหรือกลับเครื่องหมายแกนเอง */
(function () {
    'use strict';
    const API = 'api/devices.php';
    const POLL_MS = 1000;
    const HISTORY_ROWS = 30;
    const STATE_TEXT = { good: 'ท่าดี', warn: 'เริ่มก้มคอ', bad: 'คอยื่น' };

    const $ = (id) => document.getElementById(id);
    const conn = $('conn'), list = $('list'), empty = $('empty'), summary = $('summary');
    const historyBox = $('history'), historyTitle = $('historyTitle'), historyRows = $('historyRows');
    const cards = new Map();
    let selected = null;

    const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    };
    const deg = (v) => (typeof v === 'number' ? `${v.toFixed(1)}°` : '–');
    const displayName = (d) => d.name || d.device_uid;

    function agoText(sec) {
        if (sec === null) return 'ยังไม่เคยส่งข้อมูล';
        if (sec < 60) return `${sec} วินาทีก่อน`;
        if (sec < 3600) return `${Math.floor(sec / 60)} นาทีก่อน`;
        if (sec < 86400) return `${Math.floor(sec / 3600)} ชั่วโมงก่อน`;
        return `${Math.floor(sec / 86400)} วันก่อน`;
    }

    function makeCard(d) {
        const root = el('article', 'panel device');
        const top = el('div', 'device-top');
        const title = el('div');
        const name = el('h2', 'device-name');
        const uid = el('div', 'device-uid mono');
        title.append(name, uid);
        const chip = el('span', 'chip');
        top.append(title, chip);

        const cva = el('div', 'device-cva');
        const cvaNum = el('b');
        const state = el('span', 'device-state');
        cva.append(cvaNum, state);

        const angles = el('dl', 'device-angles');
        const cell = (label) => {
            const box = el('div');
            const dd = el('dd');
            box.append(el('dt', '', label), dd);
            angles.append(box);
            return dd;
        };
        const pitch = cell('ก้ม/เงย'), roll = cell('เอียง'), yaw = cell('หัน');

        const note = el('p', 'device-note');
        const foot = el('div', 'device-foot');
        const seen = el('span', 'small muted');
        const btn = el('button', 'btn btn-sm', 'ดูค่าย้อนหลัง');
        btn.type = 'button';
        btn.addEventListener('click', () => { selected = d.id; loadHistory(); });
        foot.append(seen, btn);

        root.append(top, cva, angles, note, foot);
        list.append(root);
        return { root, name, uid, chip, cvaNum, state, pitch, roll, yaw, note, seen };
    }

    function sensorNote(d) {
        if (!d.online) return 'ไม่ได้รับข้อมูลจากหูฟังเครื่องนี้แล้ว ค่าที่เห็นเป็นค่าล่าสุดที่เก็บไว้';
        const s = d.sensors;
        if (!d.valid) return (s & 3) ? 'กำลังตั้งท่าเริ่มต้น ยังไม่มีค่ามุม' : 'หูฟังต่อ Wi-Fi แล้ว แต่ไม่พบเซ็นเซอร์ที่หู';
        const parts = [];
        if ((s & 3) !== 3) parts.push(s & 1 ? 'ใช้เซ็นเซอร์หูซ้ายข้างเดียว' : 'ใช้เซ็นเซอร์หูขวาข้างเดียว');
        if (!(s & 4)) parts.push('ไม่มีเซ็นเซอร์ที่ต้นคอ มุมคอประมาณจากการก้มศีรษะ');
        return parts.join(' · ');
    }

    function render(devices) {
        empty.hidden = devices.length > 0;
        const online = devices.filter((d) => d.online).length;
        summary.textContent = devices.length ? `${devices.length} เครื่อง ออนไลน์ ${online} เครื่อง` : 'ยังไม่มีเครื่องใดส่งข้อมูล';

        const seenIds = new Set();
        for (const d of devices) {
            seenIds.add(d.id);
            let c = cards.get(d.id);
            if (!c) { c = makeCard(d); cards.set(d.id, c); }
            const r = d.latest;
            const posture = r ? window.C7.classify(r.cva_angle, 'normal') : null;
            c.root.dataset.online = String(d.online);
            c.root.dataset.posture = d.online && d.valid && posture ? posture : '';
            c.name.textContent = displayName(d);
            c.uid.textContent = d.name ? d.device_uid : `เครื่องที่ ${d.id}`;
            c.chip.dataset.state = d.online ? 'live' : 'stale';
            c.chip.textContent = d.online ? 'ออนไลน์' : 'ออฟไลน์';
            c.cvaNum.textContent = r ? deg(r.cva_angle) : '–';
            c.state.textContent = !r ? 'ยังไม่มีค่า' : `มุมคอ (ค่าประมาณ)${d.online && d.valid && posture ? ` · ${STATE_TEXT[posture]}` : ''}`;
            c.pitch.textContent = r ? deg(r.head_pitch) : '–';
            c.roll.textContent = r ? deg(r.head_roll) : '–';
            c.yaw.textContent = r ? deg(r.head_yaw) : '–';
            c.note.textContent = sensorNote(d);
            c.note.hidden = c.note.textContent === '';
            c.seen.textContent = d.online ? `ส่งล่าสุด ${d.last_seen_at.slice(11)}` : `ส่งล่าสุด ${agoText(d.seconds_ago)}`;
        }
        for (const [id, c] of cards) {
            if (!seenIds.has(id)) { c.root.remove(); cards.delete(id); }
        }
        if (selected !== null) {
            const d = devices.find((x) => x.id === selected);
            historyTitle.textContent = d ? `ค่าย้อนหลังของ ${displayName(d)}` : 'ค่าย้อนหลัง';
        }
    }

    async function loadHistory() {
        if (selected === null) return;
        try {
            const res = await fetch(`${API}?device=${selected}&limit=${HISTORY_ROWS}`, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || res.status);
            historyRows.replaceChildren(...data.readings.map((r) => {
                const tr = el('tr');
                tr.append(
                    el('td', 'mono', r.recorded_at.slice(11, 21)),
                    el('td', '', deg(r.cva_angle)),
                    el('td', '', deg(r.head_pitch)),
                    el('td', '', deg(r.head_roll)),
                    el('td', '', deg(r.head_yaw)),
                    el('td', '', r.tilt_estimated ? 'ไม่มี' : deg(r.mpu_tilt)),
                );
                return tr;
            }));
            if (!data.readings.length) {
                const tr = el('tr');
                const td = el('td', 'muted', 'ยังไม่มีค่าที่เก็บไว้');
                td.colSpan = 6;
                tr.append(td);
                historyRows.append(tr);
            }
            historyBox.hidden = false;
        } catch (e) {
            historyBox.hidden = true;
            selected = null;
        }
    }

    $('historyClose').addEventListener('click', () => { selected = null; historyBox.hidden = true; });

    async function poll() {
        try {
            const res = await fetch(API, { cache: 'no-store' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
            conn.dataset.state = 'live';
            conn.textContent = 'ติดต่อเซิร์ฟเวอร์ได้';
            render(data.devices);
            if (selected !== null) loadHistory();
        } catch (e) {
            conn.dataset.state = 'error';
            conn.textContent = 'ติดต่อเซิร์ฟเวอร์ไม่ได้';
            summary.textContent = 'อ่านข้อมูลจากเซิร์ฟเวอร์ไม่ได้ ตรวจว่าตั้งค่า api/config.local.php และฐานข้อมูลแล้ว';
        }
        setTimeout(poll, POLL_MS);
    }
    poll();
})();
