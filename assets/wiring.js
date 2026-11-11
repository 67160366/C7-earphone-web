// wiring.html: the user's own over-ear headphone + our add-on parts (ear pods, C7 brace) on a real head scan.
// Views: worn, exploded, and a wiring bench with real-size boards, pin names, wires and the battery chain.
// Offline: vendored Three.js, no CDN. Units are centimetres. Geometry lives in wiring-models.js.
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { DIM, STRIP_WIDTHS, buildHeadphone, buildEarPod, buildC7Brace, disposeGroup } from './wiring-models.js';
import { bno085, esp32, gy521, tp4056, mt3608, lipo, slideSwitch, motorModule } from './wiring-boards.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), canvas = $('c');
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const S = 4.4;    // scan units -> cm (head width ≈ 16 cm)

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

function studioRoom() {
  const room = new THREE.Scene();
  room.add(new THREE.Mesh(new THREE.BoxGeometry(30, 20, 30), new THREE.MeshBasicMaterial({ color: 0x4a5257, side: THREE.BackSide })));
  const panel = (w, h, c, pos, rot) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(5), side: THREE.DoubleSide })); p.position.set(...pos); p.rotation.set(...rot); room.add(p); };
  panel(14, 8, 0xfff2e4, [-6, 9.5, 4], [Math.PI / 2, 0, 0]);
  panel(8, 10, 0xdfeeff, [14.5, 3, -6], [0, -Math.PI / 2, 0]);
  panel(6, 8, 0xffffff, [-14.5, 2, 6], [0, Math.PI / 2, 0]);
  return room;
}
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(studioRoom(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 900);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.minDistance = 8; controls.maxDistance = 220;
const TARGET = V(0, -3, -2);
const VIEWS = {   // camera offsets from TARGET
  vBackQ: V(-48, 24, -62), vFront: V(0, 4, 96), vSide: V(96, 4, 0), vBack: V(0, 10, -96), vTop: V(0, 100, -8),
};
let dirty = true;
controls.addEventListener('change', () => { dirty = true; });

const key = new THREE.DirectionalLight(0xfff1e2, 2.6);
key.position.set(-25, 40, 22); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
Object.assign(key.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 120 });
scene.add(key);
const rim = new THREE.DirectionalLight(0xcfe8ff, 1.6); rim.position.set(30, 18, -40); scene.add(rim);

const world = new THREE.Group(); scene.add(world);   // the person and everything worn
const BENCH_AT = V(300, 0, 0);                        // the wiring bench sits far away in the same scene
const bench = new THREE.Group(); bench.position.copy(BENCH_AT); bench.visible = false; scene.add(bench);
const benchLight = new THREE.DirectionalLight(0xffffff, 2.2); benchLight.position.set(294, 12, 40); benchLight.target.position.copy(BENCH_AT); scene.add(benchLight, benchLight.target);

// ---------- head-and-neck rig (two joints, matches the vertex skinning below) ----------
const P1 = V(0, -1.3, -0.6).multiplyScalar(S);
const P2 = V(0, 0.85, -0.25).multiplyScalar(S);
const rig1 = new THREE.Group(); rig1.position.copy(P1); rig1.rotation.order = 'YXZ'; world.add(rig1);
const rig2 = new THREE.Group(); rig2.position.copy(P2).sub(P1); rig2.rotation.order = 'YXZ'; rig1.add(rig2);
const headAttach = new THREE.Group(); headAttach.position.copy(P2).negate(); rig2.add(headAttach);
const SHARE1 = 0.35, SHARE2 = 0.65;

let bust = null, restPos = null, restNrm = null, w1 = null, w2 = null;
const ray = new THREE.Raycaster();
function hit(origin, dir) {   // rays start inside the body and point outwards
  ray.set(origin, dir.clone().normalize()); ray.far = 100;
  const h = ray.intersectObject(bust, false)[0];
  if (!h) return null;
  const n = h.face.normal.clone().transformDirection(bust.matrixWorld);
  if (n.dot(dir) < 0) n.negate();
  return { p: h.point.clone(), n };
}

// ---------- state ----------
const st = { mode: 'wear', view: 'vBackQ', e: 0, person: true, tags: true, pinNames: false, width: 'three', pitch: 0, yaw: 0, roll: 0, auto: false, t0: 0 };
const pickables = [];
const anchors = {};
function anchor(parent, pos, id) { const o = new THREE.Object3D(); o.position.copy(pos); parent.add(o); anchors[id] = o; return o; }
const addPickables = (root) => root.traverse((o) => { if (o.isMesh) pickables.push(o); });

const EAR = { L: V(7.35, 6.38, -0.22), R: V(-8.0, 6.34, -0.22) };
const pods = {};
let brace = null;

