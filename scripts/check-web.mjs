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
    assert.equal(opened.baudRate, 115200);
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

console.log(`\n${passed} checks passed`);
