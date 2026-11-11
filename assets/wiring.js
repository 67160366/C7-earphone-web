// Over-ear headset wiring model: real head scan + real-size parts + pin-level bench view.
// Offline: vendored Three.js, no CDN. Units are centimetres.
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';

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
controls.enableDamping = true; controls.minDistance = 6; controls.maxDistance = 160;
const HEAD_VIEW = { pos: V(-46, 20, -40), target: V(0, 2.5, -2) };
const BENCH_AT = V(300, 0, 0);
const BENCH_VIEW = { pos: V(301.5, -3.5, 43), target: V(301.5, -2.5, 0) };
camera.position.copy(HEAD_VIEW.pos); controls.target.copy(HEAD_VIEW.target); controls.update();

const key = new THREE.DirectionalLight(0xfff1e2, 2.6);
key.position.set(-25, 40, 22); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
Object.assign(key.shadow.camera, { left: -22, right: 22, top: 24, bottom: -18, near: 1, far: 120 });
scene.add(key);
const rim = new THREE.DirectionalLight(0xcfe8ff, 1.6); rim.position.set(30, 18, -40); scene.add(rim);
const benchLight = new THREE.DirectionalLight(0xffffff, 2.2); benchLight.position.set(295, 10, 40); benchLight.target.position.copy(BENCH_AT); scene.add(benchLight, benchLight.target);

const headWorld = new THREE.Group(); scene.add(headWorld);   // everything on the person
const bench = new THREE.Group(); bench.position.copy(BENCH_AT); scene.add(bench); bench.visible = false;

// ---------- materials ----------
const phys = (o) => new THREE.MeshPhysicalMaterial(o);
const M = {
  shell: phys({ color: 0x1c1f23, roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.35, transparent: true }),
  metal: phys({ color: 0xaeb4ba, roughness: 0.3, metalness: 1, transparent: true }),
  leather: phys({ color: 0x18181a, roughness: 0.62, sheen: 0.6, sheenColor: new THREE.Color(0x5a5a60), transparent: true }),
  baffle: phys({ color: 0x2c3036, roughness: 0.8, transparent: true }),
  grille: phys({ color: 0x3a3f45, roughness: 0.9, transparent: true }),
  driver: phys({ color: 0x35383d, roughness: 0.5, metalness: 0.2 }),
  magnet: phys({ color: 0x9aa0a6, roughness: 0.3, metalness: 1 }),
  pcbBlack: new THREE.MeshStandardMaterial({ color: 0x141619, roughness: 0.45 }),
  pcbBlue: new THREE.MeshStandardMaterial({ color: 0x1b4e9b, roughness: 0.45 }),
  pcbGreen: new THREE.MeshStandardMaterial({ color: 0x1f6a3c, roughness: 0.5 }),
  chip: new THREE.MeshStandardMaterial({ color: 0x0c0d0f, roughness: 0.3 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd4a94a, roughness: 0.3, metalness: 1 }),
  can: new THREE.MeshStandardMaterial({ color: 0xcfd3d6, roughness: 0.28, metalness: 1 }),
  foil: new THREE.MeshStandardMaterial({ color: 0xc4c9cc, roughness: 0.38, metalness: 0.75 }),
  jst: new THREE.MeshStandardMaterial({ color: 0xeee8d6, roughness: 0.55 }),
  jacket: phys({ color: 0x232629, roughness: 0.6, sheen: 0.4, sheenColor: new THREE.Color(0x5c656c) }),
  zone: new THREE.MeshBasicMaterial({ color: 0x9fd8dc, transparent: true, opacity: 0.07, depthWrite: false }),
  zoneEdge: new THREE.LineBasicMaterial({ color: 0x7fc7cc, transparent: true, opacity: 0.6 }),
};
const NET = {
  v33: { name: 'ไฟ 3V3', color: 0xd0312d, css: '--n-3v3' },
  gnd: { name: 'GND', color: 0x2a2a2e, css: '--n-gnd' },
  sda: { name: 'SDA', color: 0x1f63d6, css: '--n-sda' },
  scl: { name: 'SCL', color: 0xd99a00, css: '--n-scl' },
  v5: { name: 'ไฟ 5V / แบต', color: 0xe5731b, css: '--n-5v' },
  mot: { name: 'มอเตอร์', color: 0x1f9d55, css: '--n-mot' },
};
for (const n of Object.values(NET)) n.mat = phys({ color: n.color, roughness: 0.45, clearcoat: 0.4 });
const shellMats = [M.shell, M.metal, M.leather, M.baffle, M.grille];

function mesh(geo, mat, parent, pos, rot) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.copy(pos);
  if (rot) m.rotation.set(...rot);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m); return m;
}
function roundRectShape(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function roundedBox(w, h, d, r) {
  const g = new THREE.ExtrudeGeometry(roundRectShape(w - 2 * r, h - 2 * r, 0.001), { depth: Math.max(d - 2 * r, 0.001), bevelEnabled: true, bevelSize: r * 0.95, bevelThickness: r, bevelSegments: 5, curveSegments: 8 });
  g.translate(0, 0, -(d - 2 * r) / 2); g.computeVertexNormals(); return g;
}
function ellipseShape(ry, rz, hole) {
  const s = new THREE.Shape(); s.absellipse(0, 0, rz, ry, 0, Math.PI * 2, false, 0);
  if (hole) { const h = new THREE.Path(); h.absellipse(0, 0, hole[1], hole[0], 0, Math.PI * 2, true, 0); s.holes.push(h); }
  return s;
}
// extrude a (z,y) profile outward along ±X, starting at x = 0 of the parent
function extrudeX(shape, depth, bevel, s) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(depth - 2 * bevel, 0.001), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 6, curveSegments: 64 });
  g.translate(0, 0, bevel);
  g.rotateY(s > 0 ? Math.PI / 2 : -Math.PI / 2);
  g.computeVertexNormals(); return g;
}

const pickables = [];
function tagPart(obj, id) { obj.traverse((o) => { if (o.isMesh) { o.userData.part = id; pickables.push(o); } }); }
const anchors = {};
function anchor(parent, pos, id, mode) { const o = new THREE.Object3D(); o.position.copy(pos); parent.add(o); anchors[id] = { o, mode }; return o; }
const insideParts = [];   // visible only in the see-through view

