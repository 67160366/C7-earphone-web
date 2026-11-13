// Real-size models of the actual boards for the wiring bench in wiring.html.
// Each board = PCB with a silkscreen texture (pin names where the real board prints them)
// + 3D parts + header pins. Units are centimetres; a board lies in XY and faces +Z.
import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const PX = 230;          // silkscreen texture resolution, px per cm
const T = 0.16;          // PCB thickness
const PITCH = 0.254;     // 0.1 inch header pitch
const MONO = '"IBM Plex Mono", Consolas, monospace';
const std = (o) => new THREE.MeshStandardMaterial(o);
const M = {
  gold: std({ color: 0xd4a94a, roughness: 0.3, metalness: 1 }),
  solder: std({ color: 0xc9ced2, roughness: 0.25, metalness: 1 }),
  can: std({ color: 0xcfd3d6, roughness: 0.3, metalness: 1 }),
  chip: std({ color: 0x101113, roughness: 0.35 }),
  plastic: std({ color: 0x141517, roughness: 0.6 }),
  jst: std({ color: 0xe9e3d0, roughness: 0.55 }),
  tant: std({ color: 0xd9a514, roughness: 0.5 }),
  pass: std({ color: 0xb59a78, roughness: 0.6 }),
  trim: std({ color: 0x1d4fb5, roughness: 0.4 }),
  brass: std({ color: 0xc8a24a, roughness: 0.3, metalness: 1 }),
  ferrite: std({ color: 0x3a3d42, roughness: 0.7 }),
  ledR: std({ color: 0xff6b5a, emissive: 0xc02a1a, emissiveIntensity: 0.8 }),
  ledB: std({ color: 0x7fb6ff, emissive: 0x1f5fd0, emissiveIntensity: 0.8 }),
  kapton: std({ color: 0xc98a1a, roughness: 0.4 }),
};
const G = {
  dome: new THREE.SphereGeometry(0.075, 12, 8),
  pin: new THREE.BoxGeometry(0.064, 0.064, 0.86),
  strip: new THREE.BoxGeometry(PITCH, PITCH, 0.25),
};

function roundRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0);
  s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
  return s;
}