// ---------- load the scan ----------
const texLoader = new THREE.TextureLoader();
const colorMap = texLoader.load('assets/models/head/Map-COL.jpg', () => { dirty = true; }); colorMap.colorSpace = THREE.SRGBColorSpace; colorMap.anisotropy = 8;
const normalMap = texLoader.load('assets/models/head/Infinite-Level_02_Tangent_SmoothUV.jpg', () => { dirty = true; });
new GLTFLoader().load('assets/models/head/LeePerrySmith.glb', (gltf) => {
  bust = gltf.scene.getObjectByName('LeePerrySmith');
  bust.material = new THREE.MeshPhysicalMaterial({
    map: colorMap, normalMap, normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.52, sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xff9c80),
    clearcoat: 0.06, clearcoatRoughness: 0.6, side: THREE.DoubleSide,
  });
  bust.scale.setScalar(S); bust.castShadow = true; bust.receiveShadow = true;
  world.add(bust); bust.updateMatrixWorld(true);
  const g = bust.geometry;
  restPos = g.attributes.position.array.slice(); restNrm = g.attributes.normal.array.slice();
  const n = g.attributes.position.count; w1 = new Float32Array(n); w2 = new Float32Array(n);
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let i = 0; i < n; i++) {
    const s = restPos[i * 3 + 1] + 0.55 * restPos[i * 3 + 2];   // oblique so the jaw belongs to the head
    w1[i] = ss(-2.0, -0.9, s); w2[i] = ss(-0.75, -0.1, s);
  }
  world.updateMatrixWorld(true);

  // the user's headphone, then our pods on the outer face of each cup
  const hp = buildHeadphone({ hit, attach: headAttach, ears: EAR, headCentre: V(0, 1.9, -0.3).multiplyScalar(S) });
  anchor(headAttach, hp.labelAt, 'phones');
  const faceX = DIM.cup.shellAt + DIM.cup.shellDepth;
  for (const [id, s] of [['L', 1], ['R', -1]]) {
    const pod = buildEarPod(s, 'pod' + id);
    pod.position.set(s * faceX, 0.4, 0); pod.userData.baseX = s * faceX; pod.userData.s = s;
    hp.cups[id].add(pod); pods[id] = pod;
    anchor(pod, V(s * 1.4, 2.4, 0), 'pod' + id);
  }
  addPickables(headAttach);
  rebuildBrace();
  $('loading').hidden = true;
  setView('vBackQ'); applyPose();
}, undefined, () => { $('loading').textContent = 'โหลดโมเดลศีรษะไม่สำเร็จ: เปิดผ่าน scripts/serve.ps1 แล้วลองใหม่'; });

// The brace rests on the shoulders, which the skinning below never moves, so it is built once per width.
function rebuildBrace() {
  if (!bust) return;
  if (brace) {
    brace.group.traverse((o) => { const i = pickables.indexOf(o); if (i >= 0) pickables.splice(i, 1); });
    disposeGroup(brace.group);
  }
  skin(0, 0, 0); world.updateMatrixWorld(true);   // raycast against the rest pose
  brace = buildC7Brace({ hit, width: STRIP_WIDTHS[st.width] });
  world.add(brace.group); addPickables(brace.group);
  for (const id of ['strip', 'box']) if (anchors[id]) anchors[id].removeFromParent();
  anchor(brace.group, brace.stripLabelAt, 'strip');
  anchor(brace.box, brace.boxLabelAt, 'box');
  const spare = brace.stock - brace.used;
  $('lenUsed').textContent = brace.used.toFixed(1) + ' ซม.';
  $('lenSpare').textContent = spare < 0.05 ? 'ใช้เต็มเส้น' : 'ตัดออก ' + spare.toFixed(1) + ' ซม.';
  $('lenWidth').textContent = (brace.width * 10).toFixed(0) + ' มม.';
  lenStat.L.max = lenStat.R.max = 0;
  applyExplode(); applyPose();
}

// ---------- the two ear cables: pod -> C7 box, rebuilt whenever the head moves ----------
const CABLE_STOCK = 50;   // SparkFun Flexible Qwiic Cable, 500 mm
const cableGroup = new THREE.Group(); world.add(cableGroup);
const cableMat = new THREE.MeshPhysicalMaterial({ color: 0x1b1d20, roughness: 0.6, sheen: 0.4, sheenColor: new THREE.Color(0x5c656c) });
const lenStat = { L: { now: 0, max: 0 }, R: { now: 0, max: 0 } };
function pushOut(p, gap) {   // keep a cable point outside the neck
  const c = V(0, p.y, -0.45 * S), d = V(p.x, 0, p.z - c.z);
  const r = d.length(); if (r < 1e-3) return; d.normalize();
  const h = hit(c, d); if (!h) return;
  const rr = Math.hypot(h.p.x - c.x, h.p.z - c.z);
  if (r < rr + gap) { p.x = c.x + d.x * (rr + gap); p.z = c.z + d.z * (rr + gap); }
}
function rebuildCables() {
  for (const m of [...cableGroup.children]) { m.geometry.dispose(); cableGroup.remove(m); }
  if (!brace || !pods.L) return;
  scene.updateMatrixWorld(true);
  for (const id of ['L', 'R']) {
    const pod = pods[id], ex = pod.userData.exit, gl = brace.box.userData.glands[id];
    const a = pod.localToWorld(ex.clone()), a2 = pod.localToWorld(ex.clone().add(V(0, -1.6, -0.5)));
    const end = brace.box.localToWorld(gl.clone()), up = brace.box.localToWorld(gl.clone().add(V(0, 1.7, 0.3)));
    const pts = [a, a2];
    for (const t of [0.3, 0.55, 0.8]) { const p = a2.clone().lerp(up, t); p.z -= 0.6; pushOut(p, 0.7); pts.push(p); }
    pts.push(up, end);
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 140, 0.13, 10), cableMat);
    m.castShadow = true; m.userData.part = 'cable'; cableGroup.add(m);
    lenStat[id].now = curve.getLength();
    if (st.e === 0) lenStat[id].max = Math.max(lenStat[id].max, lenStat[id].now);
    $('len' + id).textContent = lenStat[id].now.toFixed(1) + ' ซม.';
  }
  const mx = Math.max(lenStat.L.max, lenStat.R.max);
  $('lenMax').textContent = mx.toFixed(1) + ' ซม.';
  $('lenLeft').textContent = (CABLE_STOCK - mx).toFixed(1) + ' ซม.';
}