// ---------- head-and-neck rig (two joints, matches the vertex skinning below) ----------
const P1 = V(0, -1.3, -0.6).multiplyScalar(S);
const P2 = V(0, 0.85, -0.25).multiplyScalar(S);
const rig1 = new THREE.Group(); rig1.position.copy(P1); rig1.rotation.order = 'YXZ'; headWorld.add(rig1);
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
const st = { mode: 'wear', bus: 'one', pitch: 0, yaw: 0, roll: 0, auto: false, t0: 0, tags: true, pinNames: true };

// ---------- load the scan ----------
const texLoader = new THREE.TextureLoader();
const colorMap = texLoader.load('assets/models/head/Map-COL.jpg'); colorMap.colorSpace = THREE.SRGBColorSpace; colorMap.anisotropy = 8;
const normalMap = texLoader.load('assets/models/head/Infinite-Level_02_Tangent_SmoothUV.jpg');
new GLTFLoader().load('assets/models/head/LeePerrySmith.glb', (gltf) => {
  bust = gltf.scene.getObjectByName('LeePerrySmith');
  bust.material = phys({
    map: colorMap, normalMap, normalScale: new THREE.Vector2(0.7, 0.7),
    roughness: 0.52, sheen: 0.35, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xff9c80),
    clearcoat: 0.06, clearcoatRoughness: 0.6, side: THREE.DoubleSide,
  });
  bust.scale.setScalar(S); bust.castShadow = true; bust.receiveShadow = true;
  headWorld.add(bust); bust.updateMatrixWorld(true);
  const g = bust.geometry;
  restPos = g.attributes.position.array.slice(); restNrm = g.attributes.normal.array.slice();
  const n = g.attributes.position.count; w1 = new Float32Array(n); w2 = new Float32Array(n);
  const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  for (let i = 0; i < n; i++) {
    const s = restPos[i * 3 + 1] + 0.55 * restPos[i * 3 + 2];   // oblique so the jaw belongs to the head
    w1[i] = ss(-2.0, -0.9, s); w2[i] = ss(-0.75, -0.1, s);
  }
  headWorld.updateMatrixWorld(true);
  buildHeadset();
  buildPod();
  $('loading').hidden = true;
  applyMode(); applyPose();
}, undefined, () => { $('loading').textContent = 'โหลดโมเดลศีรษะไม่สำเร็จ: เปิดผ่าน scripts/serve.ps1 แล้วลองใหม่'; });

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

// ---------- twisted multi-core cable ----------
function twisted(parent, curve, nets, partId, layRadius = 0.07, wireR = 0.045) {
  const L = curve.getLength(), n = Math.max(30, Math.round(L * 10));
  const frames = curve.computeFrenetFrames(n, false), out = [];
  nets.forEach((net, k) => {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n, th = (u * L) / 1.6 * Math.PI * 2 + k * Math.PI * 2 / nets.length;
      pts.push(curve.getPointAt(u).add(frames.normals[i].clone().multiplyScalar(Math.cos(th) * layRadius)).add(frames.binormals[i].clone().multiplyScalar(Math.sin(th) * layRadius)));
    }
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n * 2, wireR, 6), NET[net].mat);
    m.userData.part = partId; parent.add(m); out.push(m);
  });
  return out;
}

// ---------- the headset ----------
const EAR = { L: V(7.35, 6.38, -0.22), R: V(-8.0, 6.34, -0.22) };
const sides = { L: 1, R: -1 };
const CUP = { ry: 5.0, rz: 4.2 };
const cupInfo = {};
let c7Exit = null;