// Canvas helpers that take board coordinates (cm, origin at the board centre, y up).
function painter(w, h, base) {
  const c = document.createElement('canvas'); c.width = Math.round(w * PX); c.height = Math.round(h * PX);
  const g = c.getContext('2d'), X = (x) => (x + w / 2) * PX, Y = (y) => (h / 2 - y) * PX;
  g.fillStyle = base; g.fillRect(0, 0, c.width, c.height);
  return {
    canvas: c,
    text(s, x, y, size, { rot = 0, align = 'center', color = '#f1f3f4', weight = 700 } = {}) {
      g.save(); g.translate(X(x), Y(y)); g.rotate(-rot * Math.PI / 180);
      g.font = `${weight} ${Math.round(size * PX)}px ${MONO}`; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle';
      g.fillText(s, 0, 0); g.restore();
    },
    pad(x, y, r = 0.085, hole = 0.045) {
      g.fillStyle = '#d6ad52'; g.beginPath(); g.arc(X(x), Y(y), r * PX, 0, 7); g.fill();
      g.fillStyle = '#0b0c0d'; g.beginPath(); g.arc(X(x), Y(y), hole * PX, 0, 7); g.fill();
    },
    rect(x, y, rw, rh, color, stroke) {
      if (stroke) { g.strokeStyle = color; g.lineWidth = stroke * PX; g.strokeRect(X(x - rw / 2), Y(y + rh / 2), rw * PX, rh * PX); }
      else { g.fillStyle = color; g.fillRect(X(x - rw / 2), Y(y + rh / 2), rw * PX, rh * PX); }
    },
    line(pts, color = '#f1f3f4', lw = 0.02) {
      g.strokeStyle = color; g.lineWidth = lw * PX; g.lineCap = 'round'; g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.stroke();
    },
    ring(x, y, r, color = '#f1f3f4', lw = 0.02) { g.strokeStyle = color; g.lineWidth = lw * PX; g.beginPath(); g.arc(X(x), Y(y), r * PX, 0, 7); g.stroke(); },
  };
}
function texture(canvas) {
  const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

// One board. def: { w, h, r, base, thick, bare, draw(p), parts(add), pins: [{ k, x, y, hdr }] }
// bare = no pin headers soldered on (boards shown inside the pods and the C7 box).
function board(def) {
  const g = new THREE.Group(), th = def.thick ?? T, top = th / 2;
  const shape = roundRect(def.w, def.h, def.r ?? 0.12);
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false, curveSegments: 6 }), std({ color: def.base, roughness: 0.55, metalness: def.metal ?? 0 }));
  body.position.z = -th / 2; body.castShadow = true; body.receiveShadow = true; g.add(body);
  const p = painter(def.w, def.h, def.base);
  for (const pin of def.pins) if (pin.hdr !== false) p.pad(pin.x, pin.y);
  def.draw?.(p);
  const face = new THREE.ShapeGeometry(shape, 6), uv = face.attributes.uv, pos = face.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + def.w / 2) / def.w, (pos.getY(i) + def.h / 2) / def.h);
  const faceM = new THREE.Mesh(face, std({ map: texture(p.canvas), roughness: 0.5, metalness: def.metal ? 0.4 : 0 }));
  faceM.position.z = top + 0.002; faceM.receiveShadow = true; g.add(faceM);
  // add(geometryOrSize, material, x, y, lift, rot): part sitting on the top face
  const add = (geo, mat, x, y, lift = 0, rot) => {
    let h = 0;
    if (Array.isArray(geo)) { h = geo[2]; geo = new THREE.BoxGeometry(...geo); }
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, top + lift + h / 2);
    if (rot) m.rotation.set(...rot);
    m.castShadow = true; g.add(m); return m;
  };
  def.parts?.(add, top);
  const pins = {};
  for (const pin of def.pins) {
    if (pin.hdr !== false && !def.bare) {
      // soldered header: solder dome on top, plastic strip and gold pin below
      const d = new THREE.Mesh(G.dome, M.solder); d.position.set(pin.x, pin.y, top); d.scale.z = 0.8; g.add(d);
      const s = new THREE.Mesh(G.strip, M.plastic); s.position.set(pin.x, pin.y, -th / 2 - 0.125); g.add(s);
      const q = new THREE.Mesh(G.pin, M.gold); q.position.set(pin.x, pin.y, -th / 2 - 0.4); g.add(q);
    }
    pins[pin.k] = V(pin.x, pin.y, top + (pin.z ?? 0.07));
  }
  return { group: g, pins, w: def.w, h: def.h, labels: def.pins.filter((q) => q.n !== null).map((q) => ({ k: q.k, n: q.n ?? q.k, x: q.x, y: q.y, lx: q.lx ?? 0, ly: q.ly ?? 0 })) };
}
const cyl = (r, h, seg = 20) => new THREE.CylinderGeometry(r, r, h, seg).rotateX(Math.PI / 2);

// ---------- Adafruit BNO085 breakout (#4754), 25.6 x 22.7 mm, two STEMMA QT sockets ----------
export function bno085(o = {}) {
  const top = ['BT', 'P0', 'P1', 'RST', 'DI', 'CS'], bot = ['VIN', '3Vo', 'GND', 'SCL', 'SDA', 'INT'];
  const x = (i) => -0.635 + i * PITCH;
  const qt = (side, sx) => ['GND', '3V3', 'SDA', 'SCL'].map((n, i) => ({ k: side + '.' + n, n, x: sx * 1.33, y: 0.15 - i * 0.1, z: 0.16, hdr: false, lx: sx * 0.5, ly: (1.5 - i) * 0.17 }));
  return board({
    bare: o.bare,
    w: 2.56, h: 2.27, r: 0.22, base: '#15171a',
    pins: [
      ...top.map((n, i) => ({ k: n, x: x(i), y: 0.89, ly: 0.4 + (i % 2) * 0.24 })),
      ...bot.map((n, i) => ({ k: n, x: x(i), y: -0.89, ly: -0.4 - (i % 2) * 0.24 })),
      ...qt('QT', -1), ...qt('QT2', 1),
    ],
    draw(p) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) p.pad(sx * 1.03, sy * 0.86, 0.19, 0.12);
      top.forEach((n, i) => p.text(n, x(i), 0.69, 0.095));
      p.text('BNO08x 9-DoF', 0, 0.5, 0.125, { color: '#c9cdd1' });
      bot.forEach((n, i) => (n === '3Vo' || n === 'SCL' ? p.text(n, x(i), -0.69, 0.095) : p.text(n, x(i) + (n === 'INT' ? 0.04 : 0), -1.055, 0.085)));
      // axis mark printed on the board
      p.ring(0.5, -0.42, 0.07); p.text('Z', 0.5, -0.42, 0.07);
      p.line([[0.5, -0.34], [0.5, -0.17]]); p.line([[0.46, -0.21], [0.5, -0.17], [0.54, -0.21]]); p.text('Y', 0.5, -0.1, 0.09);
      p.line([[0.58, -0.42], [0.75, -0.42]]); p.line([[0.71, -0.38], [0.75, -0.42], [0.71, -0.46]]); p.text('X', 0.84, -0.42, 0.09);
    },
    parts(add) {
      add([0.5, 0.4, 0.1], M.chip, 0, 0.05); add([0.5, 0.46, 0.12], M.chip, -0.02, -0.42);
      add([0.32, 0.13, 0.1], M.can, -0.2, 0.34);
      for (const sx of [-1, 1]) add([0.45, 0.6, 0.29], M.jst, sx * 1.0, 0);
      for (const [px, py] of [[-0.55, 0.3], [0.45, 0.3], [-0.6, -0.1], [-0.6, -0.5], [0.75, 0.32]]) add([0.16, 0.09, 0.06], M.pass, px, py);
    },
  });
}