// ---------- wiring bench: real-size boards, pin names, wires ----------
const NET = {
  v33: { name: 'ไฟ 3V3', color: 0xd0312d, css: '--n-3v3' },
  gnd: { name: 'GND', color: 0x26262a, css: '--n-gnd' },
  sda: { name: 'SDA', color: 0x1f63d6, css: '--n-sda' },
  scl: { name: 'SCL', color: 0xe0b000, css: '--n-scl' },
  bat: { name: 'แบต / 5V', color: 0xe5731b, css: '--n-5v' },
  mot: { name: 'มอเตอร์', color: 0x1f9d55, css: '--n-mot' },
};
for (const n of Object.values(NET)) n.mat = new THREE.MeshPhysicalMaterial({ color: n.color, roughness: 0.45, clearcoat: 0.4 });
const netOn = Object.fromEntries(Object.keys(NET).map((k) => [k, true]));
function textSprite(text, color = '#eef4f5', h = 0.26, bg = 'rgba(10,16,18,0.82)') {
  const c = document.createElement('canvas'), ctx = c.getContext('2d');
  const font = '600 44px "IBM Plex Sans Thai", "Leelawadee UI", Tahoma, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 28; c.width = w; c.height = 64;
  ctx.font = font;
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(0, 0, w, 64, 12); ctx.fill();
  ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, 14, 34);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  sp.scale.set(h * w / 64, h, 1); return sp;
}
// id: [maker, x, y, info id, title, title offset y, short name for the table]
const BOARDS = {
  BNOL: [bno085, -12.2, 3.4, 'bnoL', 'BNO085 ซ้าย · 0x4A', 2.25, 'BNO ซ้าย'],
  BNOR: [bno085, 12.2, 3.4, 'bnoR', 'BNO085 ขวา · 0x4B', 2.25, 'BNO ขวา'],
  ESP: [esp32, -2.6, 3.1, 'esp', 'ESP32 DevKit V1 · 30 ขา', 3.0, 'ESP32'],
  GY: [gy521, 4.3, 4.4, 'mpu', 'GY-521 MPU6050 · 0x68', -1.2, 'MPU6050'],
  MOT: [motorModule, 4.5, 0.9, 'mot', 'โมดูลมอเตอร์สั่น', -1.35, 'มอเตอร์สั่น'],
  BAT: [lipo, -5.6, -5.4, 'bat', 'แบต LiPo 3.7V', -2.2, 'LiPo'],
  TP: [tp4056, -1.2, -5.9, 'tp', 'TP4056 ชาร์จ USB-C', -1.25, 'TP4056'],
  SW: [slideSwitch, 2.2, -4.2, 'sw', 'สวิตช์เปิด/ปิด', 0.85, 'สวิตช์'],
  MT: [mt3608, 5.5, -5.9, 'mt', 'MT3608 บูสต์เป็น 5V', -1.25, 'MT3608'],
};
const pinPos = {}, pinLabels = [];
function buildBench() {
  const zoneMat = new THREE.MeshBasicMaterial({ color: 0x9fd8dc, transparent: true, opacity: 0.07, depthWrite: false });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x7fc7cc, transparent: true, opacity: 0.6 });
  const zone = (x0, y0, x1, y1, title) => {
    const w = x1 - x0, h = y1 - y0;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), zoneMat); m.position.set(x0 + w / 2, y0 + h / 2, -1.2); bench.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)), edgeMat); e.position.copy(m.position); bench.add(e);
    const t = textSprite(title, '#9fe3e8', 0.46, 'rgba(10,16,18,0)'); t.position.set(x0 + 0.2 + t.scale.x / 2, y1 - 0.45, 0); bench.add(t);
  };
  zone(-15.4, 0.4, -9.2, 7.8, 'ตลับหูซ้าย');
  zone(9.2, 0.4, 15.4, 7.8, 'ตลับหูขวา');
  zone(-8.4, -8.6, 8.4, 7.8, 'กล่อง C7');
  const note = (txt, x, y) => { const t = textSprite(txt, '#c9d6d9', 0.3, 'rgba(10,16,18,0)'); t.position.set(x, y, 0); bench.add(t); };
  note('← สาย Qwiic 4 เส้น 50 ซม.', -8.9, 8.3); note('สาย Qwiic 4 เส้น 50 ซม. →', 8.9, 8.3);
  note('วงจรแบต: LiPo → ชาร์จ → สวิตช์ → บูสต์ 5V → ขา VIN', 0, -2.55);
  for (const [id, [make, x, y, part, title, ty]] of Object.entries(BOARDS)) {
    const b = make(); b.group.position.set(x, y, 0); bench.add(b.group);
    b.group.traverse((o) => { o.userData.part = part; if (o.isMesh) pickables.push(o); });
    const t = textSprite(title, '#ffffff', 0.3); t.position.set(x, y + ty, 0.3); bench.add(t);
    for (const [k, p] of Object.entries(b.pins)) pinPos[id + '.' + k] = V(x + p.x, y + p.y, p.z);
    for (const l of b.labels) {
      const sp = textSprite(l.n, '#dfe8ea', 0.2); sp.position.set(x + l.x + l.lx, y + l.y + l.ly, 0.5); bench.add(sp);
      sp.material.depthTest = false; sp.renderOrder = 5;   // pin names stay readable through the wires
      pinLabels.push({ sprite: sp, key: id + '.' + l.k });
    }
  }
}
// every wire: [net, from, to, where it runs]
const QL = 'สาย Qwiic ตลับซ้าย → กล่อง', QR = 'สาย Qwiic ตลับขวา → กล่อง', IN_BOX = 'ในกล่อง C7';
const WIRES = [
  ['v33', 'ESP.3V3', 'BNOL.QT2.3V3', QL], ['gnd', 'ESP.GNDR', 'BNOL.QT2.GND', QL], ['sda', 'ESP.D21', 'BNOL.QT2.SDA', QL], ['scl', 'ESP.D22', 'BNOL.QT2.SCL', QL],
  ['v33', 'ESP.3V3', 'BNOR.QT.3V3', QR], ['gnd', 'ESP.GNDR', 'BNOR.QT.GND', QR], ['sda', 'ESP.D21', 'BNOR.QT.SDA', QR], ['scl', 'ESP.D22', 'BNOR.QT.SCL', QR],
  ['v33', 'BNOR.3Vo', 'BNOR.DI', 'สายสั้นบนบอร์ด BNO ขวา (ตั้งที่อยู่ 0x4B)'],
  ['v33', 'ESP.3V3', 'GY.VCC', IN_BOX], ['gnd', 'ESP.GNDR', 'GY.GND', IN_BOX], ['sda', 'ESP.D21', 'GY.SDA', IN_BOX], ['scl', 'ESP.D22', 'GY.SCL', IN_BOX],
  ['v33', 'ESP.3V3', 'MOT.VCC', IN_BOX], ['gnd', 'ESP.GNDR', 'MOT.GND', IN_BOX], ['mot', 'ESP.D25', 'MOT.IN', IN_BOX],
  ['bat', 'BAT.+', 'TP.B+', 'แบต → ชาร์จ'], ['gnd', 'BAT.-', 'TP.B-', 'แบต → ชาร์จ'],
  ['bat', 'TP.OUT+', 'SW.A', 'ชาร์จ → สวิตช์'], ['bat', 'SW.B', 'MT.VIN+', 'สวิตช์ → บูสต์'], ['gnd', 'TP.OUT-', 'MT.VIN-', 'ชาร์จ → บูสต์'],
  ['bat', 'MT.VOUT+', 'ESP.VIN', 'บูสต์ 5V → ESP32'], ['gnd', 'MT.VOUT-', 'ESP.GNDL', 'บูสต์ 5V → ESP32'],
].map(([net, a, b, route]) => ({ net, a, b, route }));
function pinName(k) {
  const i = k.indexOf('.'), bd = k.slice(0, i); let p = k.slice(i + 1);
  if (p.startsWith('QT')) p = 'ช่อง STEMMA QT (' + p.split('.')[1] + ')';
  else if (p === 'GNDL' || p === 'GNDR') p = 'GND (ฝั่ง ' + (p === 'GNDL' ? 'VIN' : '3V3') + ')';
  else if (bd === 'SW') p = p === 'A' ? 'ขาริม' : 'ขากลาง';
  return BOARDS[bd][6] + ' ' + p;
}
const wireGroup = new THREE.Group(); bench.add(wireGroup);
function rebuildBenchWires() {
  for (const m of [...wireGroup.children]) { m.geometry.dispose(); wireGroup.remove(m); }
  const used = new Set();
  WIRES.forEach((w, i) => {
    const A = pinPos[w.a], B = pinPos[w.b]; if (!A || !B) return;
    used.add(w.a); used.add(w.b);
    if (!netOn[w.net]) return;
    const lift = 0.6 + (i % 5) * 0.35 + A.distanceTo(B) * 0.06;
    const curve = new THREE.CubicBezierCurve3(A, A.clone().add(V(0, 0, lift)), B.clone().add(V(0, 0, lift)), B);
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.05, 8), NET[w.net].mat);
    m.castShadow = true; m.userData.part = 'wire'; wireGroup.add(m);
  });
  for (const p of pinLabels) {
    const on = used.has(p.key);
    p.sprite.material.opacity = on ? 1 : 0.45;
    p.sprite.visible = on || st.pinNames;
  }
  dirty = true;
}
function dot(css) { const d = document.createElement('span'); d.className = 'dot'; d.style.background = 'var(' + css + ')'; return d; }
function renderPanel() {
  const t = $('pinTable'); t.innerHTML = '';
  const hr = t.insertRow(); ['สาย', 'จาก', 'ไป', 'อยู่ที่'].forEach((x) => { const th = document.createElement('th'); th.textContent = x; hr.appendChild(th); });
  for (const w of WIRES) {
    const tr = t.insertRow();
    const c0 = tr.insertCell(); c0.style.whiteSpace = 'nowrap'; c0.append(dot(NET[w.net].css), NET[w.net].name);
    tr.insertCell().textContent = pinName(w.a); tr.insertCell().textContent = pinName(w.b);
    const r = tr.insertCell(); r.textContent = w.route; r.className = 'route';
  }
  const nets = $('nets'); nets.innerHTML = '';
  for (const [k, n] of Object.entries(NET)) {
    const l = document.createElement('label'), i = document.createElement('input'); i.type = 'checkbox'; i.checked = netOn[k];
    i.onchange = () => { netOn[k] = i.checked; if (st.mode !== 'pins') setMode('pins'); rebuildBenchWires(); };
    l.append(i, dot(n.css), n.name); nets.appendChild(l);
  }
}
// back the camera off far enough that the whole bench fits the stage at any width
function fitBench() {
  const vf = THREE.MathUtils.degToRad(camera.fov) / 2, hf = Math.atan(Math.tan(vf) * camera.aspect);
  const d = Math.max(9.6 / Math.tan(vf), 16.4 / Math.tan(hf)) * 1.05;
  controls.target.copy(BENCH_AT).add(V(0, -0.2, 0));
  camera.position.copy(controls.target).add(V(0, -0.8, d));
  controls.update(); dirty = true;
}
// zoom in on one board so its silkscreen and pin names can be read
function focusBoard(part) {
  const b = Object.values(BOARDS).find((x) => x[3] === part); if (!b) return;
  const vf = THREE.MathUtils.degToRad(camera.fov) / 2, hf = Math.atan(Math.tan(vf) * camera.aspect);
  const d = Math.max(3.6 / Math.tan(vf), 3.2 / Math.tan(hf));
  controls.target.copy(BENCH_AT).add(V(b[1], b[2], 0));
  camera.position.copy(controls.target).add(V(0, -d * 0.18, d));
  controls.update(); dirty = true;
}
function applyMode() {
  const pinsMode = st.mode === 'pins';
  world.visible = !pinsMode; bench.visible = pinsMode;
  for (const id of ['lenbox', 'poseCard', 'widthCard', 'camSeg', 'wearRow']) $(id).hidden = pinsMode;
  $('benchRow').hidden = !pinsMode;
  $('hint').textContent = pinsMode
    ? 'ผังต่อสาย (บอร์ดขนาดจริง) · ลากเพื่อหมุน · แตะบอร์ดเพื่อซูมเข้าไปอ่านชื่อขา'
    : 'ลากเพื่อหมุน · ล้อเมาส์/สองนิ้วเพื่อซูม · แตะชิ้นส่วนเพื่อดูรายละเอียด';
  if (pinsMode) fitBench(); else setView(st.view);
}

