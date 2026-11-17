// structure.html: the inside of every enclosure as real structure. Each part sits on a mount, wires run
// between real pins, and the whole thing comes apart layer by layer. Positions come from structure-layout.js.
// Offline: vendored Three.js, no CDN. Scene units are millimetres (boards from wiring-boards.js are scaled x10).
import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { bno085, esp32, gy521, tp4056, mt3608, lipo, qwiicAdapter } from './wiring-boards.js';
import { UNITS, C7, C7_WIRES, C7_CABLES, BOARD, JUMPER, EAR_CABLE, pinAt, boardXY, hardware } from './structure-layout.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), canvas = $('c');
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const MAKER = { esp32, qwiic: qwiicAdapter, gy521, tp4056, mt3608, lipo, bno085 };

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
function studioRoom() {
  const room = new THREE.Scene();
  room.add(new THREE.Mesh(new THREE.BoxGeometry(30, 20, 30), new THREE.MeshBasicMaterial({ color: 0x4a5257, side: THREE.BackSide })));
  const panel = (w, h, c, pos, r) => { const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(5), side: THREE.DoubleSide })); p.position.set(...pos); p.rotation.set(...r); room.add(p); };
  panel(14, 8, 0xfff2e4, [-6, 9.5, 4], [Math.PI / 2, 0, 0]);
  panel(8, 10, 0xdfeeff, [14.5, 3, -6], [0, -Math.PI / 2, 0]);
  panel(6, 8, 0xffffff, [-14.5, 2, 6], [0, Math.PI / 2, 0]);
  return room;
}
const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(studioRoom(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(30, 1, 5, 6000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.minDistance = 30; controls.maxDistance = 2200;
let dirty = true;
controls.addEventListener('change', () => { dirty = true; });
const key = new THREE.DirectionalLight(0xfff1e2, 2.2); key.position.set(-200, 300, 400); scene.add(key);
const fill = new THREE.DirectionalLight(0xcfe8ff, 1.2); fill.position.set(300, -100, -300); scene.add(fill);

// ---------- materials ----------
const phys = (o) => new THREE.MeshPhysicalMaterial(o);
const MAT = {
  shell: phys({ color: 0x0f9aa5, roughness: 0.45, clearcoat: 0.4, side: THREE.DoubleSide }),
  lid: phys({ color: 0xeaf1f2, roughness: 0.5, side: THREE.DoubleSide }),
  tray: phys({ color: 0x8fb9c0, roughness: 0.55, side: THREE.DoubleSide }),
  mount: phys({ color: 0x0b7780, roughness: 0.5 }),          // posts, ribs, hooks: part of the printed base
  trayMount: phys({ color: 0x6fa0a8, roughness: 0.55 }),
  steel: phys({ color: 0xc9ced2, roughness: 0.28, metalness: 1 }),
  rubber: phys({ color: 0x15171a, roughness: 0.85 }),
  foam: phys({ color: 0xf2f3f1, roughness: 0.95 }),
  alu: phys({ color: 0xd9dde0, roughness: 0.36, metalness: 1 }),
  velcro: phys({ color: 0x2a2d31, roughness: 1 }),
  housing: phys({ color: 0x17181a, roughness: 0.55 }),
  plug: phys({ color: 0xf2efe6, roughness: 0.5 }),
  cable: phys({ color: 0x6b7479, roughness: 0.6 }),
  tie: phys({ color: 0xf5f5f0, roughness: 0.6 }),
};
const NET = {
  v33: { name: 'ไฟ 3V3', color: 0xd0312d, css: '--n-3v3' }, gnd: { name: 'GND', color: 0x26262a, css: '--n-gnd' },
  sda: { name: 'SDA', color: 0x1f63d6, css: '--n-sda' }, scl: { name: 'SCL', color: 0xe0b000, css: '--n-scl' },
  bat: { name: 'แบต / 5 V', color: 0xe5731b, css: '--n-5v' },
};
for (const n of Object.values(NET)) n.mat = phys({ color: n.color, roughness: 0.45, clearcoat: 0.4 });

// ---------- registry: every object knows its unit, its layer and the part it belongs to ----------
// Exploded view: each layer slides along z by its own distance.
const OFF = {
  c7: { clampScrew: -72, clamp: -52, strip: -28, base: 0, floor: 26, tray: 54, trayScrew: 68, board: 86, boardScrew: 102, lid: 130, lidScrew: 158 },
  pod: { velcro: -10, base: 0, clamp: 9, clampScrew: 15, board: 13, boardScrew: 21, lid: 32 },
};
const AT = { c7: V(0, 0, 0), podL: V(-120, 175, 0), podR: V(120, 175, 0) };
const KIND = { c7: 'c7', podL: 'pod', podR: 'pod' };
const DATA = { c7: C7, podL: UNITS.podL, podR: UNITS.podR };
const unitGroups = {}, items = [], pickables = [];
for (const [k, p] of Object.entries(AT)) { const g = new THREE.Group(); g.position.copy(p); scene.add(g); unitGroups[k] = g; }
const st = { focus: 'c7', e: 0, goal: 0, xray: true, hideLid: false, wires: true, labels: true, sel: null, view: 'vIso' };
function reg(obj, unit, level, part) {
  obj.userData.z0 = obj.position.z; obj.userData.level = level; obj.userData.unit = unit;
  obj.traverse((o) => { o.userData.part = part; o.userData.unitKey = unit; if (o.isMesh) pickables.push(o); });
  unitGroups[unit].add(obj); items.push(obj); return obj;
}
const lift = (unit, level) => OFF[KIND[unit]][level] * st.e;

// ---------- geometry helpers ----------
const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };
const box = (w, h, d, mat, x, y, z) => mesh(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
const cyl = (r, h, mat, x, y, z, seg = 24) => mesh(new THREE.CylinderGeometry(r, r, h, seg).rotateX(Math.PI / 2), mat, x, y, z);
function rrShape(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
  return s;
}
const rectPath = ([x0, y0, x1, y1]) => { const p = new THREE.Path(); p.moveTo(x0, y0); p.lineTo(x1, y0); p.lineTo(x1, y1); p.lineTo(x0, y1); p.closePath(); return p; };
const slab = (shape, t, mat, z) => mesh(new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 8 }), mat, 0, 0, z);
// One wall as a plate with its openings cut out. cuts: { u0, u1, z0, z1 }; z1 >= h makes a notch open to the lid.
const HORIZ = new THREE.Matrix4().makeBasis(V(1, 0, 0), V(0, 0, 1), V(0, -1, 0)), VERT = new THREE.Matrix4().makeBasis(V(0, 1, 0), V(0, 0, 1), V(1, 0, 0));
function wallPlate(len, h, th, cuts, basis) {
  const s = new THREE.Shape(); s.moveTo(-len / 2, 0); s.lineTo(len / 2, 0); s.lineTo(len / 2, h);
  for (const c of cuts.filter((q) => q.z1 >= h).sort((a, b) => b.u0 - a.u0)) { s.lineTo(c.u1, h); s.lineTo(c.u1, c.z0); s.lineTo(c.u0, c.z0); s.lineTo(c.u0, h); }
  s.lineTo(-len / 2, h); s.closePath();
  for (const c of cuts.filter((q) => q.z1 < h)) s.holes.push(rectPath([c.u0, c.z0, c.u1, c.z1]));
  return new THREE.ExtrudeGeometry(s, { depth: th, bevelEnabled: false }).applyMatrix4(basis);
}
// floor + four walls of an enclosure; cuts = { left: [], right: [], top: [], bottom: [] }
function shellGroup(u, cuts, mat) {
  const g = new THREE.Group(), W = u.in.w, H = u.in.h, D = u.in.d, t = u.wall;
  g.add(slab(rrShape(W + 2 * t, H + 2 * t, Math.min(3, t * 1.5)), u.floor, mat, -u.floor));
  const add = (geo, x, y) => g.add(mesh(geo, mat, x, y, 0));
  add(wallPlate(W + 2 * t, D, t, cuts.bottom || [], HORIZ), 0, -H / 2);
  add(wallPlate(W + 2 * t, D, t, cuts.top || [], HORIZ), 0, H / 2 + t);
  add(wallPlate(H, D, t, cuts.left || [], VERT), -W / 2 - t, 0);
  add(wallPlate(H, D, t, cuts.right || [], VERT), W / 2, 0);
  return g;
}
// screw with its head seated at z = 0, shank going down (-z); up = true flips it
function screw(d, len, x, y, z, up = false) {
  const g = new THREE.Group();
  g.add(cyl(d * 0.9, d * 0.7, MAT.steel, 0, 0, d * 0.35), cyl(d / 2, len, MAT.steel, 0, 0, -len / 2, 12));
  g.add(box(d * 1.2, d * 0.22, 0.3, MAT.rubber, 0, 0, d * 0.7));
  g.position.set(x, y, z); if (up) g.rotation.x = Math.PI;
  return g;
}
// a real board from wiring-boards.js at its layout position
function boardAt(part, bare) {
  const b = BOARD[part.kind], g = MAKER[part.kind]({ bare }).group;
  g.scale.setScalar(10); g.position.set(part.at[0], part.at[1], part.at[2] + (b.t / 2)); g.rotation.z = part.turn * Math.PI / 2;
  return g;
}
const cornersOf = (p) => [[p.box[0], p.box[1]], [p.box[3], p.box[1]], [p.box[0], p.box[4]], [p.box[3], p.box[4]]];

// ---------- C7 box ----------
function buildC7() {
  const u = C7, W = u.in.w, H = u.in.h, D = u.in.d, by = Object.fromEntries(u.parts.map((p) => [p.id, p]));
  const cuts = { left: [], right: [], top: [], bottom: [] };
  for (const o of u.openings) cuts[o.wall].push({ u0: o.at - o.w / 2, u1: o.at + o.w / 2, z0: o.z0, z1: o.z1 });
  // base: shell, posts, battery bay, board pockets, switch pocket, the two rails on the back
  const base = shellGroup(u, cuts, MAT.shell);
  for (const p of u.posts) base.add(cyl(u.postR, u.tray.z, MAT.mount, p.x, p.y, u.tray.z / 2));
  for (const [x0, y0, x1, y1] of u.batteryRibs) {
    base.add(box(x1 - x0, y1 - y0, u.ribH, MAT.mount, (x0 + x1) / 2, (y0 + y1) / 2, u.ribH / 2));
  }
  for (const id of ['tp', 'mt']) {
    const p = by[id], [x0, y0, , x1, y1] = p.box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, long = x1 - x0 > y1 - y0;
    for (const k of [-0.3, 0.3]) base.add(long ? box(1.2, y1 - y0 - 2, 1, MAT.mount, cx + k * (x1 - x0), cy, 0.5) : box(x1 - x0 - 2, 1.2, 1, MAT.mount, cx, cy + k * (y1 - y0), 0.5));
    for (const [x, y] of cornersOf(p)) if (Math.abs(y) < H / 2 - 2) base.add(box(1.6, 1.6, 4, MAT.mount, x + Math.sign(x - cx) * 0.8, y + Math.sign(y - cy) * 0.8, 2));
    // two snap hooks on the long edges
    for (const sgn of [-1, 1]) {
      const hx = long ? cx : (sgn < 0 ? x0 - 0.6 : x1 + 0.6), hy = long ? (sgn < 0 ? y0 - 0.6 : y1 + 0.6) : cy + 5;
      base.add(box(long ? 4 : 1.2, long ? 1.2 : 4, 3.6, MAT.mount, hx, hy, 1.8));
      base.add(box(long ? 4 : 2, long ? 2 : 4, 0.8, MAT.mount, hx - (long ? 0 : sgn * 0.5), hy - (long ? sgn * 0.5 : 0), 3.2));
    }
  }
  const sw = by.sw.box;
  base.add(box(1.2, 4.3, 4, MAT.mount, sw[0] - 0.6, -25.85, 2), box(1.2, 4.3, 4, MAT.mount, sw[3] + 0.6, -25.85, 2), box(4, 1.2, 3, MAT.mount, (sw[0] + sw[3]) / 2 + 2.3, sw[4] + 0.6, 1.5));
  const cl = u.clamp;
  for (const s of [-1, 1]) base.add(box(cl.railL, cl.railW, cl.railH, MAT.shell, 0, s * (cl.railY + cl.railW / 2), -u.floor - cl.railH / 2));
  reg(base, 'c7', 'base', 'base');
  // strip, clamp plate, pad, clamp screws
  const strip = new THREE.Group(), zs = -u.floor;
  strip.add(box(170, u.strip.width, u.strip.alu, MAT.alu, 0, 0, zs - u.strip.alu / 2), box(170, u.strip.width, cl.railH - u.strip.alu, MAT.foam, 0, 0, zs - u.strip.alu - (cl.railH - u.strip.alu) / 2));
  reg(strip, 'c7', 'strip', 'strip');
  const clamp = new THREE.Group(), zp = zs - cl.railH;
  clamp.add(slab(rrShape(cl.plate[0], cl.plate[1], 3), cl.plate[2], MAT.lid, zp - cl.plate[2]), slab(rrShape(cl.plate[0], cl.plate[1], 3), cl.pad, MAT.foam, zp - cl.plate[2] - cl.pad));
  reg(clamp, 'c7', 'clamp', 'clamp');
  for (const [x, y] of cl.screws) reg(screw(3, cl.screwLen, x, y, zp - cl.plate[2] + 0.4, true), 'c7', 'clampScrew', 'clamp');

  // floor level: power boards, battery, switch
  for (const id of ['mt', 'tp', 'bat']) reg(boardAt(by[id], true), 'c7', 'floor', id);
  const swg = new THREE.Group(), sx = (sw[0] + sw[3]) / 2;
  swg.add(box(8.6, 4.3, 4.7, MAT.steel, sx, -25.85, 2.35), box(2.2, 4.6, 2, MAT.housing, sx - 1.4, -30.2, 2.35));
  for (const dx of [-2.5, 0, 2.5]) swg.add(box(0.6, 2.4, 0.4, MAT.steel, sx + dx, -22.6, 2.3));
  reg(swg, 'c7', 'floor', 'sw');
  // bulk capacitor lying on the floor next to the MT3608 (its stripe marks the minus lead)
  const cb = by.cap.box, cr = (cb[3] - cb[0]) / 2, capG = new THREE.Group();
  capG.add(mesh(new THREE.CylinderGeometry(cr, cr, cb[4] - cb[1], 24), MAT.housing, (cb[0] + cb[3]) / 2, (cb[1] + cb[4]) / 2, cr));
  capG.add(box(1.6, cb[4] - cb[1] - 1, 0.3, MAT.lid, (cb[0] + cb[3]) / 2 + cr * 0.6, (cb[1] + cb[4]) / 2, cr * 1.8));
  reg(capG, 'c7', 'floor', 'cap');

  // tray: plate with slots under every header row, bosses, ledges and hooks for the boards on it
  const ts = rrShape(u.tray.w, u.tray.h, 2);
  for (const s of u.tray.slots) ts.holes.push(rectPath(s));
  for (const p of u.posts) { const c = new THREE.Path(); c.absarc(p.x, p.y, 1.6, 0, Math.PI * 2, true); ts.holes.push(c); }
  const tray = new THREE.Group(), zt = u.tray.z + u.tray.t;
  tray.add(slab(ts, u.tray.t, MAT.tray, u.tray.z));
  for (const id of ['esp', 'mpu']) for (const [hx, hy] of BOARD[by[id].kind].holes) { const [x, y] = boardXY(by[id], hx, hy); tray.add(cyl(2.2, u.zBoard - zt, MAT.trayMount, x, y, (zt + u.zBoard) / 2)); }
  for (const id of ['hubA', 'hubB']) {
    const p = by[id], cx = p.at[0], y0 = p.box[1], y1 = p.box[4];
    tray.add(box(18, 1.4, u.zBoard - zt, MAT.trayMount, cx, y1 - 1, (zt + u.zBoard) / 2));        // ledge under the far edge
    for (const [y, s] of [[y0 - 0.6, 1], [y1 + 0.6, -1]]) {                                        // snap hooks on both long edges
      tray.add(box(4, 1.2, u.zBoard - zt + 2.6, MAT.trayMount, cx + 7 * s, y, zt + (u.zBoard - zt + 2.6) / 2));
      tray.add(box(4, 2, 0.8, MAT.trayMount, cx + 7 * s, y + s * 0.5, u.zBoard + 2.2));
    }
  }
  reg(tray, 'c7', 'tray', 'tray');
  for (const p of u.posts) if (p.screw === 'tray') reg(screw(2.5, 6, p.x, p.y, zt), 'c7', 'trayScrew', 'tray');

  // board level: boards with their header pins down through the tray, jumper housings on the pins in use
  for (const id of ['esp', 'hubA', 'hubB', 'mpu']) {
    const p = by[id], g = new THREE.Group(); g.add(boardAt(p, false));
    for (const n of u.used[id]) { const [x, y] = pinAt(p, n); g.add(box(JUMPER.w - 0.1, JUMPER.w - 0.1, JUMPER.housing, MAT.housing, x, y, u.zBoard - JUMPER.strip - JUMPER.housing / 2)); }
    reg(g, 'c7', 'board', id);
    for (const [hx, hy] of BOARD[p.kind].holes || []) { const [x, y] = boardXY(p, hx, hy); reg(screw(2.5, 6, x, y, u.zBoard + BOARD[p.kind].t), 'c7', 'boardScrew', id); }
  }
  // lid: plate, lip, two sleeves that press the tray onto the posts, two long screws
  const lid = new THREE.Group();
  lid.add(slab(rrShape(W + 2 * u.wall, H + 2 * u.wall, 3), u.lid, MAT.lid, D));
  for (const s of [-1, 1]) lid.add(box(W - 12, 1, 1.4, MAT.lid, 0, s * (H / 2 - 0.6), D - 0.7), box(1, H - 30, 1.4, MAT.lid, s * (W / 2 - 0.6), 8, D - 0.7));
  for (const p of u.posts) if (p.screw === 'lid') lid.add(mesh(new THREE.CylinderGeometry(3, 3, D - zt, 24, 1, true).rotateX(Math.PI / 2), MAT.lid, p.x, p.y, (D + zt) / 2));
  reg(lid, 'c7', 'lid', 'lid');
  for (const p of u.posts) if (p.screw === 'lid') reg(screw(2.5, 20, p.x, p.y, D + u.lid), 'c7', 'lidScrew', 'lid');
}

// ---------- ear pod ----------
function buildPod(key) {
  const u = DATA[key], s = u.s, D = u.in.d, bno = u.parts[0], id = key.slice(3);
  const base = shellGroup(u, { bottom: [{ u0: u.exit.x - u.exit.w / 2, u1: u.exit.x + u.exit.w / 2, z0: 0.3, z1: D }] }, MAT.shell);
  const holes = BOARD.bno085.holes.map(([x, y]) => boardXY(bno, x, y));
  for (const [x, y] of holes) base.add(cyl(2.2, bno.at[2], MAT.mount, x, y, bno.at[2] / 2));
  holes.forEach(([x, y], i) => { if (i === 1 || i === 2) base.add(cyl(1.1, bno.at[2] + 2.6, MAT.mount, x, y, (bno.at[2] + 2.6) / 2)); });   // locating pins
  reg(base, key, 'base', 'podBase' + id);
  reg(box(34, 24, 1.2, MAT.velcro, 0, 0, -u.floor - 0.6), key, 'velcro', 'podBase' + id);
  const b = new THREE.Group(); b.add(boardAt(bno, true));
  if (s < 0) {   // the address jumper on the right pod: 3Vo -> DI
    const a = pinAt(bno, '3Vo'), d = pinAt(bno, 'DI');
    b.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([V(...a), V(a[0] + 5, -3, a[2] + 1.6), V(d[0] + 3, 4, d[2] + 1.6), V(...d)]), 24, 0.35, 6), NET.v33.mat));
  }
  reg(b, key, 'board', bno.id);
  holes.forEach(([x, y], i) => { if (i === 0 || i === 3) reg(screw(2.5, 4, x, y, bno.at[2] + 1.6), key, 'boardScrew', bno.id); });
  const cg = new THREE.Group(); cg.add(box(8, 3.6, 1.4, MAT.lid, u.clampAt[0] - s * 1.6, u.clampAt[1], 3.5));
  reg(cg, key, 'clamp', 'podClamp' + id);
  reg(screw(2, 5, u.clampAt[0] - s * 4.2, u.clampAt[1], 4.2), key, 'clampScrew', 'podClamp' + id);
  const lid = new THREE.Group();
  lid.add(slab(rrShape(u.out.w, u.out.h, 2.2), u.lid, MAT.lid, D));
  for (const x of [-10, 10]) for (const y of [-1, 1]) lid.add(box(4, 1, 2.4, MAT.lid, x, y * (u.in.h / 2 - 0.5), D - 1.2));   // snap hooks
  const tri = new THREE.Shape(); tri.moveTo(-s * 7, 0); tri.lineTo(s * 2, 4.5); tri.lineTo(s * 2, -4.5); tri.closePath();   // arrow: points to the wearer's front
  lid.add(slab(tri, 0.5, MAT.shell, D + u.lid));
  reg(lid, key, 'lid', 'podLid' + id);
}