function buildHeadset() {
  const tops = {};
  for (const [id, s] of Object.entries(sides)) {
    const e = EAR[id];
    const cy = e.y + 0.2, cz = e.z - 0.35;
    // cushion plane: just outside the skull around the ear (ring of rays)
    let c = 0;
    for (let k = 0; k < 10; k++) {
      const a = k / 10 * Math.PI * 2, y = cy + Math.sin(a) * 4.4, z = cz + Math.cos(a) * 3.6;
      const h = hit(V(0, y, z), V(s, 0, 0));
      if (h) c = Math.max(c, Math.abs(h.p.x));
    }
    c += 0.15;
    const g = new THREE.Group(); g.position.set(s * c, cy, cz); headAttach.add(g);
    cupInfo[id] = { group: g, c, cy, cz };
    // ear cushion (protein-leather ring) 22 mm thick
    mesh(extrudeX(ellipseShape(CUP.ry - 0.15, CUP.rz - 0.15, [3.15, 2.5]), 2.2, 0.75, s), M.leather, g);
    // baffle with the 40 mm driver behind a cloth grille
    mesh(extrudeX(ellipseShape(CUP.ry - 0.5, CUP.rz - 0.5), 0.25, 0, s), M.baffle, g, V(s * 1.9, 0, 0));
    mesh(new THREE.CylinderGeometry(2.0, 2.0, 0.08, 48), M.grille, g, V(s * 1.86, 0, 0), [0, 0, Math.PI / 2]);
    const drv = mesh(new THREE.CylinderGeometry(2.0, 1.6, 0.55, 48), M.driver, g, V(s * 2.4, 0, 0), [0, 0, Math.PI / 2]);
    const mag = mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.5, 32), M.magnet, g, V(s * 2.9, 0, 0), [0, 0, Math.PI / 2]);
    insideParts.push(drv, mag);
    // closed-back shell and an aluminium cap ring
    mesh(extrudeX(ellipseShape(CUP.ry, CUP.rz), 3.0, 0.9, s), M.shell, g, V(s * 2.15, 0, 0));
    const ring = mesh(new THREE.TorusGeometry(1, 0.06, 10, 96), M.metal, g, V(s * 5.18, 0, 0), [0, Math.PI / 2, 0]);
    ring.scale.set(3.4, 4.1, 1);
    tagPart(g, 'cup' + id);

    // electronics inside the shell (x from 2.7 to 4.8)
    const inner = new THREE.Group(); g.add(inner); insideParts.push(inner);
    const bno = new THREE.Group(); inner.add(bno);
    // BNO085 breakout (25.6 x 22.7 mm), top-back, about 3 cm from the driver magnet
    const bnoY = 2.55, bnoZ = -1.45;
    mesh(new THREE.BoxGeometry(0.16, 2.27, 2.56), M.pcbBlack, bno, V(s * 3.35, bnoY, bnoZ));
    mesh(new THREE.BoxGeometry(0.12, 0.38, 0.52), M.chip, bno, V(s * 3.45, bnoY + 0.15, bnoZ));
    for (const zz of [-1.0, 1.0]) mesh(new THREE.BoxGeometry(0.29, 0.6, 0.43), M.jst, bno, V(s * 3.5, bnoY - 0.8, bnoZ + zz));
    tagPart(bno, 'bno' + id);
    anchor(bno, V(s * 3.6, bnoY + 1.5, bnoZ), 'bno' + id, 'xray');
    if (id === 'L') {
      // ESP32-DevKitC 54.4 x 27.9 mm standing upright toward the front
      const ey = -0.3, ez = 1.55;
      const esp = new THREE.Group(); inner.add(esp);
      mesh(new THREE.BoxGeometry(0.16, 5.44, 2.79), M.pcbBlack, esp, V(s * 3.75, ey, ez));
      mesh(new THREE.BoxGeometry(0.3, 1.75, 1.6), M.can, esp, V(s * 3.95, ey + 1.6, ez));
      mesh(new THREE.BoxGeometry(0.28, 0.55, 0.75), M.can, esp, V(s * 3.95, ey - 2.55, ez));
      tagPart(esp, 'esp');
      anchor(esp, V(s * 4.0, ey + 0.4, ez + 1.2), 'esp', 'xray');
      // the bottom-back gland is the C7 cable exit
      const gland = mesh(new THREE.CylinderGeometry(0.42, 0.32, 1.0, 20), M.leather, g, V(s * 3.4, -4.75, -1.7), [0.35, 0, 0]);
      tagPart(gland, 'c7cable');
      c7Exit = new THREE.Object3D(); c7Exit.position.set(s * 3.4, -5.25, -1.9); g.add(c7Exit);
    } else {
      // power: LiPo 35 x 30 x 5 mm, TP4056 (USB-C) and MT3608 boost
      const pw = new THREE.Group(); inner.add(pw);
      mesh(roundedBox(0.5, 3.5, 3.0, 0.12), M.foil, pw, V(s * 4.25, -1.6, 0.4));
      mesh(new THREE.BoxGeometry(0.16, 1.7, 2.6), M.pcbBlue, pw, V(s * 3.55, -1.0, 1.4));
      mesh(new THREE.BoxGeometry(0.16, 1.7, 3.6), M.pcbBlue, pw, V(s * 3.55, -3.0, 0.2));
      mesh(new THREE.BoxGeometry(0.4, 0.35, 0.9), M.can, pw, V(s * 3.4, -4.7, 1.2));   // USB-C port at the cup bottom
      tagPart(pw, 'power');
      anchor(pw, V(s * 4.4, -1.0, 0.4), 'power', 'xray');
    }
    // yoke: aluminium fork around the cup with pivots front and back
    const yk = [];
    for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI; yk.push(V(s * 3.7, Math.sin(a) * (CUP.ry + 0.55), Math.cos(a) * (CUP.rz + 0.55))); }
    const yoke = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(yk), 60, 0.3, 14), M.metal, g);
    for (const z of [1, -1]) mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.5, 24), M.metal, g, V(s * 3.5, 0, z * (CUP.rz + 0.5)), [Math.PI / 2, 0, 0]);
    tagPart(yoke, 'cup' + id);
    g.updateMatrixWorld(true);
    tops[id] = g.localToWorld(V(s * 3.7, CUP.ry + 0.55, 0));
    anchor(g, V(s * 5.6, 3.6, 2.2), 'cup' + id, 'wear');
  }
  // headband: steel band with a padded underside, following the skull
  const hc = V(0, 1.9, -0.3).multiplyScalar(S);
  const arc = [], pad = [];
  for (let d = 58; d >= -58; d -= 8) {
    const a = THREE.MathUtils.degToRad(d), dir = V(Math.sin(a), Math.cos(a), 0);
    const h = hit(hc, dir);
    arc.push(h.p.clone().add(dir.clone().multiplyScalar(2.3)));
    pad.push(h.p.clone().add(dir.clone().multiplyScalar(1.35)));
  }
  const toLocal = (p) => headAttach.worldToLocal(p.clone());
  const bandPts = [tops.L, tops.L.clone().add(V(0, 1.6, 0)), ...arc, tops.R.clone().add(V(0, 1.6, 0)), tops.R].map(toLocal);
  const bandCurve = new THREE.CatmullRomCurve3(bandPts, false, 'centripetal');
  const band = mesh(new THREE.ExtrudeGeometry(roundRectShape(0.45, 3.0, 0.2), { steps: 200, bevelEnabled: false, extrudePath: bandCurve }), M.shell, headAttach);
  const padCurve = new THREE.CatmullRomCurve3(pad.map(toLocal), false, 'centripetal');
  const padM = mesh(new THREE.ExtrudeGeometry(roundRectShape(0.75, 2.6, 0.35), { steps: 140, bevelEnabled: false, extrudePath: padCurve }), M.leather, headAttach);
  tagPart(band, 'band'); tagPart(padM, 'band');
  anchor(headAttach, bandCurve.getPointAt(0.5).add(V(0, 1.4, 0)), 'band', 'all');
  // 5-core cable inside the band (5V, GND, 3V3, SDA, SCL)
  const inBand = new THREE.Group(); headAttach.add(inBand); insideParts.push(inBand);
  const cupTop = (id) => cupInfo[id].group.localToWorld(V(sides[id] * 3.6, CUP.ry - 0.6, 0));
  const wirePath = new THREE.CatmullRomCurve3([cupTop('L'), tops.L.clone().add(V(0, 0.6, 0)), ...arc, tops.R.clone().add(V(0, 0.6, 0)), cupTop('R')].map(toLocal), false, 'centripetal');
  twisted(inBand, wirePath, ['v5', 'gnd', 'v33', 'sda', 'scl'], 'band', 0.08, 0.04);
}