// ---------- skinning on the CPU ----------
const LV = 32, mats1 = [], mats2 = [], nm1 = [], nm2 = [];
for (let i = 0; i <= LV; i++) { mats1.push(new THREE.Matrix4()); mats2.push(new THREE.Matrix4()); nm1.push(new THREE.Matrix3()); nm2.push(new THREE.Matrix3()); }
function jointMatrix(out, pv, e) {
  out.makeTranslation(pv.x, pv.y, pv.z).multiply(new THREE.Matrix4().makeRotationFromEuler(e)).multiply(new THREE.Matrix4().makeTranslation(-pv.x, -pv.y, -pv.z));
}
function skin(pitch, yaw, roll) {
  if (!bust) return;
  const p1 = P1.clone().divideScalar(S), p2 = P2.clone().divideScalar(S);
  for (let i = 0; i <= LV; i++) {
    const f = i / LV;
    jointMatrix(mats1[i], p1, new THREE.Euler(pitch * SHARE1 * f, yaw * SHARE1 * f, roll * SHARE1 * f, 'YXZ'));
    jointMatrix(mats2[i], p2, new THREE.Euler(pitch * SHARE2 * f, yaw * SHARE2 * f, roll * SHARE2 * f, 'YXZ'));
    nm1[i].setFromMatrix4(mats1[i]); nm2[i].setFromMatrix4(mats2[i]);
  }
  const pos = bust.geometry.attributes.position, nrm = bust.geometry.attributes.normal;
  const pa = pos.array, na = nrm.array, v = V(), nn = V();
  for (let i = 0; i < pos.count; i++) {
    const a = Math.round(w1[i] * LV), b = Math.round(w2[i] * LV), k = i * 3;
    v.set(restPos[k], restPos[k + 1], restPos[k + 2]).applyMatrix4(mats2[b]).applyMatrix4(mats1[a]);
    nn.set(restNrm[k], restNrm[k + 1], restNrm[k + 2]).applyMatrix3(nm2[b]).applyMatrix3(nm1[a]);
    pa[k] = v.x; pa[k + 1] = v.y; pa[k + 2] = v.z; na[k] = nn.x; na[k + 1] = nn.y; na[k + 2] = nn.z;
  }
  pos.needsUpdate = true; nrm.needsUpdate = true;
  bust.geometry.computeBoundingSphere();
}