// ---------- ESP32 DevKit V1 (DOIT, 30 pins, ESP32-WROOM-32, micro-USB), about 51.5 x 28.2 mm ----------
export function esp32(o = {}) {
  const L = ['EN', 'VP', 'VN', 'D34', 'D35', 'D32', 'D33', 'D25', 'D26', 'D27', 'D14', 'D12', 'D13', 'GND', 'VIN'];
  const R = ['D23', 'D22', 'TX0', 'RX0', 'D21', 'D19', 'D18', 'D5', 'TX2', 'RX2', 'D4', 'D2', 'D15', 'GND', '3V3'];
  const y = (i) => 1.62 - i * PITCH;
  const canTop = painter(1.58, 1.75, '#c3c8cb');
  canTop.text('ESP32-WROOM-32', 0, 0.55, 0.13, { color: '#4f565b', weight: 700 });
  canTop.text('CE  FCC', -0.2, 0.25, 0.1, { color: '#5f666b', weight: 600 });
  canTop.rect(0.45, -0.4, 0.4, 0.4, '#8a9196', 0.02); canTop.rect(0.45, -0.4, 0.2, 0.2, '#8a9196');
  return board({
    bare: o.bare,
    w: 2.82, h: 5.15, r: 0.1, base: '#0f1113',
    pins: [
      ...L.map((n, i) => ({ k: n === 'GND' ? 'GNDL' : n, n, x: -1.27, y: y(i), lx: -0.42 })),
      ...R.map((n, i) => ({ k: n === 'GND' ? 'GNDR' : n, n, x: 1.27, y: y(i), lx: 0.42 })),
    ],
    draw(p) {
      L.forEach((n, i) => p.text(n, -1.06, y(i), 0.1, { rot: 90 }));
      R.forEach((n, i) => p.text(n, 1.06, y(i), 0.1, { rot: 90 }));
      for (const sx of [-1, 1]) { p.pad(sx * 1.2, 2.36, 0.17, 0.12); p.pad(sx * 1.2, -2.36, 0.17, 0.12); }
      p.text('EN', -0.62, -2.25, 0.11, { rot: 90 }); p.text('BOOT', 0.62, -2.25, 0.11, { rot: 90 });
      p.text('U2', 0.42, -1.02, 0.08);
      for (let i = 0; i < 8; i++) p.rect(-0.62 + i * 0.18, -0.45, 0.13, 0.3, '#e8eaeb', 0.012);
    },
    parts(add) {
      add([1.8, 2.55, 0.08], M.chip, 0, 1.27);                                        // module PCB with the antenna end at the top
      add([1.58, 1.75, 0.24], M.can, 0, 0.9, 0.08);                                   // RF shield
      add(new THREE.PlaneGeometry(1.58, 1.75), std({ map: texture(canTop.canvas), roughness: 0.45, metalness: 0.25 }), 0, 0.9, 0.322);
      for (let i = 0; i < 8; i++) add([0.1, 0.2, 0.06], i % 3 ? M.chip : M.pass, -0.62 + i * 0.18, -0.45);
      add([0.36, 0.66, 0.16], M.chip, -0.5, -1.4); add([0.2, 0.36, 0.14], M.can, -0.82, -1.4);   // AMS1117 + tab
      add([0.5, 0.5, 0.09], M.chip, 0.52, -1.42);                                     // CP2102
      add([0.76, 0.56, 0.27], M.can, 0, -2.36);                                       // micro-USB
      for (const sx of [-1, 1]) { add([0.3, 0.42, 0.14], M.can, sx * 0.95, -2.3); add(cyl(0.085, 0.08), M.chip, sx * 0.95, -2.3, 0.18); }
      add([0.1, 0.16, 0.06], M.ledR, -0.44, -0.45, 0.02); add([0.1, 0.16, 0.06], M.ledB, 0.64, -0.45, 0.02);
    },
  });
}