// ---------- wires and cables: rebuilt whenever the layers move ----------
const wireGroup = new THREE.Group(); scene.add(wireGroup);
const byC7 = Object.fromEntries(C7.parts.map((p) => [p.id, p]));
const pt = (unit, level, x, y, z) => ({ unit, level, p: V(x, y, z) });
const world = (q) => AT[q.unit].clone().add(q.p).add(V(0, 0, lift(q.unit, q.level)));
const c7Pin = ([id, pin]) => { const p = byC7[id]; return pt('c7', p.level, ...(p.pins && !p.kind ? p.pins[pin] : pinAt(p, pin))); };
const PATHS = [];   // { cable, mat, r, pts, plugs: [[point, dir]] }
function definePaths() {
  // conductors inside the C7 box
  C7_WIRES.forEach((w, i) => {
    const A = c7Pin(w.a), B = c7Pin(w.b), pts = [A];
    if (w.via) for (const [x, y, z] of w.via) pts.push(pt('c7', w.viaLevel || 'floor', x, y, z));
    else {   // jumpers hang under the tray: leave the housing, swing through the lower level, come back up
      const d = B.p.clone().sub(A.p).setZ(0).normalize(), side = V(-d.y, d.x, 0), k = (i % 4) - 1.5;
      pts.push(pt('c7', 'tray', A.p.x + d.x * 4, A.p.y + d.y * 4, 10));   // above the battery (top at 8.3), below the tray
      const m = A.p.clone().lerp(B.p, 0.5).addScaledVector(side, k * 1.6); pts.push(pt('c7', 'tray', m.x, m.y, 13 + Math.abs(k)));
      pts.push(pt('c7', 'tray', B.p.x - d.x * 4, B.p.y - d.y * 4, 10));
    }
    pts.push(B);
    PATHS.push({ cable: w.cable, mat: NET[w.net].mat, r: 0.6, pts });
  });
  // Qwiic cables: one tube each (four conductors inside)
  const zq = C7.zBoard + 1.6 + 1.45;
  const link = C7.link.path.map(([x, y]) => pt('c7', 'board', x, y, zq));
  PATHS.push({ cable: 'link', mat: MAT.cable, r: 1.3, pts: link, plugs: [[link[0], 1], [link[link.length - 1], -1]] });
  // one 20 cm cable per ear: adapter in the C7 box -> notch in the top wall -> notch in the pod -> under the clamp -> socket
  for (const [side, sx, port, pk] of [['earL', -1, C7.ports.earL, 'podL'], ['earR', 1, C7.ports.earR, 'podR']]) {
    const sock = pinAt(byC7[port[0]], port[1]), gx = sx * 42.5, top = C7.in.h / 2, po = DATA[pk], s = po.s;
    const q = pinAt(po.parts[0], po.socket), zc = 1.5, bottom = -po.in.h / 2;
    const pts = [pt('c7', 'board', sock[0], sock[1], zq), pt('c7', 'board', sock[0] + sx * 3, sock[1], zq), pt('c7', 'board', gx, sock[1] + 3.2, zq),
      pt('c7', 'base', gx, top - 1.5, zq), pt('c7', 'base', gx, top + 4, zq), pt('c7', 'base', gx + sx * 12, top + 34, 14),
      pt(pk, 'base', po.exit.x, bottom - 30, zc), pt(pk, 'base', po.exit.x, bottom - 2, zc), pt(pk, 'base', po.exit.x, po.clampAt[1], zc), pt(pk, 'base', po.exit.x, -3.5, 2.4),
      pt(pk, 'board', q[0] + s * 4, q[1], q[2]), pt(pk, 'board', q[0], q[1], q[2])];
    PATHS.push({ cable: side, mat: MAT.cable, r: 1.3, pts, plugs: [[pts[0], -sx], [pts[pts.length - 1], -s]], ties: [pt('c7', 'base', gx, top - 2.6, zq)] });
  }
}
const plugGeo = new THREE.BoxGeometry(3.4, 4.6, 2.4), tieGeo = new THREE.TorusGeometry(1.9, 0.5, 8, 20).rotateX(Math.PI / 2);
function rebuildWires() {
  for (const m of [...wireGroup.children]) { if (m.geometry !== plugGeo && m.geometry !== tieGeo) m.geometry.dispose(); wireGroup.remove(m); }
  for (const p of PATHS) {
    const pts = p.pts.map(world), curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(40, pts.length * 14), p.r, 8), p.mat);
    m.userData.part = p.cable; m.userData.unitKey = p.pts[0].unit; wireGroup.add(m);
    for (const [q, dir] of p.plugs || []) { const g = mesh(plugGeo, MAT.plug); g.position.copy(world(q)).add(V(dir * 1.2, 0, 0)); g.userData.part = p.cable; g.userData.unitKey = q.unit; wireGroup.add(g); }
    for (const q of p.ties || []) { const g = mesh(tieGeo, MAT.tie); g.position.copy(world(q)); g.userData.part = p.cable; g.userData.unitKey = q.unit; wireGroup.add(g); }
  }
  wireGroup.visible = st.wires;
}