// ---------- views ----------
function setView(id) {
  st.view = id;
  // narrow stages (phones) need the camera further back to keep the shoulders in view
  const back = Math.max(1, 1.2 / camera.aspect);
  controls.target.copy(TARGET);
  camera.position.copy(VIEWS[id]).multiplyScalar(back).add(TARGET);
  controls.update(); dirty = true;
}
// exploded view: our parts slide away from the user's headphone and from the body
function applyExplode() {
  const e = st.e * st.e * (3 - 2 * st.e);
  for (const pod of Object.values(pods)) pod.position.x = pod.userData.baseX + pod.userData.s * 5 * e;
  if (brace) {
    brace.group.position.set(0, 0, -9 * e);
    brace.box.position.copy(brace.box.userData.base).addScaledVector(brace.box.userData.out, 4 * e);
  }
  rebuildCables();
  dirty = true;
}
function applyPose() {
  if (!bust) return;
  const r = THREE.MathUtils.degToRad, p = r(st.pitch), y = r(st.yaw), z = r(st.roll);
  rig1.rotation.set(p * SHARE1, y * SHARE1, z * SHARE1);
  rig2.rotation.set(p * SHARE2, y * SHARE2, z * SHARE2);
  skin(p, y, z);
  rebuildCables();
  dirty = true;
}

