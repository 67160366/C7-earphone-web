// Dependency-free checks for assets/c7-core.js. Run: node scripts/check-web.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/c7-core.js', import.meta.url), 'utf8');
let clock = 1_000_000;
const ctx = { console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, TextDecoder, TextEncoder };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(source, ctx, { filename: 'c7-core.js' });
vm.runInContext(await readFile(new URL('../assets/c7-collect.js', import.meta.url), 'utf8'), ctx, { filename: 'c7-collect.js' });
const C7 = ctx.C7;
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok  ${name}`); };

// Independent re-derivation of geometry 1 (docs/FORMULA.md), written without C7.cvaParts.
const D = Math.PI / 180;
function refCva(tilt, pitch) {
    const L = 12, tz = 1, ty = 2, N = 52.05 * D;
    const phi0 = Math.acos((tz * Math.sin(N) - ty * Math.cos(N)) / L) - N;
    const used = tilt === null ? 0.5 * Math.max(0, pitch) : tilt;
    const phi = phi0 + used * D, th = pitch * D;
    const z = L * Math.sin(phi) + tz * Math.cos(th) + ty * Math.sin(th);
    const y = L * Math.cos(phi) - tz * Math.sin(th) + ty * Math.cos(th);
    return Math.atan2(y, z) / D;
}
// [tilt, pitch] grid incl. limits and the no-MPU estimate (tilt = null).
const grid = [];
for (const t of [null, -30, -10, 0, 5, 10, 15, 25, 40]) for (const p of [-25, -10, -6, 0, 10, 26, 45]) grid.push([t, p]);
await test('CVA matches the independent geometry-1 derivation', () => {
    for (const [t, p] of grid) {
        const got = C7.cva(t, p), want = refCva(t, p);
        assert.ok(Math.abs(got - want) <= 1e-9, `cva(${t},${p}) = ${got}, want ${want}`);
    }
    assert.ok(Math.abs(C7.cva(0, 0) - 52.05) < 1e-9, 'zero posture is exactly 52.05');
    assert.ok(Math.abs(C7.PHI0 - 40.058) < 0.001, `phi0 = ${C7.PHI0}`);
});
await test('CVA moves in the anatomical direction', () => {
    const n = C7.cva(0, 0);
    assert.ok(C7.cva(10, 0) < n - 7, 'forward neck lowers CVA');
    assert.ok(C7.cva(10, -10) < n - 5, 'forward neck with head tipped up still lowers CVA');
    assert.ok(C7.cva(10, -15) < n - 5, 'counter-rotation cannot cancel the forward-head signal');
    assert.ok(n - C7.cva(0, 20) < n - C7.cva(10, 0), 'looking down alone lowers CVA less than a forward neck');
    assert.ok(C7.cva(0, -10) - n < 2, 'looking up alone barely changes CVA');
    assert.ok(C7.cva(15, 0) < C7.cva(10, 0), 'more lean, lower CVA');
});
await test('cvaParts is self-consistent', () => {
    const r = C7.cvaParts(8, -4);
    assert.ok(Math.abs(r.phi - (r.phi0 + 8)) < 1e-12);
    assert.ok(Math.abs(Math.hypot(r.c0.z, r.c0.y) - C7.GEOMETRY.neckLength.value) < 1e-12);
    assert.ok(Math.abs(r.t.z - (r.c0.z + r.head.z)) < 1e-12 && Math.abs(r.t.y - (r.c0.y + r.head.y)) < 1e-12);
    assert.ok(Math.abs(r.cva - Math.atan2(r.t.y, r.t.z) / D) < 1e-12);
    assert.equal(r.tiltEstimated, false);
    const e = C7.cvaParts(null, 20);
    assert.equal(e.tiltEstimated, true); assert.equal(e.tilt, 10);
    assert.equal(C7.cvaParts(null, -10).tilt, 0, 'no-MPU estimate only guesses flexion');
});

const good = { protocol_version: 2, geometry_id: 1, boot_id: 7, calibration_id: 1, calibrated: true, valid: true, tilt_estimated: false,
    sensors: { left_present: true, right_present: true, c7_present: true, left_fresh: true, right_fresh: true, c7_fresh: true },
    mpu_tilt: 0, mpu_tilt_raw: 3.5, head_pitch: 0, head_roll: 0, head_yaw: 0, cva_angle: 52.05 };
const v1 = { protocol_version: 1, boot_id: 7, calibration_id: 1, calibrated: true, valid: true, c7_estimated: false,
    sensors: { left_present: true, right_present: true, c7_present: true, left_fresh: true, right_fresh: true, c7_fresh: true },
    c7_angle: -9, head_pitch: 0, head_roll: 0, head_yaw: 0, cva_angle: 52.05 };
await test('validatePacket accepts a valid v2 packet and ignores roll/yaw for CVA', () => {
    const r = C7.validatePacket(good);
    assert.equal(r.ok, true);
    assert.equal(r.sample.protocol, 2); assert.equal(r.sample.legacy, false);
    assert.ok(Math.abs(r.sample.cva - 52.05) < 1e-9);
    const turned = C7.validatePacket({ ...good, head_roll: 25, head_yaw: -35 });
    assert.ok(Math.abs(turned.sample.cva - 52.05) < 1e-9);
    const noMpu = C7.validatePacket({ ...good, tilt_estimated: true, mpu_tilt: null, head_pitch: 20, cva_angle: Math.round(refCva(null, 20) * 100) / 100 });
    assert.equal(noMpu.ok, true); assert.equal(noMpu.sample.tiltEstimated, true);
});
await test('legacy v1 packets are unmixed: tilt = c7 + 9 - 0.35 * pitch', () => {
    // dMPU = +10, pitch = -10 -> v1 c7_angle = -9 + 10 - 3.5 = -2.5; the old CVA 50.46 looked "good".
    const legacyCva = Math.round(C7.cvaLegacy(-2.5, -10, 0, 0) * 100) / 100;
    const r = C7.validatePacket({ ...v1, c7_angle: -2.5, head_pitch: -10, cva_angle: legacyCva });
    assert.equal(r.ok, true);
    assert.equal(r.sample.legacy, true);
    assert.ok(Math.abs(r.sample.tilt - 10) < 1e-9, `tilt ${r.sample.tilt}`);
    assert.ok(r.sample.legacyCva > 50 && r.sample.cva < 46, `legacy ${r.sample.legacyCva} new ${r.sample.cva}`);
    const est = C7.validatePacket({ ...v1, c7_estimated: true, c7_angle: -9 + 0.65 * 20, head_pitch: 20, cva_angle: null });
    assert.equal(est.ok, true); assert.equal(est.sample.tiltEstimated, true);
    assert.equal(C7.validatePacket({ ...v1, cva_angle: 40 }).code, 'CVA_PARITY');
});
await test('validatePacket rejects bad packets with user text', () => {
    const cases = [
        [{ ...good, protocol_version: undefined }, 'LEGACY_FIRMWARE'],
        [{ ...good, protocol_version: 3 }, 'LEGACY_FIRMWARE'],
        [{ ...good, valid: false, mpu_tilt: null, head_pitch: null, head_roll: null, head_yaw: null, cva_angle: null }, 'SENSOR_STALE'],
        [{ ...good, valid: false, calibrated: false, head_pitch: null }, 'WARMING_UP'],
        [{ ...good, valid: false, sensors: { left_present: false, right_present: false } }, 'NO_EAR_SENSOR'],
        [{ ...good, calibration_id: 0 }, 'SENSOR_STALE'],
        [{ ...good, mpu_tilt: 'x' }, 'SENSOR_STALE'],
        [{ ...good, head_pitch: 60 }, 'OUT_OF_RANGE'],
        [{ ...good, mpu_tilt: 55 }, 'OUT_OF_RANGE'],
        [{ ...good, cva_angle: 40 }, 'CVA_PARITY'],
        [{ ...good, geometry_id: 9 }, 'GEOMETRY_MISMATCH'],
    ];
    for (const [packet, code] of cases) {
        const r = C7.validatePacket(packet);
        assert.equal(r.ok, false, code);
        assert.equal(r.code, code);
        assert.ok(r.user && r.dev);
    }
});
await test('classify uses sensitivity thresholds', () => {
    assert.equal(C7.classify(52, 'normal'), 'good');
    assert.equal(C7.classify(48, 'normal'), 'good');
    assert.equal(C7.classify(45, 'normal'), 'warn');
    assert.equal(C7.classify(43.4, 'normal'), 'bad');
    assert.equal(C7.classify(49, 'strict'), 'warn');
    assert.equal(C7.classify(43, 'relaxed'), 'warn');
    assert.equal(C7.classify(NaN, 'normal'), null);
});
await test('parseLine recognises firmware line formats', () => {
    assert.equal(C7.parseLine('[ESP-LOG] Calibrated zero posture! calibration_id=#2').type, 'log');
    assert.equal(C7.parseLine('I2C FULL_SCAN_BEGIN').kind, 'begin');
    assert.equal(C7.parseLine('I2C FULL_SCAN_END').kind, 'end');
    assert.equal(C7.parseLine('I2C BUS_SUMMARY: Wire(21/22)=[0x4A] Wire1(18/19)=[OFF]').kind, 'summary');
    const ack = C7.parseLine('I2C 0x4a: ACK');
    assert.equal(ack.addr, '0x4A'); assert.equal(ack.ack, true);
    assert.equal(C7.parseLine('I2C 0x68: NO_ACK').ack, false);
    assert.equal(C7.parseLine(JSON.stringify(good) + '\r').type, 'json');
    assert.equal(C7.parseLine('{broken').type, 'raw');
    assert.equal(C7.parseLine('   '), null);
});

function device() {
    const written = [];
    const d = new C7.Device({ serial: null, now: () => clock });
    d.port = { close: async () => {}, writable: { getWriter: () => ({ write: async (b) => written.push(new TextDecoder().decode(b)), releaseLock() {} }) } };
    const states = [];
    d.on('status', (s) => states.push(s.state));
    d.state = 'waiting';
    return { d, written, states };
}
await test('device goes live, then stale after 1.2 s without valid data', () => {
    const { d, states } = device();
    d.feed(JSON.stringify(good));
    assert.equal(d.state, 'live');
    clock += 1300; d.tick();
    assert.equal(d.state, 'stale');
    d.feed(JSON.stringify(good));
    assert.equal(d.state, 'live');
    assert.deepEqual([...states], ['live', 'stale', 'live']);
});
await test('invalid packets never emit samples', () => {
    const { d } = device();
    let samples = 0; d.on('sample', () => samples++);
    d.feed(JSON.stringify({ ...good, valid: false, head_pitch: null }));
    assert.equal(samples, 0);
    assert.equal(d.state, 'waiting');
    assert.equal(d.stats.invalid, 1);
});
await test('zero waits for a new calibration_id', async () => {
    const { d, written } = device();
    d.feed(JSON.stringify(good));
    const p = d.zero();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(written[0], 'z\n');
    d.feed(JSON.stringify(good));
    assert.ok(d.pendingZero, 'same calibration_id must not confirm');
    d.feed(JSON.stringify({ ...good, calibration_id: 2 }));
    assert.deepEqual({ ...(await p) }, { ok: true, calibrationId: 2 });
    assert.equal(d.pendingZero, null);
});
await test('zero timeout clears pending state', async () => {
    const { d } = device();
    d.feed(JSON.stringify(good));
    const p = d.zero();
    clock += 5100; d.tick();
    assert.equal((await p).code, 'TIMEOUT');
    assert.equal(d.pendingZero, null);
});
await test('I2C scan collects acknowledged addresses', async () => {
    const { d } = device();
    const p = d.scanBus();
    ['I2C FULL_SCAN_BEGIN', 'I2C 0x4A: ACK', 'I2C 0x68: ACK', 'I2C BUS_SUMMARY: Wire(21/22)=[0x4A,0x68]', 'I2C FULL_SCAN_END'].forEach((l) => d.feed(l));
    const r = await p;
    assert.equal(r.ok, true);
    assert.deepEqual([...r.addresses], ['0x4A', '0x68']);
});
await test('demo script covers good, warn and bad, incl. forward head with the head tipped up', () => {
    const sim = new C7.Simulator({ script: 'demo' });
    const seen = new Set(); let counter = false, badRun = 0, longestBad = 0;
    for (let ms = 0; ms < 72000; ms += 200) {
        const a = sim.scripted(ms);
        const c = C7.classify(C7.cva(a.tilt, a.pitch), 'normal');
        seen.add(c);
        badRun = c === 'bad' ? badRun + 200 : 0; longestBad = Math.max(longestBad, badRun);
        if (a.tilt > 10 && a.pitch < -3) counter = true;
    }
    assert.deepEqual([...seen].sort(), ['bad', 'good', 'warn']);
    assert.ok(counter, 'demo shows counter-rotation');
    assert.ok(longestBad > 10000, `bad held ${longestBad} ms, long enough for the 10 s alert`);
});
await test('simulator packets pass validation and zero bumps calibration_id', () => {
    const lines = [];
    const sim = new C7.Simulator({ script: 'manual', now: () => clock });
    sim.out = (l) => lines.push(l);
    sim.set({ tilt: 10, pitch: 20, roll: 5, yaw: -10 });
    sim.emitPacket();
    const packet = JSON.parse(lines.at(-1));
    assert.equal(packet.protocol_version, 2);
    assert.equal(C7.validatePacket(packet).ok, true);
    sim.command('z');
    sim.emitPacket();
    const after = JSON.parse(lines.at(-1));
    assert.equal(after.calibration_id, 2);
    assert.equal(after.mpu_tilt, 0);
    assert.equal(after.head_pitch, 0);
    sim.set({ mpu: false });
    sim.emitPacket();
    const noMpu = JSON.parse(lines.at(-1));
    assert.equal(noMpu.mpu_tilt, null); assert.equal(noMpu.tilt_estimated, true);
    assert.equal(C7.validatePacket(noMpu).ok, true);
});

await test('Web Serial session: open, split chunks, unplug', async () => {
    const enc = new TextEncoder();
    const listeners = {};
    let controller, opened = null, signals = null, closed = false;
    const port = {
        getInfo: () => ({ usbVendorId: 0x10c4 }),
        open: async (o) => { opened = o; },
        setSignals: async (s) => { signals = s; },
        close: async () => { closed = true; },
        readable: new ReadableStream({ start(c) { controller = c; } }),
        writable: null,
    };
    const serial = {
        getPorts: async () => [port],
        requestPort: async () => port,
        addEventListener: (t, fn) => { listeners[t] = fn; },
        removeEventListener: (t) => { delete listeners[t]; },
    };
    const d = new C7.Device({ serial, now: () => clock });
    const samples = [], states = [];
    d.on('sample', (s) => samples.push(s));
    d.on('status', (s) => states.push(s.state));
    assert.equal(await d.connect({ auto: true }), true);
    assert.equal(opened.baudRate, 460800, 'matches SERIAL_BAUD in the firmware');
    assert.equal(C7.BAUD, 460800);
    assert.equal(signals.dataTerminalReady, false);
    const line = JSON.stringify(good);
    controller.enqueue(enc.encode('[ESP-LOG] boot\r\n' + line.slice(0, 40)));
    controller.enqueue(enc.encode(line.slice(40) + '\r\n' + line + '\n'));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(samples.length, 2);
    assert.equal(d.state, 'live');
    listeners.disconnect({ target: port });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(d.state, 'error');
    assert.equal(d.connected, false);
    assert.ok(closed, 'port closed after unplug');
    assert.deepEqual([...states], ['connecting', 'waiting', 'live', 'error']);
});

await test('one invalid packet while live does not drop the live state', () => {
    const { d } = device();
    d.feed(JSON.stringify(good));
    clock += 200; d.feed(JSON.stringify({ ...good, valid: false, head_pitch: null }));
    assert.equal(d.state, 'live');
    clock += 1300; d.feed(JSON.stringify({ ...good, valid: false, head_pitch: null }));
    assert.equal(d.state, 'waiting');
});
await test('silent board after invalid packets turns stale', () => {
    const { d } = device();
    d.feed(JSON.stringify({ ...good, valid: false, calibrated: false, head_pitch: null }));
    clock += 1300; d.tick();
    assert.equal(d.state, 'stale');
});
await test('zero is refused before the first packet', async () => {
    const { d, written } = device();
    assert.equal((await d.zero()).code, 'NO_DATA_YET');
    assert.equal(written.length, 0);
});
await test('writes are queued and teardown resolves a pending scan', async () => {
    const { d, written } = device();
    d.feed(JSON.stringify(good));
    const a = d.send('i\n'), b = d.send('s\n');
    assert.deepEqual([await a, await b], [true, true]);
    assert.deepEqual(written, ['i\n', 's\n']);
    const scan = d.scanBus();
    await d.disconnect();
    assert.equal((await scan).code, 'DISCONNECTED');
});
await test('reconnecting to the same port closes it before reopening', async () => {
    const events = [];
    let isOpen = false;
    const makeStream = () => new ReadableStream({ start() {} });
    const port = {
        getInfo: () => ({ usbVendorId: 0x10c4 }),
        open: async () => { if (isOpen) throw new Error('already open'); isOpen = true; port.readable = makeStream(); events.push('open'); },
        close: async () => { isOpen = false; events.push('close'); },
        readable: null, writable: null,
    };
    const serial = { getPorts: async () => [port], requestPort: async () => port, addEventListener() {}, removeEventListener() {} };
    const d = new C7.Device({ serial, now: () => clock });
    assert.equal(await d.connect(), true);
    assert.equal(await d.connect(), true);
    assert.deepEqual(events, ['open', 'close', 'open']);
    await d.disconnect();
    assert.equal(isOpen, false);
});

/* ---------- collect mode (assets/c7-collect.js, docs/DATA_COLLECTION.md) ---------- */
const K = C7.Collect;
const eq = (a, b, m) => assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), m); // arrays from the vm realm
// Independent quaternion -> chip Euler, written from the firmware formula (quaternionToEulerDeg).
function refEuler(w, x, y, z) {
    const n = Math.hypot(w, x, y, z); w /= n; x /= n; y /= n; z /= n;
    const sy = 2 * (w * y - z * x);
    return [Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) / D, Math.abs(sy) >= 1 ? Math.sign(sy) * 90 : Math.asin(sy) / D, Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) / D];
}
const earInts = [16384, 0, 0, 0, 0, 0, 2511, 512, -512, 0, 3]; // identity quat, 9.8 m/s² on z, gyro ±1 rad/s
const c7Ints = [0, 0, 16384, 131, 0, -262];
const dLine = (seq, flags, L, R, C) => ['D', seq, 1000 + seq * 20, flags, ...(L || Array(11).fill('')), ...(R || Array(11).fill('')), ...(C || Array(6).fill(''))].join(',');

await test('collect: parseLine routes H and D lines', () => {
    assert.equal(C7.parseLine('H,format=1,rate_hz=50').type, 'collect-header');
    assert.equal(C7.parseLine(dLine(1, 63, earInts, earInts, c7Ints)).type, 'collect');
    assert.equal(C7.parseLine('Dxx').type, 'raw');
    const h = K.parseHeader('H,format=1,boot_id=42,i2c_hz=400000,simulated=1,foo=bar');
    assert.equal(h.format, 1); assert.equal(h.boot_id, 42); assert.equal(h.foo, 'bar');
});
await test('collect: D line decodes into units', () => {
    const s = K.parseData(dLine(7, 63, earInts, earInts, c7Ints));
    assert.equal(s.seq, 7); assert.equal(s.tDev, 1140); assert.equal(s.flags, 63);
    eq(s.L.q, [1, 0, 0, 0]);
    assert.ok(Math.abs(s.L.acc[2] - 2511 / 256) < 1e-12, 'BNO accel Q8 m/s²');
    assert.ok(Math.abs(s.L.gyro[0] - 1 / D) < 1e-9 && Math.abs(s.L.gyro[1] + 1 / D) < 1e-9, 'BNO gyro Q9 rad/s -> °/s');
    assert.equal(s.L.accuracy, 3); assert.equal(s.L.updated, true);
    assert.ok(Math.abs(s.C.acc[2] - 9.80665) < 1e-9, 'MPU 16384 LSB/g');
    assert.ok(Math.abs(s.C.gyro[0] - 1) < 1e-12 && Math.abs(s.C.gyro[2] + 2) < 1e-12, 'MPU 131 LSB/(°/s)');
    eq(s.C.tilt.map((v) => Math.round(v * 1e9) / 1e9), [0, 0]);
});
await test('collect: missing sensors and malformed lines', () => {
    const s = K.parseData(dLine(1, 0x02 | 0x10, null, earInts, null));
    assert.equal(s.L, null); assert.equal(s.C, null); assert.ok(s.R && s.R.updated);
    assert.equal(K.parseData(dLine(1, 0x01, earInts, null, null)).L.updated, false, 'fresh but no new value');
    assert.equal(K.parseData(dLine(1, 0x00, earInts, null, null)).L, null, 'not fresh = ignored even if filled');
    assert.equal(K.parseData('D,1,2,3,4'), null, 'too few fields');
    const half = earInts.slice(); half[3] = '';
    assert.equal(K.parseData(dLine(1, 63, half, earInts, c7Ints)), null, 'partly empty block');
    const bad = earInts.slice(); bad[0] = '1.5';
    assert.equal(K.parseData(dLine(1, 63, bad, earInts, c7Ints)), null, 'non-integer');
});
await test('collect: chip Euler matches the firmware formula', () => {
    for (let i = 0; i < 200; i++) {
        const q = [Math.sin(i * 1.3) + 1.1, Math.cos(i * 0.7), Math.sin(i * 0.31), Math.cos(i * 2.1) * 0.5];
        const got = K.chipEulerDeg(q), want = refEuler(...q);
        got.forEach((v, j) => assert.ok(Math.abs(v - want[j]) < 1e-9, `euler ${i}/${j}`));
    }
    const e = K.chipEulerDeg(K.qAxisAngle([1, 0, 0], 30));
    assert.ok(Math.abs(e[0] - 30) < 1e-9 && Math.abs(e[1]) < 1e-9 && Math.abs(e[2]) < 1e-9, 'rotation about chip x shows on ex');
});
await test('collect: left/right difference ignores mounting, sees slip', () => {
    const mL = K.qAxisAngle([0, 0, 1], 90), mR = K.qMul(K.qAxisAngle([0, 0, 1], -90), K.qAxisAngle([0, 1, 0], 180));
    const tare = { L: mL, R: mR };
    const head = K.qMul(K.qAxisAngle([0, 1, 0], 25), K.qAxisAngle([1, 0, 0], 15));
    assert.ok(K.lrDeg(K.qMul(head, mL), K.qMul(head, mR), tare) < 1e-6, 'rigid head: 0');
    const slipped = K.qMul(K.qMul(head, mL), K.qAxisAngle([1, 0, 0], 12));
    assert.ok(Math.abs(K.lrDeg(slipped, K.qMul(head, mR), tare) - 12) < 1e-6, '12° slip of one ear');
    const q14 = (q) => q.map((v) => Math.round(v * 16384) / 16384);
    assert.ok(K.lrDeg(q14(K.qMul(head, mL)), q14(K.qMul(head, mR)), { L: q14(mL), R: q14(mR) }) < 0.05, 'Q14 rounding does not read as slip');
    assert.equal(K.lrDeg(null, mR, tare), null);
});
await test('collect: head angles follow the firmware (Euler minus zero, midpoint, limits)', () => {
    const toInts = (q) => q.map((v) => Math.round(v * 16384));
    const line = (qL, qR, c7) => dLine(1, 63, [...toInts(qL), 0, 0, 2511, 0, 0, 0, 3], [...toInts(qR), 0, 0, 2511, 0, 0, 0, 3], c7);
    const id = [1, 0, 0, 0];
    const zero = K.parseData(line(id, id, [0, 0, 16384, 0, 0, 0]));
    const tare = K.headTare(zero);
    const rotX = (deg) => K.qAxisAngle([1, 0, 0], deg);
    // both ears turn 20° about chip x -> firmware calls that pitch +20
    const h = K.firmwareHead(K.parseData(line(rotX(20), rotX(20), c7Ints)), tare);
    assert.equal(h.source, 'LR');
    assert.ok(Math.abs(h.pitch - 20) < 0.05 && Math.abs(h.roll) < 0.05 && Math.abs(h.yaw) < 0.05, JSON.stringify(h.raw));
    // opposite signs on the two ears cancel in the midpoint, as SENSOR_AXES.md warns
    const c = K.firmwareHead(K.parseData(line(rotX(15), rotX(-15), c7Ints)), tare);
    assert.ok(Math.abs(c.raw.pitch) < 0.05 && Math.abs(c.dL[0] - 15) < 0.05 && Math.abs(c.dR[0] + 15) < 0.05);
    // beyond the protocol limit: raw kept, clamped value used for the model
    const big = K.firmwareHead(K.parseData(line(rotX(60), rotX(60), c7Ints)), tare);
    assert.ok(Math.abs(big.raw.pitch - 60) < 0.05 && big.pitch === C7.LIMITS.pitch[1]);
    // one ear only, and the MPU tilt from atan2(ax, az) minus its zero
    const tilted = [Math.round(16384 * Math.sin(10 * D)), 0, Math.round(16384 * Math.cos(10 * D)), 0, 0, 0];
    const one = K.firmwareHead(K.parseData(dLine(1, 0x01 | 0x04, [...toInts(rotX(5)), 0, 0, 2511, 0, 0, 0, 3], null, tilted)), tare);
    assert.equal(one.source, 'L'); assert.ok(Math.abs(one.pitch - 5) < 0.05); assert.ok(Math.abs(one.tilt - 10) < 0.05);
    assert.equal(K.firmwareHead(K.parseData(dLine(1, 0, null, null, null)), tare), null);
});
await test('collect: sequence gaps incl. 16-bit wrap and restart', () => {
    assert.equal(K.seqGap(null, 5), 0);
    assert.equal(K.seqGap(5, 6), 0);
    assert.equal(K.seqGap(5, 9), 3);
    assert.equal(K.seqGap(65535, 0), 0);
    assert.equal(K.seqGap(65534, 2), 3);
    assert.equal(K.seqGap(5000, 0), 0, 'stream restarted');
});
await test('collect: CSV rows, escaping and simulated flag', () => {
    const s = K.parseData(dLine(3, 63, earInts, earInts, c7Ints));
    const row = K.rowFromSample(s, { tHost: 12.4, label: 'forward_head', step: 4, ref: 47.25, lr: 0.5, cz: 1.2, simulated: true });
    assert.equal(row.length, K.COLUMNS.length);
    const col = (n) => row[K.COLUMNS.indexOf(n)];
    assert.equal(col('t_host_ms'), 12); assert.equal(col('label'), 'forward_head'); assert.equal(col('ref_angle_deg'), 47.25);
    assert.equal(col('L_qw'), 1); assert.equal(col('L_acc'), 3); assert.equal(col('C_ez_gyro'), 1.2); assert.equal(col('simulated'), 1);
    const empty = K.rowFromSample(K.parseData(dLine(3, 0, null, null, null)), { tHost: 0, label: 'neutral', step: null, ref: null, lr: null, cz: null, simulated: false });
    assert.equal(empty.length, K.COLUMNS.length);
    assert.equal(empty[K.COLUMNS.indexOf('L_qw')], null);
    assert.equal(K.csvCell('a,"b"'), '"a,""b"""'); assert.equal(K.csvCell(null), ''); assert.equal(K.csvCell(NaN), '');
    const text = K.csvChunks([row, empty], 1).join('');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], K.COLUMNS.join(','));
    assert.equal(lines[2].split(',').length, K.COLUMNS.length);
});
await test('collect: protocol text, transitions and shuffle', () => {
    const { steps, errors } = K.parseProtocol('# comment\nneutral,30\nforward_head, 20\nbad line\nx,0\n');
    eq(steps.map((s) => [s.label, s.seconds]), [['neutral', 30], ['forward_head', 20]]);
    eq(errors, [4, 5]);
    const t = K.withTransitions(steps, 3);
    eq(t.map((s) => s.label), ['transition', 'neutral', 'transition', 'forward_head']);
    assert.equal(K.withTransitions(steps, 0).length, 2);
    const def = K.parseProtocol(K.DEFAULT_PROTOCOL);
    assert.equal(def.errors.length, 0);
    def.steps.forEach((s) => assert.ok(K.LABELS[s.label], `default label ${s.label} has a Thai name`));
    let seed = 1; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const sh = K.shuffleMiddle(def.steps, rand);
    assert.equal(sh.length, def.steps.length);
    eq([sh[0], sh[1], sh[sh.length - 1]], [def.steps[0], def.steps[1], def.steps[def.steps.length - 1]]);
    eq(sh.map((s) => s.label).sort(), def.steps.map((s) => s.label).sort());
});
await test('collect: simulator streams parseable lines and keeps the device live', () => {
    const lines = [];
    let t = 5000;
    const sim = new K.CollectSimulator({ now: () => t });
    sim.start((l) => lines.push(l));
    sim.command('r');
    for (let i = 0; i < 400; i++) { t += 20; sim.emitData(); }
    const header = lines.find((l) => l.startsWith('H,'));
    assert.equal(K.parseHeader(header).simulated, 1, 'header says simulated');
    const data = lines.filter((l) => l.startsWith('D,')).map(K.parseData);
    assert.ok(data.length > 380 && data.every(Boolean), 'all D lines parse');
    data.forEach((s) => {
        assert.ok(Math.abs(Math.hypot(...s.L.acc) - 9.80665) < 0.3, 'ear accel is gravity');
        assert.ok(Math.abs(Math.hypot(...s.C.acc) - 9.80665) < 0.3, 'C7 accel is gravity');
    });
    const tare = { L: data[0].L.q, R: data[0].R.q };
    assert.ok(data.every((s) => K.lrDeg(s.L.q, s.R.q, tare) < 0.2), 'simulated skull is rigid');
    sim.command('n');
    assert.equal(sim.streaming, false);
    sim.stop();
    // Device: collect lines alone keep the session live (JSON comes only once a second in collect mode).
    clock = 2_000_000;
    const d = new C7.Device({ serial: null, now: () => clock });
    d.connected; d.port = {}; d.state = 'waiting';
    const got = [];
    d.on('collect', (m) => got.push(m));
    d.feed(lines.find((l) => l.startsWith('D,')));
    assert.equal(d.state, 'live'); assert.equal(got.length, 1); assert.equal(d.stats.collect, 1);
    clock += 1000; d.tick(); assert.equal(d.state, 'live');
    clock += 300; d.tick(); assert.equal(d.state, 'stale');
});

await test('collect: format 2 ages, skew and format 1 still read', () => {
    const v2 = (ages) => dLine(5, 63, earInts, earInts, c7Ints) + ',' + ages.join(',');
    const s = K.parseData(v2([3, 7, 12]));
    assert.equal(s.L.ageMs, 3); assert.equal(s.R.ageMs, 7); assert.equal(s.C.ageMs, 12); assert.equal(s.skewMs, 4);
    const old = K.parseData(dLine(5, 63, earInts, earInts, c7Ints));
    assert.equal(old.L.ageMs, null); assert.equal(old.skewMs, null);
    const oneEar = K.parseData(dLine(5, 0x01 | 0x08, earInts, null, null) + ',2,,');
    assert.equal(oneEar.L.ageMs, 2); assert.equal(oneEar.R, null); assert.equal(oneEar.skewMs, null);
    assert.equal(K.parseData(v2([-1, 0, 0])), null, 'negative age');
    assert.equal(K.parseData(v2([1, 2])), null, 'wrong field count');
    assert.ok(K.FORMATS.includes(1) && K.FORMATS.includes(K.FORMAT) && K.FORMAT === 2);
    const row = K.rowFromSample(s, { tHost: 0, label: 'free', step: null, ref: null, lr: null, cz: null, simulated: false });
    assert.equal(row.length, K.COLUMNS.length);
    assert.equal(row[K.COLUMNS.indexOf('R_age_ms')], 7);
});
await test('collect: align, relative rotation, world axes and direction names', () => {
    const mL = K.qMul(K.qAxisAngle([0, 0, 1], 180), K.qAxisAngle([1, 1, 1], 120)), mR = K.qAxisAngle([1, 1, 1], 120);
    const head = K.qMul(K.qAxisAngle([0, 0, 1], 30), K.qAxisAngle([1, 0, 0], -20));
    const qL = K.qMul(head, mL), qR = K.qMul(head, mR);
    // aligned right ear equals left ear on a rigid skull
    assert.ok(K.qAngleDeg(K.alignTo(qR, mR, mL), qL) < 1e-6);
    // left vs right as mounted: 180° about world/head z
    const rel = K.relRotation(qL, qR);
    assert.ok(Math.abs(rel.angle - 180) < 1e-6, String(rel.angle));
    const small = K.relRotation([1, 0, 0, 0], K.qAxisAngle([0, 1, 0], 25));
    assert.ok(Math.abs(small.angle - 25) < 1e-9 && Math.abs(small.axis[1] - 1) < 1e-9 && Math.abs(small.euler[1] - 25) < 1e-9);
    // right chip at zero: x forward (north), y up, z right (east)
    const ax = K.worldAxes(mR);
    eq(ax.map((v) => v.map((c) => Math.round(c * 1e6) / 1e6 + 0)), [[0, 1, 0], [0, 0, 1], [1, 0, 0]]);
    assert.equal(K.dirName([0, 1, 0]), 'เหนือ'); assert.equal(K.dirName([0, 0, -1]), 'ลง');
    assert.equal(K.dirName([0.7, 0, 0.7]), 'ตะวันออก-ขึ้น'); assert.equal(K.dirName([-1, 0.2, 0]), 'ตะวันตก');
    // gravity: accel turned to the world points up; the MPU-from-gravity quaternion takes accel to +z
    const acc = K.qRotate(K.qConj(qR), [0, 0, 9.80665]);
    assert.ok(Math.abs(K.worldUpCheck(qR, acc) - 1) < 1e-9);
    assert.ok(Math.hypot(...K.worldAcc(qR, acc).linear) < 1e-9);
    assert.equal(K.worldUpCheck(qR, [0, 0, 30]), null, 'moving: no check');
    for (const a of [[0, 0, 9.8], [9.8, 0, 0], [3, -4, 5], [0, 0, -9.8]]) {
        const up = K.qRotate(K.gravityQuat(a), a), n = Math.hypot(...a);
        assert.ok(Math.abs(up[2] / n - 1) < 1e-9, `gravityQuat ${a}`);
    }
});
await test('collect: simulator world is ENU (accel turned by q points up, ears mirrored)', () => {
    let t = 1000;
    const sim = new K.CollectSimulator({ now: () => t });
    const lines = [];
    sim.start((l) => lines.push(l)); sim.command('r');
    for (let i = 0; i < 300; i++) { t += 20; sim.emitData(); }
    sim.stop();
    const data = lines.filter((l) => l.startsWith('D,')).map(K.parseData);
    assert.ok(data.every((s) => s && Number.isInteger(s.L.ageMs) && s.skewMs !== null));
    data.forEach((s) => assert.ok(K.worldUpCheck(s.L.q, s.L.acc) > 0.98 && K.worldUpCheck(s.R.q, s.R.acc) > 0.98, 'up check'));
    const rel = K.relRotation(data[0].L.q, data[0].R.q);
    assert.ok(rel.angle > 170, `ears are mirrored, ${rel.angle}`);
});

// ---------- structure.html: every part fits its enclosure, nothing collides, everything has a mount ----------
const S = await import('data:text/javascript,' + encodeURIComponent(await readFile(new URL('../assets/structure-layout.js', import.meta.url), 'utf8')));
const overlap = (a, b, e = 1e-6) => a[0] < b[3] - e && b[0] < a[3] - e && a[1] < b[4] - e && b[1] < a[4] - e && a[2] < b[5] - e && b[2] < a[5] - e;
await test('structure: C7 box parts fit inside and do not collide', () => {
    const u = S.C7, by = Object.fromEntries(u.parts.map((p) => [p.id, p])), e = 1e-6;
    const solids = [];
    for (const p of u.parts) { solids.push([p.id, p.box]); if (p.bump) solids.push([p.id, p.bump]); }
    for (const po of u.posts) solids.push(['post-' + po.id, [po.x - u.postR, po.y - u.postR, 0, po.x + u.postR, po.y + u.postR, u.tray.z]]);
    for (const [x0, y0, x1, y1] of u.batteryRibs) solids.push(['rib', [x0, y0, 0, x1, y1, 6]]);
    for (const [id, pins] of Object.entries(u.used)) for (const n of pins) solids.push([`jumper-${id}`, S.jumperBox(by[id], n), id]);
    for (const [name, b] of solids) {
        assert.ok(b[0] >= -u.in.w / 2 - e && b[3] <= u.in.w / 2 + e && b[1] >= -u.in.h / 2 - e && b[4] <= u.in.h / 2 + e && b[2] >= -e && b[5] <= u.in.d + e, `${name} is outside the box: ${b}`);
    }
    for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
        const [a, A, ownA] = solids[i], [b, B, ownB] = solids[j];
        if (a === b || ownA === b || ownB === a || (a === 'rib' && b === 'rib')) continue;   // a jumper belongs under its own board
        assert.ok(!overlap(A, B), `${a} collides with ${b}`);
    }
    // the tray is a plate between the levels: floor parts stay below it, boards above it, pins and jumpers pass through its slots
    for (const p of u.parts) assert.ok(p.level === 'floor' ? p.box[5] <= u.tray.z : p.box[2] >= u.tray.z + u.tray.t, `${p.id} crosses the tray`);
    for (const [id, pins] of Object.entries(u.used)) for (const n of pins) {
        const j = S.jumperBox(by[id], n);
        assert.ok(u.tray.slots.some((s) => j[0] >= s[0] && j[3] <= s[2] && j[1] >= s[1] && j[4] <= s[3]), `jumper ${id}.${n} has no slot in the tray`);
    }
    for (const s of u.tray.slots) assert.ok(s[0] > -u.tray.w / 2 + 1 && s[2] < u.tray.w / 2 - 1 && s[1] > -u.tray.h / 2 + 1 && s[3] < u.tray.h / 2 - 1, `slot ${s} cuts the tray edge`);
    // the 5 cm link hangs clear of the ESP32, and the height budget adds up to the inside depth
    assert.ok(u.link.lowY > by.esp.box[4] + 2 && u.link.gap < u.link.len, `link sags to y=${u.link.lowY}`);
    assert.ok(Math.abs(u.stack.reduce((t, r) => t + r[1], 0) - u.in.d) < 1e-9, 'stack-up equals the inside depth');
    assert.ok(u.zBoard >= 5.3 + S.JUMPER.bend + S.JUMPER.housing + S.JUMPER.strip, 'jumpers clear the battery');
    assert.deepEqual([u.out.w, u.out.h, u.out.d], [96, 60, 35]);
});
await test('structure: ear pods and joint case hold their board with room for the plug', () => {
    for (const u of [S.UNITS.podL, S.UNITS.podR, S.UNITS.joint]) {
        for (const p of u.parts) {
            const b = p.box;
            assert.ok(b[0] >= -u.in.w / 2 && b[3] <= u.in.w / 2 && b[1] >= -u.in.h / 2 && b[4] <= u.in.h / 2 && b[2] >= 0 && b[5] <= u.in.d, `${p.id} is outside ${u.id}`);
        }
        assert.ok(u.cableRoom >= 8, `${u.id}: ${u.cableRoom} mm for the plug and the bend`);
    }
    const [l, r] = [S.UNITS.podL, S.UNITS.podR];
    assert.equal(l.exit.x, -r.exit.x, 'pods are mirror images');
    assert.ok(Math.sign(S.pinAt(l.parts[0], l.socket)[0] - l.parts[0].at[0]) === l.s && Math.sign(S.pinAt(r.parts[0], r.socket)[0] - r.parts[0].at[0]) === r.s, 'cable uses the socket on the exit side');
});
await test('structure: every part has a mount, and wires end on real pins', () => {
    for (const u of Object.values(S.UNITS)) for (const p of [...u.parts, ...u.shell]) assert.ok(p.mount && p.mount.length > 10 && p.name && p.size, `${p.id} has no mount`);
    const by = Object.fromEntries(S.C7.parts.map((p) => [p.id, p]));
    const nets = { v33: 0, gnd: 0, sda: 0, scl: 0, bat: 0 };
    for (const w of S.C7_WIRES) {
        for (const [id, pin] of [w.a, w.b]) assert.ok(by[id] && (by[id].kind ? S.BOARD[by[id].kind].pins[pin] : by[id].pins[pin]), `${id}.${pin} does not exist`);
        assert.ok(S.C7_CABLES[w.cable], w.cable); nets[w.net]++;
    }
    // one wire per header pin: no pin carries two jumpers
    const used = S.C7_WIRES.flatMap((w) => [w.a.join('.'), w.b.join('.')]).filter((k) => !/^(bat|tp|mt|sw)\./.test(k));
    assert.equal(new Set(used).size, used.length, 'a header pin is used twice');
    for (const [id, pins] of Object.entries(S.C7.used)) for (const n of pins) assert.ok(used.includes(`${id}.${n}`), `${id}.${n} has a jumper but no wire`);
    assert.deepEqual(nets, { v33: 2, gnd: 5, sda: 2, scl: 2, bat: 4 });
    assert.ok(S.hardware().length >= 5);
});

console.log(`\n${passed} checks passed`);