// ---------- state -> scene ----------
function applyExplode() {
  for (const o of items) o.position.z = o.userData.z0 + lift(o.userData.unit, o.userData.level);
  rebuildWires(); updateSel(); measureLabels(); dirty = true;
}
function applyLook() {
  for (const [m, a] of [[MAT.shell, 0.3], [MAT.lid, 0.16], [MAT.tray, 0.5]]) { m.transparent = st.xray; m.opacity = st.xray ? a : 1; m.depthWrite = !st.xray; m.needsUpdate = true; }
  for (const o of items) if (o.userData.level === 'lid' || o.userData.level === 'lidScrew') o.visible = !st.hideLid;
  wireGroup.visible = st.wires; measureLabels(); dirty = true;
}
const FOCUS = { fOver: ['over', V(0, 90, 10), 620], fC7: ['c7', V(0, 0, 14), 340], fPodL: ['podL', AT.podL.clone().add(V(0, 0, 4)), 150], fPodR: ['podR', AT.podR.clone().add(V(0, 0, 4)), 150] };
const VIEWS = { vIso: V(-0.42, -0.5, 0.76), vFront: V(0, -0.02, 1), vSide: V(1, 0, 0.06), vTop: V(0, 1, 0.08), vBack: V(0, -0.02, -1) };
function setCamera() {
  const [, target, dist] = Object.values(FOCUS).find((f) => f[0] === st.focus);
  const spread = st.focus === 'over' ? 0 : (st.focus === 'c7' ? 230 : 30) * st.e;      // keep the exploded stack in view
  const back = Math.max(1, 1.15 / camera.aspect) * (1 + spread / dist * 1.1);
  controls.target.copy(target).add(V(0, 0, st.focus === 'c7' ? 45 * st.e : 10 * st.e));
  camera.up.set(0, st.view === 'vTop' ? 0 : 1, st.view === 'vTop' ? 1 : 0);
  camera.position.copy(controls.target).addScaledVector(VIEWS[st.view].clone().normalize(), dist * back);
  controls.update(); dirty = true;
}