// ---------- panel ----------
const INFO = {
  phones: ['หูฟังครอบหูของคุณ', [
    'ใช้หูฟังครอบหูที่มีอยู่ได้เลย ไม่ต้องแกะหรือดัดแปลงตัวหูฟัง',
    'โมเดลนี้เป็นหูฟังครอบหูทั่วไป ฝาครอบสูงราว 10 ซม. หูฟังจริงของคุณอาจรูปร่างต่างออกไป',
    'ด้านนอกฝาครอบต้องมีพื้นที่ค่อนข้างเรียบอย่างน้อย 3.5 × 3 ซม. สำหรับแปะตลับเซ็นเซอร์',
  ]],
  podL: ['ตลับเซ็นเซอร์ ข้างซ้าย', [
    'ข้างในจะมี BNO085 1 ตัว (I2C 0x4A) วัดมุมศีรษะ',
    'ขนาดราว 34 × 30 × 9 มม. แปะด้านนอกฝาครอบหูด้วยแผ่นตีนตุ๊กแกหรือเทปกาวสองหน้า ถอดออกได้',
    'ลูกศรบนตลับต้องชี้ไปด้านหน้าทุกครั้งที่แปะ',
    'ปุ่มยางมุมล่างด้านหลังคือจุดที่สายจะออก (เพิ่มสายในรอบถัดไป)',
  ]],
  podR: ['ตลับเซ็นเซอร์ ข้างขวา', [
    'ข้างในจะมี BNO085 1 ตัว (I2C 0x4B) วัดมุมศีรษะ',
    'ขนาดและวิธีแปะเหมือนข้างซ้าย',
    'ลูกศรบนตลับต้องชี้ไปด้านหน้าทุกครั้งที่แปะ',
  ]],
  strip: ['โครงพาดบ่า (ที่ดามนิ้วอะลูมิเนียม)', [
    'ใช้ที่ดามนิ้วแบบตัด ยาว 18 นิ้ว (45.7 ซม.) 1 เส้น ดัดด้วยมือให้เข้ากับบ่าของผู้ใช้',
    'พาดจากใต้ไหปลาร้าข้างหนึ่ง ข้ามบ่าชิดโคนคอ อ้อมหลังคอ แล้วลงไปใต้ไหปลาร้าอีกข้าง',
    'ด้านฟองน้ำแนบผิว น้ำหนักปลายทั้งสองข้างถ่วงให้กล่องอยู่ตรง C7',
    'ความหนาแถบและฟองน้ำรองเป็นค่าที่สมมติไว้ ต้องวัดจากของจริง',
  ]],
  box: ['กล่อง C7', [
    'หนีบอยู่กลางแถบ ตรงปุ่มกระดูก C7 ที่โคนคอด้านหลัง',
    'ขนาดราว 76 × 50 × 22 มม. ข้างในมี ESP32 DevKit, แบต LiPo, TP4056, MT3608, GY-521 และโมดูลมอเตอร์สั่น',
    'ช่องชาร์จ USB-C อยู่ด้านล่าง ปุ่มยาง 2 จุดด้านบนคือจุดที่สายจากตลับข้างหูเข้า',
    'ดูการต่อขาทั้งหมดได้ในมุมมอง "ผังต่อสาย"',
  ]],
  cable: ['สายตลับข้างหู → กล่อง C7', [
    'ข้างละ 1 เส้น: สาย Qwiic / STEMMA QT 4 เส้น (แดง 3V3, ดำ GND, น้ำเงิน SDA, เหลือง SCL)',
    'ปลายบนเสียบช่อง STEMMA QT ของ BNO085 ได้เลย ปลายล่างตัดหัวออกแล้วบัดกรีที่กล่อง',
    'กล่องมุมขวาบนแสดงความยาวที่ใช้ขณะขยับศีรษะ เทียบกับสายยาว 50 ซม.',
  ]],
  wire: ['สายในผัง', ['สีตามชนิดสาย: แดง 3V3, ดำ GND, น้ำเงิน SDA, เหลือง SCL, ส้ม แบต/5V, เขียว มอเตอร์', 'ดูต้นทางและปลายทางของทุกเส้นได้ในตารางต่อสาย']],
  esp: ['ESP32 DevKit V1 (30 ขา)', [
    'I2C: D21 = SDA, D22 = SCL ใช้ร่วมกันทั้ง BNO085 2 ตัวและ MPU6050 (ตรงกับเฟิร์มแวร์ตอนนี้)',
    'D25 สั่งมอเตอร์สั่น · ขา 3V3 จ่ายไฟให้เซ็นเซอร์ทุกตัว',
    'รับไฟ 5V จาก MT3608 ที่ขา VIN และ GND ฝั่งเดียวกัน',
    'ขา 3V3 และ GND มีสายหลายเส้น ให้รวมสายที่จุดเดียวแล้วต่อเข้าขา',
  ]],
  bnoL: ['BNO085 ซ้าย (Adafruit #4754)', ['ที่อยู่ I2C 0x4A: ขา DI ปล่อยว่าง', 'ต่อด้วยสาย Qwiic เสียบช่อง STEMMA QT ช่องใดก็ได้ (2 ช่องต่อถึงกัน)', 'ขาแถวบนและล่างไม่ต้องบัดกรี']],
  bnoR: ['BNO085 ขวา (Adafruit #4754)', ['ที่อยู่ I2C 0x4B: บัดกรีสายสั้นจากขา 3Vo ไปขา DI', 'ต่อด้วยสาย Qwiic เสียบช่อง STEMMA QT ช่องใดก็ได้']],
  mpu: ['GY-521 (MPU6050)', ['ที่อยู่ I2C 0x68: ขา AD0 ปล่อยว่าง', 'ต่อ 4 ขา: VCC ← 3V3, GND, SCL ← D22, SDA ← D21', 'ขา XDA, XCL, INT ไม่ได้ใช้']],
  mot: ['โมดูลมอเตอร์สั่น', ['3 ขา: VCC ← 3V3, GND, IN ← D25', 'ลำดับขาและขนาดต่างกันตามร้าน ให้ดูชื่อขาบนบอร์ดที่ซื้อมา']],
  bat: ['แบต LiPo 3.7 V', ['แบบ 1 เซลล์ มีวงจรป้องกันในตัว เช่น 503035 500 mAh (35 × 30 × 5 มม.)', 'สายแดง → B+ และสายดำ → B- ของ TP4056', 'ห้ามต่อแบตเข้า ESP32 โดยตรง']],
  tp: ['TP4056 (ชาร์จ USB-C มีวงจรป้องกัน)', ['B+ / B- ต่อแบต · OUT+ / OUT- จ่ายไฟออก', 'ชาร์จแบตผ่านช่อง USB-C ของบอร์ดนี้', 'ต้องเป็นรุ่นที่มีขา OUT+ / OUT- (มีชิป DW01 ป้องกันแบตหมดเกิน)']],
  sw: ['สวิตช์เลื่อน', ['คั่นสาย OUT+ ระหว่าง TP4056 กับ MT3608', 'ปิดสวิตช์ก่อนเสียบ USB เข้า ESP32 เพื่อไม่ให้ไฟ 2 ทางจ่ายพร้อมกัน']],
  mt: ['MT3608 (บูสต์เป็น 5 V)', ['VIN+ / VIN- รับไฟแบต 3.0–4.2 V · VOUT+ / VOUT- ไปขา VIN / GND ของ ESP32', 'หมุนตัวปรับสีน้ำเงินให้ VOUT = 5.0 V และวัดด้วยมิเตอร์ก่อนต่อเข้า ESP32']],
};
const INFO_EMPTY = ['แตะชิ้นส่วนในโมเดล', 'เลือกหูฟัง ตลับเซ็นเซอร์ข้างหู แถบพาดบ่า หรือกล่อง C7 เพื่อดูรายละเอียด'];
function showInfo(id) {
  document.querySelectorAll('.tag').forEach((el) => el.dataset.on = el.dataset.id === id ? '1' : '0');
  const box = $('info'); box.innerHTML = '';
  const h = document.createElement('h3'); box.appendChild(h);
  if (!id || !INFO[id]) { h.textContent = INFO_EMPTY[0]; const p = document.createElement('p'); p.textContent = INFO_EMPTY[1]; box.appendChild(p); return; }
  const [t, items] = INFO[id];
  h.textContent = t;
  const ul = document.createElement('ul');
  for (const s of items) { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li); }
  box.appendChild(ul);
}

