// Tests api/ingest.php and api/devices.php against a throwaway SQLite database (no MySQL needed).
//   node scripts/check-api.mjs
// Starts its own PHP server on 127.0.0.1:8091 with pdo_sqlite switched on, and removes the database afterwards.
// MySQL itself is not exercised here: the MySQL statements in api/db_schema.sql must be checked on the real server.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 8091;
const KEY = 'test-key-for-check-api';

function findPhp() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['php'], { encoding: 'utf8' });
  if (which.status === 0) return which.stdout.split(/\r?\n/)[0].trim();
  const pk = join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
  if (existsSync(pk)) {
    for (const d of readdirSync(pk)) {
      const p = join(pk, d, 'php.exe');
      if (d.startsWith('PHP.PHP') && existsSync(p)) return p;
    }
  }
  for (const p of ['C:\\xampp\\php\\php.exe', 'C:\\php\\php.exe']) if (existsSync(p)) return p;
  throw new Error('php not found');
}

const php = findPhp();
const work = mkdtempSync(join(tmpdir(), 'c7-api-'));
const dbFile = join(work, 'test.sqlite').replace(/\\/g, '/');
const cfgFile = join(work, 'config.php');
writeFileSync(cfgFile, `<?php return ['dsn' => 'sqlite:${dbFile}', 'ingest_key' => '${KEY}', 'online_seconds' => 5];`);