// ---------- panel ----------
const allParts = {};   // part id -> { info, unit name }
for (const [key, u] of Object.entries(DATA)) for (const p of [...u.shell, ...u.parts]) allParts[p.id] = { ...p, unitName: u.name, unitKey: key };
const CABLE_INFO = { ...C7_CABLES };
function showInfo(id) {
  const boxEl = $('info'); boxEl.innerHTML = '';
  const h = document.createElement('h3'); boxEl.appendChild(h);
  const p = allParts[id], c = CABLE_INFO[id];
  if (!p && !c) { h.textContent = 'แตะชิ้นส่วนในโมเดล'; const t = document.createElement('p'); t.textContent = 'เลือกชิ้นส่วน สาย หรือแถวในตารางด้านล่าง เพื่อดูว่าชิ้นนั้นอยู่ตรงไหน ยึดกับอะไร และต่อไปไหน'; boxEl.appendChild(t); return; }
  h.textContent = p ? p.name : c[0];
  const dl = document.createElement('dl');
  const row = (k, v) => { if (!v) return; const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); };
  if (p) { row('อยู่ใน', p.unitName); row('ตำแหน่ง', p.where); row('ขนาด', p.size); row('ยึดด้วย', p.mount); row('ต่อกับ', p.links); }
  else { row('ทางเดิน', c[1]); const ws = C7_WIRES.filter((w) => w.cable === id); if (ws.length) row('ชนิดสาย', ws[0].type); }
  boxEl.appendChild(dl);
}
const selBox = new THREE.Box3(), selHelper = new THREE.Box3Helper(selBox, 0xffd34d); selHelper.visible = false; scene.add(selHelper);
selHelper.material.depthTest = false; selHelper.renderOrder = 9;
function updateSel() {
  selBox.makeEmpty();
  if (st.sel) {
    scene.updateMatrixWorld(true);
    const want = (o) => o.userData.part === st.sel && (st.focus === 'over' || !allParts[st.sel] || o.userData.unitKey === selUnit());
    for (const o of pickables) if (want(o) && shown(o)) selBox.expandByObject(o);
    for (const o of wireGroup.children) if (o.userData.part === st.sel) selBox.expandByObject(o);
  }
  selHelper.visible = !selBox.isEmpty();
}
const selUnit = () => { const p = allParts[st.sel]; return p ? p.unitKey : null; };
function select(id) {
  st.sel = id && (allParts[id] || CABLE_INFO[id]) ? id : null;
  showInfo(st.sel); updateSel();
  document.querySelectorAll('tr.pick').forEach((tr) => { tr.dataset.on = tr.dataset.id === st.sel ? '1' : '0'; });
  dirty = true;
}
function dot(css) { const d = document.createElement('span'); d.className = 'dot'; d.style.background = 'var(' + css + ')'; return d; }
function renderTables() {
  const t = $('partsTable'); t.innerHTML = '';
  const head = (tbl, cols) => { const hr = tbl.insertRow(); for (const x of cols) { const th = document.createElement('th'); th.textContent = x; hr.appendChild(th); } };
  head(t, ['ชิ้น', 'ยึดด้วย']);
  const keys = st.focus === 'over' ? ['c7', 'podL', 'podR'] : [st.focus];
  const order = ['lid', 'board', 'tray', 'floor', 'clamp', 'base', 'strip'];
  for (const k of keys) {
    const u = DATA[k], g = t.insertRow().insertCell(); g.colSpan = 2; g.className = 'grp';
    g.textContent = `${u.name} · ${u.out.w} × ${u.out.h} × ${u.out.d.toFixed(1).replace('.0', '')} มม.`;
    const list = [...u.shell, ...u.parts].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
    for (const p of list) {
      const tr = t.insertRow(); tr.className = 'pick'; tr.dataset.id = p.id; tr.tabIndex = 0;
      const c0 = tr.insertCell(); c0.textContent = p.name; const sm = document.createElement('small'); sm.textContent = p.size; c0.appendChild(sm);
      tr.insertCell().textContent = p.mount;
      tr.onclick = () => select(p.id); tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p.id); } };
    }
  }
  const w = $('wireTable'); w.innerHTML = ''; head(w, ['สาย', 'จาก', 'ไป']);
  const nm = ([id, pin]) => `${allParts[id].name.replace(/ \(.*\)$/, '').replace(' บูสต์เป็น 5 V', '').replace(' ชาร์จ USB-C', '')} ${id === 'sw' ? (pin === 'A' ? 'ขาริม' : 'ขากลาง') : pin.replace(/^GND[LR]$/, 'GND')}`;
  for (const [cid, [name, route]] of Object.entries(C7_CABLES)) {
    const tr = w.insertRow(); tr.className = 'pick'; tr.dataset.id = cid; tr.tabIndex = 0;
    const g = tr.insertCell(); g.colSpan = 3; g.className = 'grp'; g.textContent = name; const sm = document.createElement('small'); sm.textContent = route; sm.style.fontWeight = '400'; g.appendChild(sm);
    tr.onclick = () => select(cid); tr.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(cid); } };
    for (const x of C7_WIRES.filter((q) => q.cable === cid)) {
      const r = w.insertRow(), c0 = r.insertCell(); c0.style.whiteSpace = 'nowrap'; c0.append(dot(NET[x.net].css), NET[x.net].name);
      r.insertCell().textContent = nm(x.a); r.insertCell().textContent = nm(x.b);
    }
  }
  const s = $('stackTable'); s.innerHTML = ''; head(s, ['จากพื้นกล่องขึ้นไป', 'มม.']);
  let sum = 0;
  for (const [name, mm] of C7.stack) { const r = s.insertRow(); r.insertCell().textContent = name; const c = r.insertCell(); c.className = 'num mono'; c.textContent = mm.toFixed(1); sum += mm; }
  for (const [name, mm] of [['รวมความสูงด้านใน', sum], ['พื้น 2 + ฝา 2', 4], ['ความหนากล่อง', sum + 4]]) { const r = s.insertRow(), a = r.insertCell(), c = r.insertCell(); a.innerHTML = '<b></b>'; a.firstChild.textContent = name; c.className = 'num mono'; c.textContent = mm.toFixed(1); }
  const hw = $('hwTable'); hw.innerHTML = ''; head(hw, ['รายการ', 'จำนวน']);
  const extra = [['เคเบิลไทร์เล็ก (รัดสายหูในกล่อง C7 กันดึง)', 2], ['ยางกันสายแบบผ่า (ร่องสายของกล่อง C7)', 2], ['เทปโฟมสองหน้า (ใต้แบต)', '1 ชิ้น'], ['แผ่นตีนตุ๊กแก 34 × 24 มม. (ใต้ตลับ)', 2]];
  for (const [n, c] of [...hardware(), ...extra]) { const r = hw.insertRow(); r.insertCell().textContent = n; const cc = r.insertCell(); cc.className = 'num mono'; cc.textContent = c; }
}
function showSize() {
  const u = st.focus === 'over' ? null : DATA[st.focus];
  $('sizeName').textContent = u ? u.name + ' (ขนาดนอก)' : 'ภาพรวม';
  $('sizeOut').textContent = u ? `${u.out.w} × ${u.out.h} × ${+u.out.d.toFixed(1)} มม.` : 'ระยะระหว่างกล่องไม่ตรงมาตราส่วน';
}