// ---------- HTML labels ----------
const LABELS = [['phones', 'หูฟังของคุณ'], ['podL', 'ตลับเซ็นเซอร์ซ้าย'], ['podR', 'ตลับเซ็นเซอร์ขวา'], ['strip', 'แถบที่ดามนิ้ว'], ['box', 'กล่อง C7']];
const tagEls = {};
for (const [id, txt] of LABELS) {
  const el = document.createElement('button'); el.className = 'tag'; el.textContent = txt; el.dataset.id = id; el.hidden = true;
  if (id !== 'phones') el.dataset.ours = '1';
  el.addEventListener('click', () => showInfo(id));
  $('labels').appendChild(el); tagEls[id] = el;
}
const tmp = V(), camDir = V();
function placeTags() {
  const w = stage.clientWidth, h = stage.clientHeight;
  camera.getWorldDirection(camDir);
  for (const [id] of LABELS) {
    const el = tagEls[id], a = anchors[id];
    if (!a || !st.tags || st.mode === 'pins') { el.hidden = true; continue; }
    a.getWorldPosition(tmp);
    if (tmp.clone().sub(camera.position).dot(camDir) < 0) { el.hidden = true; continue; }
    tmp.project(camera);
    el.hidden = false;
    el.style.left = ((tmp.x + 1) / 2 * w) + 'px';
    el.style.top = ((1 - tmp.y) / 2 * h - 10) + 'px';
  }
}