// ---------- GY-521 (MPU6050), 21 x 16 mm, one row of 8 pins ----------
export function gy521(o = {}) {
  const names = ['VCC', 'GND', 'SCL', 'SDA', 'XDA', 'XCL', 'AD0', 'INT'], x = (i) => -0.889 + i * PITCH;
  return board({
    bare: o.bare,
    w: 2.1, h: 1.6, r: 0.08, base: '#1b55a6',
    pins: names.map((n, i) => ({ k: n, x: x(i), y: 0.6, ly: 0.4 + (i % 2) * 0.24 })),
    draw(p) {
      names.forEach((n, i) => p.text(n, x(i), 0.3, 0.085, { rot: 90 }));
      for (const sx of [-1, 1]) p.pad(sx * 0.78, -0.52, 0.2, 0.15);
      p.text('GY-521', 0, -0.66, 0.1); p.text('MPU-6050', 0.05, -0.42, 0.075, { color: '#cfe0f5' });
    },
    parts(add) {
      add([0.4, 0.4, 0.09], M.chip, 0, -0.1);
      add([0.3, 0.16, 0.16], M.tant, 0.62, -0.08); add([0.28, 0.14, 0.1], M.chip, -0.6, -0.08);
      for (const [px, py] of [[-0.3, -0.28], [0.3, -0.28], [0.3, 0.06], [-0.32, 0.06]]) add([0.1, 0.06, 0.05], M.pass, px, py);
    },
  });
}

// ---------- TP4056 USB-C charger with protection (DW01 + 8205), about 28 x 17 mm ----------
export function tp4056(o = {}) {
  const pads = [['OUT+', 0.62], ['B+', 0.22], ['B-', -0.22], ['OUT-', -0.62]];
  return board({
    bare: o.bare,
    w: 2.8, h: 1.7, r: 0.06, base: '#1b55a6',
    pins: pads.map(([n, py]) => ({ k: n, x: 1.2, y: py, hdr: false, z: 0.01, lx: 0.5 })),
    draw(p) {
      for (const [n, py] of pads) { p.pad(1.2, py, 0.11, 0.05); p.text(n, 1.02, py, 0.1, { align: 'right' }); }
      p.text('TP4056', -0.1, -0.66, 0.1); p.text('IN+', -0.62, 0.68, 0.08); p.text('IN-', -0.62, -0.68, 0.08);
    },
    parts(add) {
      add([0.74, 0.9, 0.32], M.can, -1.08, 0);
      add([0.5, 0.4, 0.14], M.chip, 0.0, 0.2); add([0.3, 0.16, 0.1], M.chip, 0.35, -0.3); add([0.3, 0.44, 0.1], M.chip, -0.2, -0.3);
      add([0.1, 0.16, 0.06], M.ledR, -0.5, 0.42); add([0.1, 0.16, 0.06], M.ledB, -0.5, -0.1);
    },
  });
}

// ---------- MT3608 step-up module (set to 5.0 V with the trimmer), about 36 x 17 mm ----------
export function mt3608(o = {}) {
  const pads = [['VIN+', -1.6, 0.6], ['VIN-', -1.6, -0.6], ['VOUT+', 1.6, 0.6], ['VOUT-', 1.6, -0.6]];
  return board({
    bare: o.bare,
    w: 3.6, h: 1.7, r: 0.06, base: '#1b55a6',
    pins: pads.map(([n, px, py]) => ({ k: n, x: px, y: py, hdr: false, z: 0.01, lx: Math.sign(px) * 0.52 })),
    draw(p) {
      for (const [n, px, py] of pads) { p.pad(px, py, 0.11, 0.05); p.text(n, px - Math.sign(px) * 0.18, py, 0.095, { align: px < 0 ? 'left' : 'right' }); }
      p.text('MT3608', -0.5, -0.66, 0.1);
    },
    parts(add) {
      add([0.95, 0.48, 0.5], M.trim, 0.45, 0.45); add(cyl(0.11, 0.1), M.brass, 0.05, 0.45, 0.52, [0, Math.PI / 2, 0]);
      add([0.62, 0.62, 0.3], M.ferrite, -0.55, 0.05);
      add([0.3, 0.16, 0.1], M.chip, 0.25, -0.3); add([0.42, 0.26, 0.2], M.chip, 0.95, -0.35);
    },
  });
}