// ---------- picking ----------
const pick = new THREE.Raycaster(), ndc = new THREE.Vector2();
const shown = (o) => { while (o) { if (!o.visible) return false; o = o.parent; } return true; };
const SEE_THROUGH = new Set(['base', 'lid', 'tray', 'podBaseL', 'podBaseR', 'podLidL', 'podLidR']);
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  pick.setFromCamera(ndc, camera);
  const hits = pick.intersectObjects(pickables.concat(wireGroup.children), false).filter((h) => shown(h.object));
  // with see-through walls on, a click goes to the part behind the wall first
  const inner = st.xray ? hits.find((h) => !SEE_THROUGH.has(h.object.userData.part)) : null;
  const h = inner || hits[0];
  select(h ? h.object.userData.part : null);
});

// ---------- UI ----------
const press = (ids, on) => { for (const id of ids) $(id).setAttribute('aria-pressed', id === on); };
for (const id of Object.keys(FOCUS)) $(id).onclick = () => { st.focus = FOCUS[id][0]; press(Object.keys(FOCUS), id); renderTables(); showSize(); setCamera(); select(st.sel); };
for (const id of Object.keys(VIEWS)) $(id).onclick = () => { st.view = id; setCamera(); };
function setGoal(g) { st.goal = g; press(['mAsm', 'mExp'], g > 0.5 ? 'mExp' : 'mAsm'); }
$('mAsm').onclick = () => setGoal(0);
$('mExp').onclick = () => setGoal(1);
$('sExp').addEventListener('input', (e) => { st.goal = st.e = e.target.value / 100; press(['mAsm', 'mExp'], st.e > 0.5 ? 'mExp' : 'mAsm'); $('vExp').textContent = e.target.value + '%'; applyExplode(); setCamera(); });
$('xray').onchange = (e) => { st.xray = e.target.checked; applyLook(); };
$('hideLid').onchange = (e) => { st.hideLid = e.target.checked; applyLook(); updateSel(); };
$('wires').onchange = (e) => { st.wires = e.target.checked; applyLook(); };
$('labelsOn').onchange = (e) => { st.labels = e.target.checked; dirty = true; };