// C7 pod with the MPU6050, coin motor and motor driver
let podEntry = null, podUp = null;
function buildPod() {
  const h = hit(V(0, -1.5 * S, -0.4 * S), V(0, 0, -1));
  const pod = new THREE.Group();
  pod.position.copy(h.p).add(h.n.clone().multiplyScalar(0.6));
  pod.lookAt(pod.position.clone().add(h.n));
  headWorld.add(pod); pod.updateMatrixWorld(true);
  mesh(roundedBox(3.4, 2.8, 1.1, 0.4), M.shell, pod);
  const inner = new THREE.Group(); pod.add(inner); insideParts.push(inner);
  mesh(new THREE.BoxGeometry(2.1, 1.6, 0.16), M.pcbBlue, inner, V(-0.45, -0.2, -0.25));
  mesh(new THREE.BoxGeometry(0.4, 0.4, 0.09), M.chip, inner, V(-0.45, -0.2, -0.13));
  mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.27, 28), M.can, inner, V(1.05, 0.55, -0.25), [Math.PI / 2, 0, 0]);
  mesh(new THREE.BoxGeometry(0.9, 0.7, 0.16), M.pcbGreen, inner, V(1.05, -0.6, 0.15));
  mesh(new THREE.CylinderGeometry(0.28, 0.24, 0.6, 16), M.leather, pod, V(-1.3, 1.6, 0), [0, 0, 0.4]);
  tagPart(pod, 'pod');
  anchor(pod, V(0.6, 1.9, 0.4), 'pod', 'all');
  anchor(inner, V(-0.45, -0.2, -0.1), 'mpu', 'xray');
  podEntry = pod.localToWorld(V(-1.45, 1.9, 0));
  podUp = pod.localToWorld(V(-2.0, 3.4, 0.2));
}

// ---------- the only free cable: left cup -> C7 ----------
const c7Group = new THREE.Group(); headWorld.add(c7Group);
const lenStat = { now: 0, max: 0 };
function pushOut(p, gap) {
  const c = V(0, p.y, -0.45 * S), d = V(p.x, 0, p.z - c.z);
  const r = d.length(); if (r < 1e-3) return; d.normalize();
  const h = hit(c, d); if (!h) return;
  const rr = Math.hypot(h.p.x - c.x, h.p.z - c.z);
  if (r < rr + gap) { p.x = c.x + d.x * (rr + gap); p.z = c.z + d.z * (rr + gap); }
}
function rebuildC7Cable() {
  for (const m of [...c7Group.children]) { m.geometry.dispose(); c7Group.remove(m); }
  if (!c7Exit || !podEntry) return;
  const a = c7Exit.getWorldPosition(V());
  const a2 = c7Exit.localToWorld(V(0, -1.6, -0.4));
  const pts = [a, a2];
  for (const t of [0.3, 0.55, 0.8]) { const p = a2.clone().lerp(podUp, t); p.z -= 0.6; pushOut(p, 0.7); pts.push(p); }
  pts.push(podUp.clone(), podEntry.clone());
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  lenStat.now = curve.getLength(); lenStat.max = Math.max(lenStat.max, lenStat.now);
  if (st.mode === 'xray') twisted(c7Group, curve, ['v33', 'gnd', 'sda', 'scl', 'mot'], 'c7cable');
  else { const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 0.17, 12), M.jacket); m.castShadow = true; m.userData.part = 'c7cable'; c7Group.add(m); }
  if (!anchors.c7cable) anchor(headWorld, V(), 'c7cable', 'all');
  anchors.c7cable.o.position.copy(curve.getPointAt(0.45)).add(V(1.0, 0, -0.4));
  $('lenNow').textContent = lenStat.now.toFixed(1) + ' ซม.';
  $('lenMax').textContent = lenStat.max.toFixed(1) + ' ซม.';
  $('lenCut').textContent = Math.ceil(lenStat.max + 4) + ' ซม.';
}

