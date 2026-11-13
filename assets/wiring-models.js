// Procedural models for wiring.html: the user's own over-ear headphone, our clip-on ear pods
// and the C7 brace bent from an aluminium finger splint. No DOM here. Units are centimetres.
// Frame: +X = wearer's left, +Y = up, +Z = forward (same as the head scan).
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const phys = (o) => new THREE.MeshPhysicalMaterial(o);

// Dimension contract. Every builder reads from here so mating parts share one datum.
export const DIM = {
  cup: { ry: 5.0, rz: 4.2, cushion: 2.2, shellAt: 2.15, shellDepth: 3.0, faceScale: 0.66 },
  pod: { z: 3.9, y: 2.85, x: 0.9, pad: 0.14 },                // 39 x 28.5 x 9 mm + mounting pad (structure-layout.js)
  strip: { stock: 45.7, alu: 0.15, foam: 0.4, skinGap: 0.03 }, // 18 in strip; thickness is assumed
  box: { w: 9.6, h: 6.0, d: 3.5 },                             // 96 x 60 x 35 mm, two levels; the inside is laid out in structure-layout.js
};
export const STRIP_WIDTHS = { half: 1.27, three: 1.905, one: 2.54 };   // 1/2, 3/4, 1 inch

export const MAT = {
  // the user's headphone: neutral graphite so it reads as "not ours"
  shell: phys({ color: 0x25292e, roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.4 }),
  metal: phys({ color: 0xaeb4ba, roughness: 0.32, metalness: 1 }),
  leather: phys({ color: 0x18181a, roughness: 0.62, sheen: 0.6, sheenColor: new THREE.Color(0x5a5a60) }),
  baffle: phys({ color: 0x2c3036, roughness: 0.85 }),
  // our add-on parts: teal + white
  pod: phys({ color: 0x0f9aa5, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.3 }),
  lid: phys({ color: 0xeaf1f2, roughness: 0.5 }),
  rubber: phys({ color: 0x15171a, roughness: 0.8 }),
  port: new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.4, metalness: 0.6 }),
  led: new THREE.MeshStandardMaterial({ color: 0x7ff7d0, emissive: 0x2fd39f, emissiveIntensity: 1.4, roughness: 0.4 }),
  foam: phys({ color: 0xf2f3f1, roughness: 0.95, sheen: 0.3, sheenColor: new THREE.Color(0xffffff) }),
  alu: phys({ color: 0xd9dde0, roughness: 0.36, metalness: 1 }),
};

function mesh(geo, mat, parent, pos, rot) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.copy(pos);
  if (rot) m.rotation.set(...rot);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m); return m;
}
const tag = (obj, id) => { obj.traverse((o) => { o.userData.part = id; }); return obj; };