// ---------- name labels on every part (toggle). A label sits near its part; a thin line joins the two. ----------
const SHORT = {
  base: 'ฐานกล่อง', tray: 'ถาดบอร์ด', lid: 'ฝากล่อง', clamp: 'แผ่นหนีบแถบ', strip: 'แถบพาดบ่า',
  bat: 'แบต LiPo', mt: 'MT3608', tp: 'TP4056', sw: 'สวิตช์', cap: 'ตัวเก็บประจุ', esp: 'ESP32', hubA: 'Adapter 1', hubB: 'Adapter 2', mpu: 'GY-521',
  bnoL: 'BNO085 ซ้าย', bnoR: 'BNO085 ขวา', podBaseL: 'ฐานตลับ', podBaseR: 'ฐานตลับ', podLidL: 'ฝาตลับ', podLidR: 'ฝาตลับ', podClampL: 'แคลมป์รัดสาย', podClampR: 'แคลมป์รัดสาย',
};
const labelLayer = $('labels'), leaderSvg = $('leaders'), labels = [];
for (const [unit, u] of Object.entries(DATA)) for (const p of [...u.shell, ...u.parts]) {
  const el = document.createElement('button'); el.type = 'button'; el.className = 'lbl'; el.textContent = SHORT[p.id] || p.name; el.hidden = true;
  el.onclick = () => select(p.id);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  labelLayer.appendChild(el); leaderSvg.appendChild(line);
  labels.push({ unit, id: p.id, level: p.level, el, line, box: new THREE.Box3(), w: 0 });
}
const labelOf = new Map(labels.map((l) => [l.unit + '|' + l.id, l]));
// boxes change only when layers move or parts are hidden, not when the camera moves
function measureLabels() {
  scene.updateMatrixWorld(true);
  for (const l of labels) l.box.makeEmpty();
  for (const o of pickables) { const l = labelOf.get(o.userData.unitKey + '|' + o.userData.part); if (l && shown(o)) l.box.expandByObject(o); }
}
const anchor = V(), mid = V();
function placeLabels() {
  const W = stage.clientWidth, H = stage.clientHeight, placed = [], h = 20;
  for (const l of labels) {
    let ok = st.labels && (st.focus === 'over' || l.unit === st.focus) && !l.box.isEmpty();
    if (ok) {
      const b = l.box; b.getCenter(mid);
      // shell pieces are labelled at a corner so they do not sit on top of the boards inside them
      if (l.level === 'base') anchor.set(b.min.x + 4, b.min.y + 2, mid.z);
      else if (l.level === 'lid') anchor.set(b.max.x - 4, b.max.y - 2, b.max.z);
      else if (l.level === 'tray') anchor.set(b.max.x - 4, b.min.y + 3, b.max.z);
      else if (l.level === 'strip') anchor.set(b.max.x - 8, mid.y, mid.z);
      else anchor.set(mid.x, mid.y, b.max.z);
      anchor.project(camera);
      ok = anchor.z < 1 && Math.abs(anchor.x) < 1 && Math.abs(anchor.y) < 1;
    }
    l.el.hidden = !ok; l.line.style.display = ok ? '' : 'none';
    if (!ok) continue;
    if (!l.w) l.w = l.el.offsetWidth || 60;
    const ax = (anchor.x + 1) / 2 * W, ay = (1 - anchor.y) / 2 * H, w = l.w;
    const x = Math.min(W - w / 2 - 4, Math.max(w / 2 + 4, ax)); let y = ay - 16;
    for (let n = 0; n < 24; n++) {   // move up until it is clear of the labels already placed
      const hit = placed.find((r) => Math.abs(r.x - x) < (r.w + w) / 2 + 4 && Math.abs(r.y - y) < h + 2);
      if (!hit) break; y = hit.y - h - 3;
    }
    y = Math.max(12, y); placed.push({ x, y, w });
    l.el.style.left = x + 'px'; l.el.style.top = y + 'px'; l.el.dataset.on = l.id === st.sel ? '1' : '0';
    l.line.setAttribute('x1', ax); l.line.setAttribute('y1', ay); l.line.setAttribute('x2', x); l.line.setAttribute('y2', y);
  }
}