// ---------- pin-wiring bench ----------
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
const pins = {};            // "BOARD.PIN" -> { pos (bench-local), label sprite }
const pinLabels = [];
const PART_OF = { ESP: 'esp', BNOL: 'bnoL', BNOR: 'bnoR', GY: 'mpu', TP: 'power', MT: 'power', BAT: 'power', DRV: 'pod', MOT: 'pod' };
function addBoard(id, { w, h, mat, at, pinsDef, deco }) {
  const g = new THREE.Group(); g.position.copy(at); bench.add(g);
  mesh(new THREE.BoxGeometry(w, h, 0.16), mat, g);
  if (deco) deco(g);
  for (const p of pinsDef) {
    const pos = V(p.x, p.y, 0);
    mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.2, 12), M.gold, g, pos.clone().add(V(0, 0, 0.05)), [Math.PI / 2, 0, 0]);
    const lab = textSprite(p.n, '#dfe8ea', 0.2);
    lab.position.copy(pos).add(V(p.lx ?? 0, p.ly ?? (p.y >= 0 ? 0.3 : -0.3), 0.15));
    g.add(lab); pinLabels.push({ sprite: lab, key: id + '.' + p.k });
    pins[id + '.' + p.k] = { pos: g.position.clone().add(pos).add(V(0, 0, 0.16)) };
  }
  tagPart(g, PART_OF[id]);
  return g;
}
function row(names, y, x0, pitch, side) {
  return names.map((n, i) => ({ n: n[0], k: n[1] ?? n[0], x: x0 + i * pitch, y, ly: side === 'up' ? 0.32 : -0.32 }));
}
const stagger = (list) => list.map((p, i) => ({ ...p, ly: (p.y > 0 ? 1 : -1) * (0.3 + (i % 2) * 0.24) }));
function buildBench() {
  // zones = where each part physically lives
  const zone = (x0, y0, x1, y1, title) => {
    const w = x1 - x0, h = y1 - y0;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.zone); m.position.set(x0 + w / 2, y0 + h / 2, -0.3); bench.add(m);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, h)), M.zoneEdge); e.position.copy(m.position); bench.add(e);
    const t = textSprite(title, '#9fe3e8', 0.42, 'rgba(10,16,18,0)'); t.position.set(x0 + 0.2 + t.scale.x / 2, y1 - 0.45, 0); bench.add(t);
  };
  zone(-12.5, -4.6, 2.2, 6.6, 'ครอบหูซ้าย');
  zone(3.6, -4.6, 15.8, 6.6, 'ครอบหูขวา');
  zone(-7.5, -12.4, 6.0, -6.4, 'กล่อง C7');
  const t1 = textSprite('สาย 5 คอร์ในก้านคาดหัว →', '#c9d6d9', 0.32, 'rgba(10,16,18,0)'); t1.position.set(2.9, 7.2, 0); bench.add(t1);
  const t2 = textSprite('↓ สาย 5 คอร์ลง C7', '#c9d6d9', 0.32, 'rgba(10,16,18,0)'); t2.position.set(-3.6, -5.5, 0); bench.add(t2);

  // ESP32-DevKitC V4: J2 on top (3V3 ... 5V), J3 on the bottom (GND ... CLK); pin 1 at the antenna end
  const J2 = [['3V3'], ['EN'], ['VP'], ['VN'], ['34'], ['35'], ['32'], ['33'], ['25', 'G25'], ['26'], ['27'], ['14'], ['12'], ['GND', 'GND3'], ['13'], ['D2'], ['D3'], ['CMD'], ['5V']];
  const J3 = [['GND', 'GND1'], ['23'], ['22', 'G22'], ['TX'], ['RX'], ['21', 'G21'], ['GND', 'GND2'], ['19', 'G19'], ['18', 'G18'], ['5'], ['17'], ['16'], ['4'], ['0', 'G0'], ['2'], ['15'], ['D1'], ['D0'], ['CLK']];
  addBoard('ESP', { w: 5.44, h: 2.79, mat: M.pcbBlack, at: V(-5.2, 0.6, 0),
    pinsDef: stagger([...row(J2, 1.143, -2.286, 0.254, 'up'), ...row(J3, -1.143, -2.286, 0.254, 'down')]),
    deco: (g) => {
      mesh(new THREE.BoxGeometry(1.8, 1.6, 0.3), M.can, g, V(-1.55, 0, 0.2));
      mesh(new THREE.BoxGeometry(0.55, 0.75, 0.28), M.can, g, V(2.55, 0, 0.2));
      const t = textSprite('ESP32-DevKitC', '#ffffff', 0.3, 'rgba(0,0,0,0)'); t.position.set(0.9, 0, 0.2); g.add(t);
      const a = textSprite('เสาอากาศ', '#c9d6d9', 0.2, 'rgba(0,0,0,0)'); a.position.set(-1.55, 0, 0.4); g.add(a);
    } });
  const BNO_PINS = () => [...row([['VIN'], ['3Vo'], ['GND'], ['SCL'], ['SDA'], ['DI']], -0.95, -0.635, 0.254, 'down'), ...row([['CS'], ['INT'], ['RST'], ['P0'], ['P1'], ['BT']], 0.95, -0.635, 0.254, 'up')];
  const bnoDeco = (name, addr) => (g) => {
    mesh(new THREE.BoxGeometry(0.52, 0.38, 0.1), M.chip, g, V(0, 0, 0.12));
    for (const x of [-1.05, 1.05]) mesh(new THREE.BoxGeometry(0.43, 0.6, 0.29), M.jst, g, V(x, 0, 0.22));
    const t = textSprite(name + ' · ' + addr, '#ffffff', 0.28); t.position.set(0, 1.7, 0.2); g.add(t);
  };
  addBoard('BNOL', { w: 2.56, h: 2.27, mat: M.pcbBlack, at: V(-9.6, 3.3, 0), pinsDef: stagger(BNO_PINS()), deco: bnoDeco('BNO085 ซ้าย', '0x4A') });
  addBoard('BNOR', { w: 2.56, h: 2.27, mat: M.pcbBlack, at: V(6.6, 3.3, 0), pinsDef: stagger(BNO_PINS()), deco: bnoDeco('BNO085 ขวา', '0x4B') });
  // power chain in the right cup
  addBoard('TP', { w: 2.6, h: 1.7, mat: M.pcbBlue, at: V(11.4, 3.0, 0),
    pinsDef: [{ n: 'B+', k: 'B+', x: -1.1, y: 0.6, lx: -0.3, ly: 0 }, { n: 'B-', k: 'B-', x: -1.1, y: -0.6, lx: -0.3, ly: 0 }, { n: 'OUT+', k: 'OUT+', x: 1.1, y: 0.6, lx: 0.45, ly: 0 }, { n: 'OUT-', k: 'OUT-', x: 1.1, y: -0.6, lx: 0.45, ly: 0 }],
    deco: (g) => { mesh(new THREE.BoxGeometry(0.75, 0.9, 0.32), M.can, g, V(0, 0, 0.2)); const t = textSprite('TP4056 ชาร์จ USB-C', '#ffffff', 0.24); t.position.set(0, 1.15, 0.2); g.add(t); } });
  addBoard('MT', { w: 3.6, h: 1.7, mat: M.pcbBlue, at: V(11.4, -0.9, 0),
    pinsDef: [{ n: 'VIN+', k: 'VIN+', x: -1.6, y: 0.6, lx: -0.45, ly: 0 }, { n: 'VIN-', k: 'VIN-', x: -1.6, y: -0.6, lx: -0.45, ly: 0 }, { n: 'VOUT+', k: 'VOUT+', x: 1.6, y: 0.6, lx: 0.5, ly: 0 }, { n: 'VOUT-', k: 'VOUT-', x: 1.6, y: -0.6, lx: 0.5, ly: 0 }],
    deco: (g) => { mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.3, 20), M.chip, g, V(0, 0, 0.2), [Math.PI / 2, 0, 0]); const t = textSprite('MT3608 บูสต์ 5V', '#ffffff', 0.24); t.position.set(0, -1.15, 0.2); g.add(t); } });
  addBoard('BAT', { w: 3.0, h: 3.5, mat: M.foil, at: V(6.0, -1.9, 0),
    pinsDef: [{ n: '+', k: '+', x: 1.2, y: 1.5, lx: 0.3, ly: 0 }, { n: '-', k: '-', x: 1.2, y: 1.1, lx: 0.3, ly: 0 }],
    deco: (g) => { const t = textSprite('LiPo 503035', '#1a1a1a', 0.26, 'rgba(255,255,255,0.7)'); t.position.set(0, -0.4, 0.2); g.add(t); } });
  const sw = textSprite('ผ่านสวิตช์', '#ffd9b8', 0.22); sw.position.set(13.9, 1.0, 0.3); bench.add(sw);
  // C7 pod
  addBoard('GY', { w: 2.1, h: 1.6, mat: M.pcbBlue, at: V(-3.2, -9.6, 0),
    pinsDef: stagger(row([['VCC'], ['GND'], ['SCL'], ['SDA'], ['XDA'], ['XCL'], ['AD0'], ['INT']], 0.62, -0.889, 0.254, 'up')),
    deco: (g) => { mesh(new THREE.BoxGeometry(0.4, 0.4, 0.1), M.chip, g, V(0, -0.15, 0.12)); const t = textSprite('GY-521 MPU6050 · 0x68', '#ffffff', 0.26); t.position.set(0, -1.15, 0.2); g.add(t); } });
  addBoard('DRV', { w: 1.8, h: 1.3, mat: M.pcbGreen, at: V(1.0, -9.4, 0),
    pinsDef: row([['IN'], ['VCC'], ['GND']], 0.5, -0.5, 0.5, 'up').concat(row([['M+'], ['M-']], -0.5, -0.25, 0.5, 'down')),
    deco: (g) => { mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.3, 16, 1, false, 0, Math.PI), M.chip, g, V(-0.4, -0.05, 0.2), [Math.PI / 2, 0, 0]); const t = textSprite('NPN + ไดโอด', '#ffffff', 0.22); t.position.set(0, -1.1, 0.2); g.add(t); } });
  addBoard('MOT', { w: 1.0, h: 1.0, mat: M.can, at: V(4.0, -9.6, 0),
    pinsDef: [{ n: '+', k: '+', x: -0.3, y: 0.55 }, { n: '-', k: '-', x: 0.3, y: 0.55 }],
    deco: (g) => { const t = textSprite('มอเตอร์สั่น', '#ffffff', 0.22); t.position.set(0, -0.8, 0.2); g.add(t); } });
}
// wiring list (route: where the wire physically runs)
const BOARD_NAME = { ESP: 'ESP32', BNOL: 'BNO ซ้าย', BNOR: 'BNO ขวา', GY: 'MPU6050', DRV: 'ตัวขับมอเตอร์', MOT: 'มอเตอร์', TP: 'TP4056', MT: 'MT3608', BAT: 'LiPo' };
function pinName(k) {
  const [bd, p] = k.split('.');
  let pn = p;
  if (bd === 'ESP') pn = p.startsWith('GND') ? 'GND' : /^G\d+$/.test(p) ? 'GPIO' + p.slice(1) : p;
  return BOARD_NAME[bd] + ' ' + pn;
}
function wireList(bus) {
  const sda = bus === 'two' ? 'ESP.G18' : 'ESP.G21', scl = bus === 'two' ? 'ESP.G19' : 'ESP.G22';
  return [
    ['v33', 'ESP.3V3', 'BNOL.VIN', 'ในครอบหูซ้าย'],
    ['gnd', 'ESP.GND1', 'BNOL.GND', 'ในครอบหูซ้าย'],
    ['sda', 'ESP.G21', 'BNOL.SDA', 'ในครอบหูซ้าย'],
    ['scl', 'ESP.G22', 'BNOL.SCL', 'ในครอบหูซ้าย'],
    ['v33', 'ESP.3V3', 'BNOR.VIN', 'ก้านคาดหัว'],
    ['gnd', 'ESP.GND1', 'BNOR.GND', 'ก้านคาดหัว'],
    ['sda', sda, 'BNOR.SDA', 'ก้านคาดหัว'],
    ['scl', scl, 'BNOR.SCL', 'ก้านคาดหัว'],
    ['v33', 'BNOR.3Vo', 'BNOR.DI', 'บนบอร์ด (ตั้ง 0x4B)'],
    ['v5', 'MT.VOUT+', 'ESP.5V', 'ก้านคาดหัว'],
    ['gnd', 'MT.VOUT-', 'ESP.GND3', 'ก้านคาดหัว'],
    ['v5', 'BAT.+', 'TP.B+', 'ในครอบหูขวา'],
    ['gnd', 'BAT.-', 'TP.B-', 'ในครอบหูขวา'],
    ['v5', 'TP.OUT+', 'MT.VIN+', 'ในครอบหูขวา (ผ่านสวิตช์)'],
    ['gnd', 'TP.OUT-', 'MT.VIN-', 'ในครอบหูขวา'],
    ['v33', 'ESP.3V3', 'GY.VCC', 'สายลง C7'],
    ['gnd', 'ESP.GND2', 'GY.GND', 'สายลง C7'],
    ['sda', 'ESP.G21', 'GY.SDA', 'สายลง C7'],
    ['scl', 'ESP.G22', 'GY.SCL', 'สายลง C7'],
    ['mot', 'ESP.G25', 'DRV.IN', 'สายลง C7'],
    ['v33', 'GY.VCC', 'DRV.VCC', 'ในกล่อง C7'],
    ['gnd', 'GY.GND', 'DRV.GND', 'ในกล่อง C7'],
    ['mot', 'DRV.M+', 'MOT.+', 'ในกล่อง C7'],
    ['mot', 'DRV.M-', 'MOT.-', 'ในกล่อง C7'],
  ].map(([net, a, b, route]) => ({ net, a, b, route, la: pinName(a), lb: pinName(b) }));
}
const wireGroup = new THREE.Group(); bench.add(wireGroup);
const netOn = Object.fromEntries(Object.keys(NET).map((k) => [k, true]));
function rebuildBenchWires() {
  for (const m of [...wireGroup.children]) { m.geometry.dispose(); wireGroup.remove(m); }
  const used = new Set();
  wireList(st.bus).forEach((w, i) => {
    const A = pins[w.a], B = pins[w.b]; if (!A || !B) return;
    used.add(w.a); used.add(w.b);
    if (!netOn[w.net]) return;
    const lift = 0.5 + (i % 5) * 0.35 + A.pos.distanceTo(B.pos) * 0.05;
    const curve = new THREE.CubicBezierCurve3(A.pos, A.pos.clone().add(V(0, 0, lift)), B.pos.clone().add(V(0, 0, lift)), B.pos);
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.05, 8), NET[w.net].mat);
    m.castShadow = true; m.userData.part = 'wire'; wireGroup.add(m);
  });
  for (const p of pinLabels) {
    const on = used.has(p.key);
    p.sprite.material.opacity = on ? 1 : 0.4;
    p.sprite.visible = on || st.pinNames;
  }
}