// ---------- geometry helpers ----------
function roundRectShape(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
// box with every edge filleted; w,h in XY, d along Z, centred on the origin
export function roundedBox(w, h, d, r) {
  const g = new THREE.ExtrudeGeometry(roundRectShape(w - 2 * r, h - 2 * r, Math.min(r, 0.3) * 0.6), { depth: Math.max(d - 2 * r, 0.001), bevelEnabled: true, bevelSize: r, bevelThickness: r, bevelSegments: 6, curveSegments: 10 });
  g.translate(0, 0, -(d - 2 * r) / 2); g.computeVertexNormals(); return g;
}
// same box with its thin dimension along X (for parts stuck on the side of a cup)
const roundedBoxX = (zExt, yExt, xThick, r) => roundedBox(zExt, yExt, xThick, r).rotateY(Math.PI / 2);
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

// Loft closed rings (same vertex count each) into one closed, outward-facing solid.
export function loftRings(rings, { capStart = true, capEnd = true } = {}) {
  const n = rings[0].length, pos = [], idx = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < n; j++) {
    const a = i * n + j, b = i * n + (j + 1) % n, c = a + n, d = b + n;
    idx.push(a, b, d, a, d, c);
  }
  const cap = (ri, start) => {
    const c = V(0, 0, 0); for (const p of rings[ri]) c.add(p); c.divideScalar(n);
    const ci = pos.length / 3, base = ri * n; pos.push(c.x, c.y, c.z);
    for (let j = 0; j < n; j++) { const a = base + j, b = base + (j + 1) % n; if (start) idx.push(ci, b, a); else idx.push(ci, a, b); }
  };
  if (capStart) cap(0, true);
  if (capEnd) cap(rings.length - 1, false);
  // make the solid face outwards whatever the ring direction was
  let vol = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
      - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
      + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// rounded-rectangle cross-section, [u (width), v (thickness)] pairs going round once
function rrSection(w, t, r, k = 4) {
  const out = [], cx = w / 2 - r, cy = t / 2 - r;
  for (const [x, y, a0] of [[cx, cy, 0], [-cx, cy, Math.PI / 2], [-cx, -cy, Math.PI], [cx, -cy, 1.5 * Math.PI]]) {
    for (let i = 0; i <= k; i++) { const a = a0 + i / k * Math.PI / 2; out.push([x + Math.cos(a) * r, y + Math.sin(a) * r]); }
  }
  return out;
}
// Sweep a flat strip along a path. The frame comes from the given surface normals, not from
// Frenet frames, so the strip always lies flat on the body and never twists.
export function sweepStrip(pts, nrms, w, t, r, { roundEnds = false } = {}) {
  const N = pts.length, sec = rrSection(w, t, r), rings = [];
  const len = [0]; for (let i = 1; i < N; i++) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const L = len[N - 1], tan = V(), b = V(), n2 = V();
  for (let i = 0; i < N; i++) {
    tan.copy(pts[Math.min(i + 1, N - 1)]).sub(pts[Math.max(i - 1, 0)]).normalize();
    b.crossVectors(tan, nrms[i]).normalize(); n2.crossVectors(b, tan);
    let ws = 1;
    if (roundEnds) { const d = Math.min(len[i], L - len[i]), R = w / 2; if (d < R) ws = Math.max(0.1, Math.sqrt(1 - (1 - d / R) ** 2)); }
    rings.push(sec.map(([u, v]) => pts[i].clone().addScaledVector(b, u * ws).addScaledVector(n2, v)));
  }
  return loftRings(rings);
}

// ---------- the user's over-ear headphone ----------
// hit(origin, dir) raycasts the head from inside and returns { p, n } or null.
// attach is the group that follows the head. Returns the two cup groups and a label point.
export function buildHeadphone({ hit, attach, ears, headCentre }) {
  const C = DIM.cup, cups = {}, tops = {};
  for (const [id, s] of [['L', 1], ['R', -1]]) {
    const e = ears[id], cy = e.y + 0.2, cz = e.z - 0.35;
    // cushion plane: just outside the skull around the ear (ring of rays)
    let c = 0;
    for (let k = 0; k < 10; k++) {
      const a = k / 10 * Math.PI * 2, h = hit(V(0, cy + Math.sin(a) * 4.4, cz + Math.cos(a) * 3.6), V(s, 0, 0));
      if (h) c = Math.max(c, Math.abs(h.p.x));
    }
    c += 0.15;
    const g = new THREE.Group(); g.position.set(s * c, cy, cz); attach.add(g); cups[id] = g;
    // cushion ring, then the baffle that closes the ear opening
    mesh(extrudeX(ellipseShape(C.ry - 0.15, C.rz - 0.15, [3.15, 2.5]), C.cushion, 0.75, s), MAT.leather, g);
    mesh(extrudeX(ellipseShape(C.ry - 0.5, C.rz - 0.5), 0.25, 0, s), MAT.baffle, g, V(s * 1.9, 0, 0));
    // closed-back shell: one loft that domes in to a flat outer face (where our pod sticks)
    const prof = [[0, 0.95], [0.18, 1], [1.3, 1], [1.95, 0.965], [2.45, 0.89], [2.78, 0.79], [2.94, 0.72], [C.shellDepth, C.faceScale]];
    const rings = prof.map(([dx, k]) => {
      const ring = [];
      for (let j = 0; j < 72; j++) { const a = j / 72 * Math.PI * 2; ring.push(V(s * (C.shellAt + dx), Math.sin(a) * C.ry * k, Math.cos(a) * C.rz * k)); }
      return ring;
    });
    mesh(loftRings(rings), MAT.shell, g);
    // yoke: aluminium fork over the top half of the cup, pivots front and back, hinge block on top
    const yk = [];
    for (let i = 0; i <= 24; i++) { const a = i / 24 * Math.PI; yk.push(V(s * 3.7, Math.sin(a) * (C.ry + 0.55), Math.cos(a) * (C.rz + 0.55))); }
    mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(yk), 60, 0.3, 14), MAT.metal, g);
    for (const z of [1, -1]) mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.5, 24), MAT.metal, g, V(s * 3.5, 0, z * (C.rz + 0.5)), [Math.PI / 2, 0, 0]);
    mesh(roundedBox(1.0, 1.5, 1.7, 0.3), MAT.shell, g, V(s * 3.7, C.ry + 1.0, 0));
    g.updateMatrixWorld(true);
    tops[id] = g.localToWorld(V(s * 3.7, C.ry + 0.9, 0));
    tag(g, 'phones');
  }
  // headband + pad: flat strips swept over the skull, kept flat by radial normals
  const arc = [], pad = [];
  for (let d = 58; d >= -58; d -= 8) {
    const a = THREE.MathUtils.degToRad(d), dir = V(Math.sin(a), Math.cos(a), 0), h = hit(headCentre, dir);
    if (!h) continue;
    arc.push(h.p.clone().addScaledVector(dir, 2.3)); pad.push(h.p.clone().addScaledVector(dir, 1.35));
  }
  const toLocal = (p) => attach.worldToLocal(p.clone());
  const hc = toLocal(headCentre);
  const sweep = (ctrl, w, t, r, steps) => {
    const pts = new THREE.CatmullRomCurve3(ctrl.map(toLocal), false, 'centripetal').getSpacedPoints(steps);
    const nrms = pts.map((p) => V(p.x - hc.x, p.y - hc.y, 0).normalize());
    return sweepStrip(pts, nrms, w, t, r);
  };
  const bandCtrl = [tops.L, tops.L.clone().add(V(0, 1.6, 0)), ...arc, tops.R.clone().add(V(0, 1.6, 0)), tops.R];
  tag(mesh(sweep(bandCtrl, 3.0, 0.45, 0.2, 200), MAT.shell, attach), 'phones');
  tag(mesh(sweep(pad, 2.6, 0.75, 0.34, 140), MAT.leather, attach), 'phones');
  return { cups, labelAt: toLocal(arc[Math.floor(arc.length / 2)]).add(V(0, 1.4, 0)) };
}