// ---------- pop-up: the whole structure in words. What each part does, and what connects to what. ----------
const ROLE = {
  base: 'โครงหลักของกล่อง รับทุกชิ้นไว้ข้างใน มีช่องให้เสียบสาย USB และให้ก้านสวิตช์โผล่',
  tray: 'แบ่งกล่องเป็น 2 ชั้น: วงจรไฟและแบตอยู่ชั้นล่าง บอร์ดอยู่ชั้นบน ขาบอร์ดและหัวจัมเปอร์ลอดร่องของถาดลงไป',
  lid: 'ปิดกล่องและกดถาดไว้กับเสา ถอดออกเพื่อเข้าถึงบอร์ด',
  clamp: 'หนีบแถบพาดบ่าไว้กับหลังกล่อง กล่องจึงอยู่กลางหลังคอ แผ่นรองนุ่มเป็นด้านที่แตะตัว',
  strip: 'โครงพาดบ่าทั้งสองข้าง รับน้ำหนักกล่อง C7 ดัดให้เข้ารูปบ่าได้',
  esp: 'ตัวประมวลผลหลัก อ่านเซ็นเซอร์ทั้ง 3 ตัวผ่านบัส I2C คำนวณมุมคอ (ค่าประมาณ) แล้วส่งออกทาง Wi-Fi ไปเซิร์ฟเวอร์ หรือทาง micro-USB ไปหน้าเว็บ และจ่ายไฟ 3.3 V ให้เซ็นเซอร์ทุกตัวจากขา 3V3 เสาอากาศ Wi-Fi อยู่ปลายบอร์ดด้านกลางกล่อง',
  hubA: 'จุดแยกสายตัวที่ 1 เป็นแผ่นลายทองแดง ไม่มีชิป รับสาย 4 เส้นจาก ESP32 แล้วแยกไปหูซ้าย (สาย 20 ซม. เส้นเดียว) และไป Adapter 2',
  hubB: 'จุดแยกสายตัวที่ 2 รับบัสต่อจาก Adapter 1 แล้วแยกไป GY-521 และไปหูขวา',
  mpu: 'เซ็นเซอร์วัดความเอียงของต้นคอ ใช้ประมาณว่าคอยื่นไปข้างหน้าเท่าไร ถ้าไม่มีตัวนี้ ค่ามุมคอจะประมาณจากการก้มศีรษะอย่างเดียว',
  bat: 'แหล่งไฟตอนใช้ผ่าน Wi-Fi โดยไม่เสียบสาย ความจุ 1100 mAh ใช้ได้ราว 3–4 ชั่วโมงต่อการชาร์จ (ค่าประมาณ ยังไม่ได้วัด)',
  cap: 'เก็บไฟสำรองไว้จ่ายช่วงสั้น ๆ ตอน Wi-Fi ส่งข้อมูล ซึ่ง ESP32 ดึงกระแสสูงเป็นจังหวะ ถ้าไม่มี ไฟ 5 V อาจตกจนบอร์ดรีเซ็ต',
  tp: 'ชาร์จแบตจากช่อง USB-C และมีวงจรป้องกันแบตหมดเกินและลัดวงจร ตัวต้านทานตั้งกระแสบนบอร์ดเปลี่ยนเป็น 3 kΩ ให้ชาร์จที่ 400 mA แทน 1 A เพื่อถนอมแบต',
  sw: 'เปิดปิดเครื่อง โดยตัดสายไฟบวกระหว่าง TP4056 กับ MT3608',
  mt: 'ยกแรงดันแบตเป็น 5 V ให้ ESP32 ต้องตั้งให้ได้ 5.0 V ก่อนต่อ',
  bnoL: 'เซ็นเซอร์วัดการหมุนของศีรษะที่หูซ้าย (ก้ม เอียง หัน) ที่อยู่ I2C 0x4A',
  bnoR: 'เซ็นเซอร์วัดการหมุนของศีรษะที่หูขวา ที่อยู่ I2C 0x4B (ตั้งด้วยสายสั้น 3Vo → DI)',
  podBaseL: 'ยึด BNO085 ให้นิ่งกับฝาครอบหูฟัง ถ้าตลับขยับ ค่าที่วัดจะเพี้ยน', podBaseR: 'ยึด BNO085 ให้นิ่งกับฝาครอบหูฟัง ถ้าตลับขยับ ค่าที่วัดจะเพี้ยน',
  podLidL: 'ปิดตลับ ลูกศรบนฝาบอกทิศด้านหน้า ใช้ตอนแปะตลับให้หันถูกทาง', podLidR: 'ปิดตลับ ลูกศรบนฝาบอกทิศด้านหน้า ใช้ตอนแปะตลับให้หันถูกทาง',
  podClampL: 'รับแรงดึงของสาย ไม่ให้แรงไปถึงหัวต่อเล็กบนบอร์ด', podClampR: 'รับแรงดึงของสาย ไม่ให้แรงไปถึงหัวต่อเล็กบนบอร์ด',
};
function buildExplain() {
  const el = (tag, text, parent) => { const n = document.createElement(tag); if (text) n.textContent = text; if (parent) parent.appendChild(n); return n; };
  const partsEl = $('explainParts'), order = ['board', 'floor', 'tray', 'lid', 'base', 'clamp', 'strip'];
  for (const k of ['c7', 'podL', 'podR']) {
    const u = DATA[k];
    el('h4', `${u.name} · ${u.out.w} × ${u.out.h} × ${+u.out.d.toFixed(1)} มม.`, partsEl);
    for (const p of [...u.shell, ...u.parts].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level))) {
      const dl = el('dl', '', partsEl), row = (a, b) => { if (b) { el('dt', a, dl); el('dd', b, dl); } };
      const dt = el('dt', '', dl); dt.style.gridColumn = '1 / -1'; dt.style.paddingTop = '8px'; const b = el('b', p.name, dt); b.style.color = 'var(--fg)'; b.style.fontSize = '13.5px';
      row('หน้าที่', ROLE[p.id]); row('ตำแหน่ง', p.where); row('ยึดด้วย', p.mount); row('ต่อกับ', p.links);
    }
  }
  const wiresEl = $('explainWires');
  const nm = ([id, pin]) => `${SHORT[id]} ${id === 'sw' ? (pin === 'A' ? 'ขาริม' : 'ขากลาง') : pin.replace(/^GND[LR]$/, 'GND')}`;
  for (const [cid, [name, route]] of Object.entries(C7_CABLES)) {
    el('h4', name, wiresEl); el('p', route, wiresEl);
    const ws = C7_WIRES.filter((w) => w.cable === cid);
    if (ws.length) { const ul = el('ul', '', wiresEl); for (const w of ws) el('li', `${NET[w.net].name}: ${nm(w.a)} → ${nm(w.b)}`, ul); }
  }
}
function setExplain(open) {
  $('explain').hidden = !open; $('openExplain').setAttribute('aria-expanded', open);
  if (open) $('closeExplain').focus(); else $('openExplain').focus();
}
$('openExplain').onclick = () => setExplain($('explain').hidden);
$('closeExplain').onclick = () => setExplain(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('explain').hidden) setExplain(false); });