// ---------- picking ----------
const pick = new THREE.Raycaster(), ndc = new THREE.Vector2();
let downAt = null;
const shown = (o) => { while (o) { if (!o.visible) return false; o = o.parent; } return true; };
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  pick.setFromCamera(ndc, camera);
  const list = pickables.concat(cableGroup.children, wireGroup.children, bust ? [bust] : []);
  const hits = pick.intersectObjects(list, false).filter((hh) => shown(hh.object));
  const part = hits.length ? hits[0].object.userData.part || null : null;
  showInfo(part);
  if (st.mode === 'pins' && part) focusBoard(part);
});

// ---------- UI ----------
function press(ids, on) { for (const id of ids) $(id).setAttribute('aria-pressed', id === on); }
function setMode(m) {
  const was = st.mode; st.mode = m;
  press(['mWear', 'mExplode', 'mPins'], { wear: 'mWear', explode: 'mExplode', pins: 'mPins' }[m]);
  if ((was === 'pins') !== (m === 'pins')) applyMode();
  dirty = true;
}
$('mWear').onclick = () => setMode('wear');
$('mExplode').onclick = () => setMode('explode');
$('mPins').onclick = () => setMode('pins');
$('fitAll').onclick = fitBench;
$('pinNames').onchange = (e) => { st.pinNames = e.target.checked; rebuildBenchWires(); };
for (const id of Object.keys(VIEWS)) $(id).onclick = () => setView(id);
for (const [id, k] of [['wHalf', 'half'], ['wThree', 'three'], ['wOne', 'one']]) {
  $(id).onclick = () => { st.width = k; press(['wHalf', 'wThree', 'wOne'], id); rebuildBrace(); };
}
$('person').onchange = (e) => { st.person = e.target.checked; if (bust) bust.visible = st.person; dirty = true; };
$('tags').onchange = (e) => { st.tags = e.target.checked; dirty = true; };
for (const k of ['Pitch', 'Yaw', 'Roll']) {
  $('s' + k).addEventListener('input', (e) => { stopAuto(); st[k.toLowerCase()] = +e.target.value; syncSliders(); applyPose(); });
}
function syncSliders() { for (const k of ['Pitch', 'Yaw', 'Roll']) { const v = Math.round(st[k.toLowerCase()]); $('s' + k).value = v; $('v' + k).textContent = v + '°'; } }
function stopAuto() { st.auto = false; $('auto').textContent = 'ขยับอัตโนมัติ'; }
$('auto').onclick = () => { if (st.auto) return stopAuto(); st.auto = true; st.t0 = performance.now(); $('auto').textContent = 'หยุด'; };
$('reset').onclick = () => { stopAuto(); st.pitch = st.yaw = st.roll = 0; syncSliders(); applyPose(); };

// ---------- loop: render only when something changed ----------
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
  if (st.mode === 'pins') fitBench();
}
new ResizeObserver(resize).observe(stage); resize();
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const goal = st.mode === 'explode' ? 1 : 0;
  if (st.e !== goal) {
    st.e = reduced.matches ? goal : THREE.MathUtils.clamp(st.e + Math.sign(goal - st.e) * dt / 0.45, 0, 1);
    applyExplode();
  }
  if (st.auto && bust && st.mode !== 'pins') {
    const t = (now - st.t0) / 1000 * (reduced.matches ? 0.4 : 1);
    st.pitch = 12 + 24 * Math.sin(t * 0.7); st.yaw = 60 * Math.sin(t * 0.45); st.roll = 18 * Math.sin(t * 0.9 + 1);
    syncSliders(); applyPose();
  }
  controls.update();
  if (dirty) { dirty = false; renderer.render(scene, camera); placeTags(); }
  requestAnimationFrame(frame);
}
showInfo(null); syncSliders();
requestAnimationFrame(frame);
// board silkscreen and labels are drawn on canvases, so wait for the local fonts first
try { await Promise.all([document.fonts.load('600 44px "IBM Plex Sans Thai"', 'กขค ABC'), document.fonts.load('700 24px "IBM Plex Mono"', 'ABC 123')]); } catch { /* fall back to system fonts */ }
buildBench(); renderPanel(); rebuildBenchWires();