// ---------- our ear pod (one BNO085 inside, added in a later round) ----------
// Origin = centre of the mounting face, x outward (sign s). Add it to a cup group at the cup's outer face.
export function buildEarPod(s, id) {
  const P = DIM.pod, g = new THREE.Group();
  mesh(roundedBoxX(P.z - 0.4, P.y - 0.4, P.pad, 0.06), MAT.rubber, g, V(s * P.pad / 2, 0, 0));               // hook-and-loop / adhesive pad
  mesh(roundedBoxX(P.z, P.y, P.x, 0.28), MAT.pod, g, V(s * (P.pad + P.x / 2), 0, 0));                        // housing
  mesh(roundedBoxX(P.z - 0.9, P.y - 0.9, 0.1, 0.045), MAT.lid, g, V(s * (P.pad + P.x + 0.02), 0, 0));        // lid inlay
  // raised arrow: must point to the wearer's front (+Z) when the pod is stuck on
  const tri = new THREE.Shape(); tri.moveTo(-s * 0.62, 0); tri.lineTo(s * 0.3, 0.45); tri.lineTo(s * 0.3, -0.45); tri.closePath();
  const arrow = new THREE.ExtrudeGeometry(tri, { depth: 0.03, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
  arrow.rotateY(s * Math.PI / 2);
  mesh(arrow, MAT.pod, g, V(s * (P.pad + P.x + 0.07), 0, 0.15));
  mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.05, 16), MAT.led, g, V(s * (P.pad + P.x + 0.08), 0.75, -0.85), [0, 0, Math.PI / 2]);
  // strain relief where the cable will leave (bottom-back corner)
  const exit = V(s * (P.pad + P.x / 2), -P.y / 2 - 0.12, -P.z / 2 + 0.55);
  mesh(new THREE.CapsuleGeometry(0.17, 0.45, 4, 14), MAT.rubber, g, exit, [0.5, 0, 0]);
  g.userData.exit = exit.clone().add(V(0, -0.3, -0.15));   // where the cable leaves, pod-local
  return tag(g, id);
}