// ---------- modes ----------
function applyMode() {
  const x = st.mode === 'xray', pinsMode = st.mode === 'pins';
  for (const m of shellMats) { m.opacity = x ? 0.2 : 1; m.depthWrite = !x; }
  for (const o of insideParts) o.visible = x;
  headWorld.visible = !pinsMode; bench.visible = pinsMode;
  $('lenbox').hidden = pinsMode; $('poseCard').hidden = pinsMode;
  $('hint').textContent = pinsMode
    ? 'ผังต่อขา (บอร์ดขนาดจริง) · ลากเพื่อหมุน · ซูมเพื่ออ่านชื่อขา · ใช้ช่องติ๊ก "เปิด/ปิดสาย" เพื่อเลือกกลุ่มสาย'
    : 'ลากเพื่อหมุน · ล้อเมาส์/สองนิ้วเพื่อซูม · แตะชิ้นส่วนเพื่อดูรายละเอียด';
  if (pinsMode) fitBench();
  else {
    // narrow stages (phones) need the camera further back to keep both ear cups in view
    const back = Math.max(1, 1.25 / camera.aspect);
    controls.target.copy(HEAD_VIEW.target);
    camera.position.copy(HEAD_VIEW.pos).sub(HEAD_VIEW.target).multiplyScalar(back).add(HEAD_VIEW.target);
    controls.update();
  }
  rebuildC7Cable(); rebuildBenchWires();
}
// back the camera off far enough that the whole bench (≈ 29 × 21 cm) fits the stage at any width
function fitBench() {
  const vf = THREE.MathUtils.degToRad(camera.fov) / 2, hf = Math.atan(Math.tan(vf) * camera.aspect);
  const d = Math.max(10.5 / Math.tan(vf), 15 / Math.tan(hf)) * 1.06;
  controls.target.copy(BENCH_VIEW.target);
  camera.position.copy(BENCH_VIEW.target).add(V(0, -0.8, d));
  controls.update();
}
function applyPose() {
  if (!bust) return;
  const r = THREE.MathUtils.degToRad, p = r(st.pitch), y = r(st.yaw), z = r(st.roll);
  rig1.rotation.set(p * SHARE1, y * SHARE1, z * SHARE1);
  rig2.rotation.set(p * SHARE2, y * SHARE2, z * SHARE2);
  skin(p, y, z);
  scene.updateMatrixWorld(true);
  rebuildC7Cable();
}