// ---------- loop: render only when something changed ----------
const tagEl = $('tag'), tmp = V();
function placeTag() {
  if (!selHelper.visible || (st.labels && allParts[st.sel])) { tagEl.hidden = true; return; }   // the part's own label is highlighted instead
  selBox.getCenter(tmp); tmp.y = selBox.max.y; tmp.project(camera);
  const p = allParts[st.sel], c = CABLE_INFO[st.sel];
  tagEl.textContent = p ? p.name : c[0]; tagEl.hidden = tmp.z > 1;
  tagEl.style.left = Math.min(stage.clientWidth - 70, Math.max(70, (tmp.x + 1) / 2 * stage.clientWidth)) + 'px';
  tagEl.style.top = Math.max(26, (1 - tmp.y) / 2 * stage.clientHeight - 10) + 'px';
}
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
}
new ResizeObserver(() => { resize(); setCamera(); }).observe(stage);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (st.e !== st.goal) {
    st.e = reduced.matches ? st.goal : THREE.MathUtils.clamp(st.e + Math.sign(st.goal - st.e) * dt / 0.6, Math.min(st.e, st.goal), Math.max(st.e, st.goal));
    $('sExp').value = Math.round(st.e * 100); $('vExp').textContent = Math.round(st.e * 100) + '%';
    applyExplode(); setCamera();
  }
  controls.update();
  if (dirty) { dirty = false; renderer.render(scene, camera); placeTag(); placeLabels(); }
  requestAnimationFrame(frame);
}
// board silkscreen is drawn on canvases, so wait for the local fonts first
try { await Promise.all([document.fonts.load('600 44px "IBM Plex Sans Thai"', 'กขค ABC'), document.fonts.load('700 24px "IBM Plex Mono"', 'ABC 123')]); } catch { /* fall back to system fonts */ }
buildC7(); for (const k of ['podL', 'podR']) buildPod(k);
for (const [id, v] of [['earIn', `ราว ${Math.max(EAR_CABLE.inBox.L, EAR_CABLE.inBox.R).toFixed(0)} มม.`], ['earPod', `${EAR_CABLE.inPod} มม.`], ['earOut', `${(EAR_CABLE.outside / 10).toFixed(1)} ซม.`]]) if ($(id)) $(id).textContent = v;
definePaths(); resize(); applyLook(); applyExplode(); renderTables(); showSize(); showInfo(null); buildExplain(); setCamera();
window.c7Structure = { st, items, PATHS };
requestAnimationFrame(frame);