// ---------- C7 brace: one aluminium finger splint bent over both shoulders ----------
// Guide points for the wearer's left half, from C7 outwards. They sit just outside the body;
// each one is projected onto the skin by a ray from inside the chest.
const GUIDE_LEFT = [
  [0, -6.2, -12.5], [4.6, -6.6, -12], [8.2, -6.6, -8.8], [9.8, -5.6, -4], [9.9, -6.2, 0.8],
  [9.5, -9, 5.5], [9.0, -12.5, 8], [8.6, -15.2, 8.8], [8.3, -17.6, 9],
];
export function buildC7Brace({ hit, width = STRIP_WIDTHS.three }) {
  const S = DIM.strip, B = DIM.box;
  const left = GUIDE_LEFT.map((a) => V(...a)), right = left.slice(1).reverse().map((p) => V(-p.x, p.y, p.z));
  const guide = new THREE.CatmullRomCurve3([...right, ...left], false, 'centripetal');
  // project onto the skin
  const raw = [];
  for (let i = 0; i <= 240; i++) {
    const G = guide.getPoint(i / 240), core = V(G.x * 0.75, -13.5, -3.2), h = hit(core, G.clone().sub(core));
    if (h) raw.push(h);
  }
  // the scan is faceted: average neighbours so the strip bends smoothly like sheet metal
  const avg = (key, i, k) => { const o = V(0, 0, 0); let c = 0; for (let j = Math.max(0, i - k); j <= Math.min(raw.length - 1, i + k); j++) { o.add(raw[j][key]); c++; } return o.divideScalar(c); };
  const sp = raw.map((_, i) => avg('p', i, 4)), sn = raw.map((_, i) => avg('n', i, 6).normalize());
  const len = [0]; for (let i = 1; i < sp.length; i++) len.push(len[i - 1] + sp[i].distanceTo(sp[i - 1]));
  const at = (d) => {   // skin point + normal at arc length d
    let i = 1; while (i < len.length - 1 && len[i] < d) i++;
    const f = THREE.MathUtils.clamp((d - len[i - 1]) / (len[i] - len[i - 1] || 1), 0, 1);
    return { p: sp[i - 1].clone().lerp(sp[i], f), n: sn[i - 1].clone().lerp(sn[i], f).normalize() };
  };
  // C7 = where the path crosses the body's midline; the strip is centred there
  let mid = len[len.length - 1] / 2;
  for (let i = 1; i < sp.length; i++) if (sp[i - 1].x <= 0 && sp[i].x > 0) { mid = len[i - 1] + (len[i] - len[i - 1]) * (-sp[i - 1].x / (sp[i].x - sp[i - 1].x)); break; }
  const half = Math.min(S.stock / 2, mid - 0.2, len[len.length - 1] - mid - 0.2);
  const foamPts = [], aluPts = [], nrms = [];
  const steps = Math.ceil(2 * half / 0.15);
  for (let i = 0; i <= steps; i++) {
    const { p, n } = at(mid - half + (2 * half) * i / steps);
    foamPts.push(p.clone().addScaledVector(n, S.skinGap + S.foam / 2));
    aluPts.push(p.clone().addScaledVector(n, S.skinGap + S.foam + S.alu / 2));
    nrms.push(n);
  }
  const group = new THREE.Group();
  const strip = new THREE.Group(); group.add(strip);
  mesh(sweepStrip(foamPts, nrms, width, S.foam, 0.16, { roundEnds: true }), MAT.foam, strip);
  mesh(sweepStrip(aluPts, nrms, width - 0.14, S.alu, 0.06, { roundEnds: true }), MAT.alu, strip);
  tag(strip, 'strip');

  // C7 box clamped on the middle of the strip. Local frame: z = out of the skin, y = up.
  const c = at(mid), tan = at(mid + 0.5).p.sub(at(mid - 0.5).p).normalize();
  const up = V().crossVectors(tan, c.n).normalize(), xAxis = V().crossVectors(up, c.n).normalize();
  const box = new THREE.Group();
  box.position.copy(c.p).addScaledVector(c.n, S.skinGap + S.foam + S.alu);
  box.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, up, c.n));
  box.userData.base = box.position.clone(); box.userData.out = c.n.clone();
  mesh(roundedBox(3.4, width + 1.0, 0.8, 0.22), MAT.rubber, box, V(0, 0, -0.22));       // saddle that grips the strip
  mesh(roundedBox(B.w, B.h, B.d, 0.5), MAT.pod, box, V(0, 0, 0.13 + B.d / 2));            // housing
  mesh(roundedBox(B.w - 1.3, B.h - 1.3, 0.12, 0.05), MAT.lid, box, V(0, 0, 0.13 + B.d + 0.01));
  mesh(roundedBox(0.95, 0.12, 0.34, 0.05), MAT.port, box, V(0.25, -B.h / 2 + 0.02, 0.75));   // USB-C, underside
  mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 16), MAT.led, box, V(B.w / 2 - 0.75, B.h / 2 - 0.42, 0.13 + B.d + 0.02), [Math.PI / 2, 0, 0]);
  // two strain reliefs on top: one cable arrives from each ear pod (local +x is the wearer's right)
  box.userData.glands = {};
  for (const [id, sx] of [['L', -1], ['R', 1]]) {
    const at = V(sx * (B.w / 2 - 0.55), B.h / 2 + 0.1, 0.13 + B.d - 0.6);   // cable notches in the top wall, near the lid
    mesh(new THREE.CapsuleGeometry(0.2, 0.5, 4, 14), MAT.rubber, box, at);
    box.userData.glands[id] = at.clone().add(V(0, 0.4, 0));
  }
  tag(box, 'box');
  group.add(box);

  const q = at(mid - half * 0.55);   // wearer's right shoulder: clear of the box label in the default view
  return {
    group, box, used: 2 * half, stock: S.stock, width,
    stripLabelAt: q.p.clone().addScaledVector(q.n, 1.6),
    boxLabelAt: V(0, B.h / 2 + 1.0, B.d),
  };
}

export function disposeGroup(g) { g.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); g.removeFromParent(); }