// ---------- panel ----------
const INFO = {
  cupL: ['ครอบหูซ้าย', ['ข้างในมี ESP32-DevKitC, BNO085 (0x4A) และลำโพง 40 มม.', 'BNO085 วางด้านบน-หลัง ห่างแม่เหล็กลำโพงราว 3 ซม.', 'ใต้ครอบหูมีรูสายลง C7 (ยางกันหัก)']],
  cupR: ['ครอบหูขวา', ['ข้างในมี BNO085 (0x4B), แบต LiPo, TP4056 ชาร์จ USB-C, MT3608 บูสต์ 5V และลำโพง', 'วางแบตไว้ข้างนี้เพื่อให้น้ำหนักซ้าย-ขวาใกล้กัน', 'ช่องชาร์จ USB-C อยู่ใต้ครอบหู']],
  band: ['ก้านคาดหัว', ['สาย 5 คอร์วิ่งอยู่ข้างใน: 5V, GND, 3V3, SDA, SCL', 'แบบนี้ไม่มีสายพาดระหว่างหูให้เห็นข้างนอก', 'ถ้าแยกบัส SDA/SCL ของหูขวาจะไปที่ GPIO18/19 แต่จำนวนคอร์เท่าเดิม']],
  c7cable: ['สายลง C7', ['สายซิลิโคน 5 คอร์ Ø3.4 มม.: 3V3, GND, SDA, SCL, มอเตอร์ (GPIO25)', 'ออกจากใต้ครอบหูซ้าย ลงหลังหูไปที่กล่อง C7', 'เป็นสายเส้นเดียวที่อยู่นอกตัวหูฟัง ตัดยาวกว่าค่า "ยาวสุดที่เจอ" ราว 4 ซม.']],
  pod: ['กล่อง C7', ['เคส 34×28×11 มม. ติดที่กระดูก C7 ด้วยเทปการแพทย์หรือคลิปปกเสื้อ', 'ข้างในมี GY-521 (MPU6050, 0x68), มอเตอร์สั่น และวงจรขับ NPN + ไดโอด', 'AD0 ของ GY-521 ปล่อยว่างได้ บนบอร์ดมี pull-down อยู่แล้ว (0x68)']],
  esp: ['ESP32-DevKitC', ['I2C0: SDA GPIO21, SCL GPIO22 · I2C1 สำรอง: GPIO18/19', 'GPIO25 สั่งมอเตอร์ · ปุ่ม BOOT คือ GPIO0', 'รับไฟ 5V จากบูสต์ในครอบหูขวาทางขา 5V']],
  bnoL: ['BNO085 ซ้าย', ['I2C 0x4A: ขา DI ปล่อยว่าง', 'ต่อ VIN, GND, SCL, SDA ตรงจาก ESP32 ในครอบหูเดียวกัน', 'ขา INT/RST ไม่ได้ใช้ในเฟิร์มแวร์ตอนนี้']],
  bnoR: ['BNO085 ขวา', ['I2C 0x4B: ต่อ 3Vo เข้า DI บนบอร์ด', 'ไฟและสัญญาณมาทางสายในก้านคาดหัว']],
  mpu: ['MPU6050 (GY-521)', ['I2C 0x68 บนบัส GPIO21/22', 'ติดฝั่งที่แนบผิวในกล่อง C7']],
  power: ['ชุดไฟในครอบหูขวา', ['LiPo → TP4056 (ชาร์จ USB-C) → สวิตช์ → MT3608 บูสต์ 5V → ขา 5V ของ ESP32', 'ปรับ MT3608 ให้ได้ 5.0V ก่อนต่อเข้า ESP32']],
};
function showInfo(id) {
  document.querySelectorAll('.tag').forEach((el) => el.dataset.on = el.dataset.id === id ? '1' : '0');
  const box = $('info');
  if (!id || !INFO[id]) { box.innerHTML = '<h3>แตะชิ้นส่วนในโมเดล</h3><p>เลือกครอบหู ก้านคาดหัว สาย หรือกล่อง C7 เพื่อดูว่าข้างในมีอะไรและต่อขาไหน</p>'; return; }
  const [t, items] = INFO[id];
  box.innerHTML = '';
  const h = document.createElement('h3'); h.textContent = t; box.appendChild(h);
  const ul = document.createElement('ul');
  for (const s of items) { const li = document.createElement('li'); li.textContent = s; ul.appendChild(li); }
  box.appendChild(ul);
}
function dot(css) { const d = document.createElement('span'); d.className = 'dot'; d.style.background = `var(${css})`; return d; }
function renderPanel() {
  const two = st.bus === 'two';
  const cables = [
    ['ในก้านคาดหัว (ซ้าย ↔ ขวา)', [['v5', '5V'], ['gnd', 'GND'], ['v33', '3V3'], ['sda', two ? 'SDA → GPIO18' : 'SDA → GPIO21'], ['scl', two ? 'SCL → GPIO19' : 'SCL → GPIO22']]],
    ['สายลง C7 (ครอบหูซ้าย → C7)', [['v33', '3V3'], ['gnd', 'GND'], ['sda', 'SDA → GPIO21'], ['scl', 'SCL → GPIO22'], ['mot', 'มอเตอร์ → GPIO25']]],
  ];
  const cb = $('cables'); cb.innerHTML = '';
  for (const [title, cores] of cables) {
    const d = document.createElement('div'); d.className = 'cable';
    const b = document.createElement('b'); b.textContent = title + ' · ' + cores.length + ' คอร์'; d.appendChild(b);
    const c = document.createElement('div'); c.className = 'cores';
    for (const [n, t] of cores) { const s = document.createElement('span'); s.append(dot(NET[n].css), t); c.appendChild(s); }
    d.appendChild(c); cb.appendChild(d);
  }
  $('busNote').textContent = two
    ? 'แยกบัส: ต้องแก้เฟิร์มแวร์ให้ BNO ขวาใช้ Wire1 (GPIO18/19) แล้ว compile และทดสอบกับบอร์ดจริง'
    : 'บัสเดียว: ตรงกับเฟิร์มแวร์ตอนนี้ ทั้ง 3 ตัว (0x4A, 0x4B, 0x68) อยู่บน GPIO21/22';
  const t = $('pinTable'); t.innerHTML = '';
  const hr = t.insertRow(); ['สาย', 'จาก', 'ไป', 'เดินที่'].forEach((x) => { const th = document.createElement('th'); th.textContent = x; hr.appendChild(th); });
  for (const w of wireList(st.bus)) {
    const tr = t.insertRow();
    const c0 = tr.insertCell(); c0.style.whiteSpace = 'nowrap'; c0.append(dot(NET[w.net].css), NET[w.net].name);
    tr.insertCell().textContent = w.la; tr.insertCell().textContent = w.lb;
    const r = tr.insertCell(); r.textContent = w.route; r.className = 'route';
  }
  const nets = $('nets'); nets.innerHTML = '';
  for (const [k, n] of Object.entries(NET)) {
    const l = document.createElement('label'); const i = document.createElement('input'); i.type = 'checkbox'; i.checked = netOn[k]; i.id = 'net-' + k;
    i.onchange = () => { netOn[k] = i.checked; if (st.mode !== 'pins') setMode('pins'); else rebuildBenchWires(); };
    l.append(i, dot(n.css), n.name); nets.appendChild(l);
  }
}