// ---------- LiPo 503035, 3.7 V 500 mAh, 35 x 30 x 5 mm, with its protection board under the tape ----------
export function lipo(o = {}) {
  return board({
    bare: o.bare,
    w: 3.0, h: 3.5, r: 0.14, base: '#b4b9bd', thick: 0.5, metal: 0.8,
    pins: [{ k: '+', x: 0.3, y: 1.58, hdr: false, z: 0.01, ly: 0.36, lx: 0.25 }, { k: '-', x: -0.3, y: 1.58, hdr: false, z: 0.01, ly: 0.36, lx: -0.25 }],
    draw(p) {
      p.rect(0, 1.45, 3.0, 0.6, '#c98a1a');
      p.rect(0.3, 1.58, 0.14, 0.14, '#d0312d'); p.rect(-0.3, 1.58, 0.14, 0.14, '#18181a');
      p.text('+', 0.62, 1.5, 0.2, { color: '#1a1a1a' }); p.text('-', -0.62, 1.5, 0.2, { color: '#1a1a1a' });
      p.text('LiPo 503035', 0, 0.3, 0.2, { color: '#2a2e31' });
      p.text('3.7V 500mAh', 0, -0.1, 0.17, { color: '#2a2e31', weight: 500 });
      p.text('1.85Wh', 0, -0.45, 0.13, { color: '#4a4f53', weight: 500 });
    },
  });
}

// ---------- SS12D00 slide switch: battery on/off ----------
export function slideSwitch(o = {}) {
  return board({
    bare: o.bare,
    w: 1.3, h: 0.9, r: 0.05, base: '#2a2d31',
    pins: [{ k: 'A', x: -0.3, y: -0.3, hdr: false, z: 0.01, ly: -0.36, lx: -0.2 }, { k: 'B', x: 0, y: -0.3, hdr: false, z: 0.01, ly: -0.36, lx: 0.2 }],
    draw(p) {
      for (const px of [-0.3, 0, 0.3]) p.pad(px, -0.3, 0.07, 0.03);
      p.text('ON', -0.3, 0.33, 0.1); p.text('OFF', 0.3, 0.33, 0.1);
    },
    parts(add) { add([0.86, 0.36, 0.36], M.can, 0, 0.02); add([0.2, 0.2, 0.2], M.chip, -0.18, 0.02, 0.36); },
  });
}

// ---------- SparkFun Qwiic Adapter: two Qwiic sockets + 4 plated holes, all on one I2C bus ----------
// The shop page gives no dimensions, so 25.4 x 12.7 mm is an estimate. A 1x4 pin header is soldered into the holes.
export function qwiicAdapter(o = {}) {
  const names = ['GND', '3V3', 'SDA', 'SCL'], x = (i) => -0.381 + i * PITCH;
  const qt = (side, sx) => names.map((n, i) => ({ k: side + '.' + n, n, x: sx * 1.3, y: 0.33 - i * 0.1, z: 0.16, hdr: false, lx: sx * 0.5, ly: (1.5 - i) * 0.17 }));
  return board({
    bare: o.bare,
    w: 2.54, h: 1.27, r: 0.08, base: '#b3202a',
    pins: [...names.map((n, i) => ({ k: n, x: x(i), y: -0.4, ly: -0.4 - (i % 2) * 0.24 })), ...qt('QA', -1), ...qt('QB', 1)],
    draw(p) {
      names.forEach((n, i) => p.text(n, x(i), -0.1, 0.075, { rot: 90 }));
      p.text('Qwiic', 0, 0.42, 0.1);
    },
    parts(add) { for (const sx of [-1, 1]) add([0.45, 0.6, 0.29], M.jst, sx * 0.97, 0.18); },
  });
}