const args = ['-S', `127.0.0.1:${PORT}`, '-t', root];
const extDir = join(dirname(php), 'ext');
// A PHP without php.ini (winget) has no PDO driver loaded; XAMPP already loads it.
const loaded = spawnSync(php, ['-m'], { encoding: 'utf8' }).stdout || '';
if (!/pdo_sqlite/i.test(loaded)) args.unshift('-d', `extension_dir=${extDir}`, '-d', 'extension=pdo_sqlite');
const server = spawn(php, args, { cwd: root, env: { ...process.env, C7_CONFIG: cfgFile }, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = '';
server.stderr.on('data', (d) => { serverLog += d; });

const base = `http://127.0.0.1:${PORT}/api`;
const post = async (body, key = KEY) => {
  const headers = { 'Content-Type': 'application/json' };
  if (key !== null) headers['X-C7-Key'] = key;
  const r = await fetch(`${base}/ingest.php`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { code: r.status, json: await r.json() };
};
const get = async (q = '') => {
  const r = await fetch(`${base}/devices.php${q}`);
  return { code: r.status, json: await r.json() };
};

// Same formula as refCva() in check-web.mjs (geometry 1), written out again so the server is checked independently.
function refCva(tilt, pitch) {
  const L = 12, tz = 1, ty = 2, n = 52.05 * Math.PI / 180;
  const phi0 = Math.acos((tz * Math.sin(n) - ty * Math.cos(n)) / L) * 180 / Math.PI - 52.05;
  const used = tilt === null ? 0.5 * Math.max(0, pitch) : tilt;
  const phi = (phi0 + used) * Math.PI / 180, th = pitch * Math.PI / 180;
  const z = L * Math.sin(phi) + tz * Math.cos(th) + ty * Math.sin(th);
  const y = L * Math.cos(phi) - tz * Math.sin(th) + ty * Math.cos(th);
  return Math.atan2(y, z) * 180 / Math.PI;
}
const r2 = (v) => Math.round(v * 100) / 100;
const sample = (seq, pitch, tilt, extra = {}) => ({
  seq, age_ms: 10, cal: 1, valid: true, sensors: tilt === null ? 3 : 7,
  head_pitch: pitch, head_roll: 1.5, head_yaw: -2, mpu_tilt: tilt, cva_angle: r2(refCva(tilt, pitch)), ...extra,
});
const batch = (uid, bootId, samples, extra = {}) => ({
  device_uid: uid, name: `หูฟัง ${uid}`, firmware: 'test', boot_id: bootId, protocol_version: 2, geometry_id: 1, samples, ...extra,
});

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${detail}`); }
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${base}/devices.php`); return; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error(`PHP server did not start: ${serverLog}`);
}

try {
  await waitForServer();

  let r = await get();
  check('devices.php ว่างตอนเริ่ม และสร้างตารางเอง', r.code === 200 && r.json.devices.length === 0, JSON.stringify(r));

  r = await post(batch('c7-aaaaaaaaaaaa', 111, [sample(0, 0, 0)]), 'wrong');
  check('รหัสผิดถูกปฏิเสธ 401', r.code === 401);
  r = await post(batch('c7-aaaaaaaaaaaa', 111, [sample(0, 0, 0)]), null);
  check('ไม่ส่งรหัสถูกปฏิเสธ 401', r.code === 401);
  r = await get();
  check('คำขอที่ถูกปฏิเสธไม่สร้างบอร์ด', r.json.devices.length === 0);

  r = await post(batch('c7-aaaaaaaaaaaa', 111, [sample(0, 0, 0), sample(1, 10, 5), sample(2, 20, null)]));
  check('บอร์ด A ส่ง 3 ตัวอย่าง เก็บ 3', r.code === 200 && r.json.saved === 3 && r.json.new_device === true, JSON.stringify(r));
  const idA = r.json.device_id;

  r = await post(batch('c7-aaaaaaaaaaaa', 111, [sample(1, 10, 5), sample(2, 20, null), sample(3, 5, 2)]));
  check('ส่งซ้ำไม่เกิดแถวซ้ำ (เก็บ 1 ซ้ำ 2)', r.json.saved === 1 && r.json.duplicates === 2 && r.json.new_device === false, JSON.stringify(r.json));

  // Several boards at once: 6 boards x 5 requests in parallel.
  const uids = Array.from({ length: 6 }, (_, i) => `c7-bbbbbbbbbb0${i}`);
  const jobs = [];
  for (const [i, uid] of uids.entries()) {
    for (let k = 0; k < 5; k++) jobs.push(post(batch(uid, 500 + i, [sample(k * 2, k, k), sample(k * 2 + 1, k + 1, null)])));
  }
  const results = await Promise.all(jobs);
  check('6 บอร์ดส่งพร้อมกัน 30 คำขอ ตอบ 200 ทุกคำขอ', results.every((x) => x.code === 200), JSON.stringify(results.find((x) => x.code !== 200)));
  check('เก็บครบ 60 แถว', results.reduce((s, x) => s + (x.json.saved || 0), 0) === 60);

  r = await get();
  const list = r.json.devices;
  check('มี 7 บอร์ด รหัสไม่ซ้ำ', list.length === 7 && new Set(list.map((d) => d.device_uid)).size === 7, String(list.length));
  check('แต่ละบอร์ดออนไลน์และมีค่าล่าสุดของตัวเอง', list.every((d) => d.online && d.latest && d.name === `หูฟัง ${d.device_uid}`));
  const a = list.find((d) => d.id === idA);
  check('ค่าล่าสุดของบอร์ด A คือ seq 3', a.latest.seq === 3 && a.latest.head_pitch === 5 && a.latest.mpu_tilt === 2, JSON.stringify(a.latest));

  r = await get(`?device=${idA}&limit=10`);
  const hist = r.json.readings;
  check('ประวัติของบอร์ด A มี 4 แถว ใหม่สุดก่อน ไม่ปนบอร์ดอื่น', hist.length === 4 && hist.map((x) => x.seq).join() === '3,2,1,0', JSON.stringify(hist.map((x) => x.seq)));
  const noMpu = hist.find((x) => x.seq === 2);
  check('ไม่มี MPU: mpu_tilt เป็น null ติดป้ายประมาณ และ CVA ตรงสูตร',
    noMpu.mpu_tilt === null && noMpu.tilt_estimated === true && Math.abs(noMpu.cva_angle - refCva(null, 20)) < 0.01, JSON.stringify(noMpu));
  check('เวลาที่วัดมีมิลลิวินาที', /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/.test(hist[0].recorded_at), hist[0].recorded_at);

  r = await post(batch('c7-aaaaaaaaaaaa', 111, [
    sample(10, 0, 0, { cva_angle: 40 }),
    sample(11, 80, 0),
    sample(12, 0, 0),
    { seq: 13, age_ms: 5, valid: false, sensors: 0 },
  ]));
  check('CVA ไม่ตรงสูตรและมุมเกินช่วงถูกปฏิเสธรายตัวอย่าง ที่เหลือยังเก็บ',
    r.code === 200 && r.json.saved === 1 && r.json.rejected.length === 2 && r.json.skipped_invalid === 1, JSON.stringify(r.json));
  r = await get();
  const a2 = r.json.devices.find((d) => d.id === idA);
  check('ตัวอย่างสุดท้าย valid=false: บอร์ดยังออนไลน์ แต่สถานะบอกว่ายังไม่มีค่ามุม', a2.online && a2.valid === false && a2.sensors === 0 && a2.latest.seq === 12);

  r = await post(batch('c7-aaaaaaaaaaaa', 112, [sample(0, 1, 1)]));
  check('เปิดเครื่องใหม่ (boot_id ใหม่) seq 0 ไม่ชนของเดิม', r.json.saved === 1);

  r = await post(batch('bad uid!', 1, []));
  check('device_uid ผิดรูปแบบ 400', r.code === 400);
  r = await post(batch('c7-aaaaaaaaaaaa', 1, [], { geometry_id: 9 }));
  check('geometry_id ไม่ตรง 400', r.code === 400 && /GEOMETRY_MISMATCH/.test(r.json.message));
  r = await post('not json');
  check('body ไม่ใช่ JSON 400', r.code === 400);
  r = await post(batch('c7-aaaaaaaaaaaa', 1, Array.from({ length: 101 }, (_, i) => sample(i, 0, 0))));
  check('เกิน 100 ตัวอย่าง 400', r.code === 400);
  r = await get('?device=9999');
  check('บอร์ดที่ไม่มี 404', r.code === 404);
  r = await get('?device=abc');
  check('device ไม่ใช่ตัวเลข 400', r.code === 400);
  const g = await fetch(`${base}/ingest.php`);
  check('ingest.php ไม่รับ GET (405)', g.status === 405);
} catch (e) {
  fail++;
  console.log(`FAIL ${e.stack || e}`);
  if (serverLog) console.log(serverLog);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(work, { recursive: true, force: true }); } catch { /* file still locked on Windows */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