// ---------- HTML labels ----------
const LABELS = [['cupL', 'ครอบหูซ้าย · ESP32 + BNO085'], ['cupR', 'ครอบหูขวา · BNO085 + แบต'], ['band', 'ก้านคาดหัว (สาย 5 คอร์ข้างใน)'],
  ['c7cable', 'สายลง C7'], ['pod', 'กล่อง C7'], ['esp', 'ESP32'], ['bnoL', 'BNO085 0x4A'], ['bnoR', 'BNO085 0x4B'], ['power', 'แบต + ชาร์จ + บูสต์'], ['mpu', 'MPU6050']];
const tagEls = {};
for (const [id, txt] of LABELS) {
  const el = document.createElement('button'); el.className = 'tag'; el.textContent = txt; el.dataset.id = id; el.hidden = true;
  el.addEventListener('click', () => showInfo(id));
  $('labels').appendChild(el); tagEls[id] = el;
}
const tmp = V(), camDir = V();
function placeTags() {
  const w = stage.clientWidth, h = stage.clientHeight;
  camera.getWorldDirection(camDir);
  for (const [id] of LABELS) {
    const el = tagEls[id], a = anchors[id];
    const ok = a && st.tags && st.mode !== 'pins' && (a.mode === 'all' || a.mode === st.mode);
    if (!ok) { el.hidden = true; continue; }
    a.o.getWorldPosition(tmp);
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
  const list = pickables.concat(c7Group.children);
  if (bust) list.push(bust);
  const hits = pick.intersectObjects(list, false).filter((hh) => shown(hh.object));
  showInfo(hits.length ? hits[0].object.userData.part || null : null);
});

// ---------- UI ----------
function press(ids, on) { for (const id of ids) $(id).setAttribute('aria-pressed', id === on); }
function setMode(m) { st.mode = m; press(['mWear', 'mXray', 'mPins'], { wear: 'mWear', xray: 'mXray', pins: 'mPins' }[m]); applyMode(); }
$('mWear').onclick = () => setMode('wear');
$('mXray').onclick = () => setMode('xray');
$('mPins').onclick = () => setMode('pins');
$('busOne').onclick = () => { st.bus = 'one'; press(['busOne', 'busTwo'], 'busOne'); renderPanel(); rebuildBenchWires(); };
$('busTwo').onclick = () => { st.bus = 'two'; press(['busOne', 'busTwo'], 'busTwo'); renderPanel(); rebuildBenchWires(); };
$('pinNames').onchange = (e) => { st.pinNames = e.target.checked; rebuildBenchWires(); };
$('tags').onchange = (e) => { st.tags = e.target.checked; };
for (const k of ['Pitch', 'Yaw', 'Roll']) {
  $('s' + k).addEventListener('input', (e) => { stopAuto(); st[k.toLowerCase()] = +e.target.value; syncSliders(); applyPose(); });
}
function syncSliders() { for (const k of ['Pitch', 'Yaw', 'Roll']) { const v = Math.round(st[k.toLowerCase()]); $('s' + k).value = v; $('v' + k).textContent = v + '°'; } }
function stopAuto() { st.auto = false; $('auto').textContent = 'ขยับอัตโนมัติ'; }
$('auto').onclick = () => { if (st.auto) return stopAuto(); st.auto = true; st.t0 = performance.now(); $('auto').textContent = 'หยุด'; };
$('reset').onclick = () => { stopAuto(); st.pitch = st.yaw = st.roll = 0; syncSliders(); applyPose(); };

// ---------- loop ----------
function resize() { const w = stage.clientWidth, h = stage.clientHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
new ResizeObserver(resize).observe(stage); resize();
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function frame(now) {
  if (st.auto && bust && st.mode !== 'pins') {
    const t = (now - st.t0) / 1000 * (reduce ? 0.4 : 1);
    st.pitch = 12 + 24 * Math.sin(t * 0.7); st.yaw = 60 * Math.sin(t * 0.45); st.roll = 18 * Math.sin(t * 0.9 + 1);
    syncSliders(); applyPose();
  }
  controls.update(); renderer.render(scene, camera); placeTags();
  requestAnimationFrame(frame);
}
try { await document.fonts.load('600 44px "IBM Plex Sans Thai"', 'กขค ABC'); } catch { /* fall back to system font */ }
buildBench();
renderPanel(); syncSliders(); rebuildBenchWires();
requestAnimationFrame(frame);
