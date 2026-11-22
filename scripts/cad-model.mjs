// Printable parts for the C7 box and the two ear pods, built from assets/structure-layout.js (mm).
// No DOM, no dependency. scripts/export-cad.mjs writes the result to cad/params.scad, and
// cad/part.scad turns it into solids with OpenSCAD. scripts/check-web.mjs checks the numbers.
//
// A part is { name, steps, flip, z: [zmin, zmax] } in the layout frame of its unit
// (x across, y up, z out of the skin, origin = centre of the inside floor).
// steps = [['add' | 'sub', [prim, ...]], ...] applied in order: ((s0 - s1) + s2) - s3 ...
// prims: ['box', x0,y0,z0, x1,y1,z1] · ['rbox', x0,y0,z0, x1,y1,z1, r] (rounded vertical edges)
//        ['cyl', x,y, z0,z1, r] · ['tri', [[x,y]x3], z0,z1]
// flip = print upside down (lid plate on the bed).

import { readFile } from 'node:fs/promises';

// loaded as a data: URL like scripts/check-web.mjs does (no package.json, so .js is not an ES module to Node)
const L = await import('data:text/javascript,' + encodeURIComponent(await readFile(new URL('../assets/structure-layout.js', import.meta.url), 'utf8')));
const { C7, UNITS, BOARD, boardXY } = L;

// Hole sizes before hole_add. pilot = self-tapping screw into plastic, clear = screw passes, insert = brass heat-set insert.
export const HOLES = {
  M2: { pilot: 1.6, clear: 2.4 },
  'M2.5': { pilot: 2.0, clear: 2.9, insert: 3.6, insertDepth: 4.5 },
  M3: { pilot: 2.5, clear: 3.4, insert: 4.0, insertDepth: 4.5 },
};
export const DEFAULTS = { fit: 0.25, holeAdd: 0.15, screwMode: 'pilot', podCable: 1.2 };

const B = (x0, y0, z0, x1, y1, z1) => ['box', Math.min(x0, x1), Math.min(y0, y1), z0, Math.max(x0, x1), Math.max(y0, y1), z1];
const BC = (cx, cy, w, h, z0, z1) => B(cx - w / 2, cy - h / 2, z0, cx + w / 2, cy + h / 2, z1);
const CYL = (x, y, z0, z1, r) => ['cyl', x, y, z0, z1, r];
const E = 0.01;
const hits = (a, b) => [0, 1, 2].every((i) => Math.min(a[i + 3], b[i + 3]) - Math.max(a[i], b[i]) > 1e-6);   // overlap so unions and cuts never meet on a shared face

// a hole going down from zTop: plain, or an insert pocket on top of a pilot for the screw tip
function screwHole(o, x, y, zTop, depth, size, kind) {
  const h = HOLES[size], add = o.holeAdd;
  if (kind === 'insert' && o.screwMode === 'insert' && h.insert) {
    return [CYL(x, y, zTop - h.insertDepth, zTop + E, (h.insert + add) / 2), CYL(x, y, zTop - depth, zTop, (h.clear + add) / 2)];
  }
  return [CYL(x, y, zTop - depth, zTop + E, ((kind === 'clear' ? h.clear : h.pilot) + add) / 2)];
}
// same, going up from zBot (the clamp screws enter the rails from below)
function screwHoleUp(o, x, y, zBot, depth, size, kind) {
  const h = HOLES[size], add = o.holeAdd;
  if (kind === 'insert' && o.screwMode === 'insert' && h.insert) {
    return [CYL(x, y, zBot - E, zBot + h.insertDepth, (h.insert + add) / 2), CYL(x, y, zBot, zBot + depth, (h.clear + add) / 2)];
  }
  return [CYL(x, y, zBot - E, zBot + depth, ((kind === 'clear' ? h.clear : h.pilot) + add) / 2)];
}

// ---------- C7 box ----------
function c7Parts(o) {
  const u = C7, W = u.in.w, H = u.in.h, D = u.in.d, t = u.wall, F = u.floor, f = o.fit;
  const by = Object.fromEntries(u.parts.map((p) => [p.id, p]));
  const zt = u.tray.z + u.tray.t;

  // base: shell, then the inside, then the features on the floor, then the holes
  const shell = [['rbox', -W / 2 - t, -H / 2 - t, -F, W / 2 + t, H / 2 + t, D, 3]];
  const cl = u.clamp;
  for (const s of [-1, 1]) shell.push(BC(0, s * (cl.railY + cl.railW / 2), cl.railL, cl.railW, -F - cl.railH, -F + E));
  const inside = [B(-W / 2, -H / 2, 0, W / 2, H / 2, D + 1)];
  for (const op of u.openings) {
    const z1 = op.z1 >= D ? D + 1 : op.z1, a = op.at - op.w / 2, b = op.at + op.w / 2;
    if (op.wall === 'left') inside.push(B(-W / 2 - t - 1, a, op.z0, -W / 2 + E, b, z1));
    if (op.wall === 'right') inside.push(B(W / 2 - E, a, op.z0, W / 2 + t + 1, b, z1));
    if (op.wall === 'top') inside.push(B(a, H / 2 - E, op.z0, b, H / 2 + t + 1, z1));
    if (op.wall === 'bottom') inside.push(B(a, -H / 2 - t - 1, op.z0, b, -H / 2 + E, z1));
  }
  const feat = [], floorParts = u.parts.filter((p) => p.level === 'floor');
  for (const p of u.posts) {
    feat.push(CYL(p.x, p.y, -E, u.tray.z, u.postR));
    // a post that just touches a wall meets it along a line only (not a valid solid): join it to the wall with a web
    const R = u.postR, wr = R * 0.8;
    if (Math.abs(p.x) + R > W / 2 - 0.5) feat.push(B(p.x, p.y - wr, -E, Math.sign(p.x) * (W / 2 + E), p.y + wr, u.tray.z));
    if (Math.abs(p.y) + R > H / 2 - 0.5) feat.push(B(p.x - wr, p.y, -E, p.x + wr, Math.sign(p.y) * (H / 2 + E), u.tray.z));
  }
  for (const [x0, y0, x1, y1] of u.batteryRibs) feat.push(B(x0, y0, -E, x1, y1, u.ribH));
  // TP4056 / MT3608 pockets: two 1 mm support ribs, corner stops and two snap hooks (as drawn in structure.js), pushed out by fit
  for (const id of ['tp', 'mt']) {
    const p = by[id], [x0, y0, , x1, y1] = p.box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, long = x1 - x0 > y1 - y0;
    for (const k of [-0.3, 0.3]) feat.push(long ? BC(cx + k * (x1 - x0), cy, 1.2, y1 - y0 - 2, -E, 1) : BC(cx, cy + k * (y1 - y0), x1 - x0 - 2, 1.2, -E, 1));
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
      if (Math.abs(y) >= H / 2 - 2) continue;
      const stop = BC(x + Math.sign(x - cx) * (0.8 + f), y + Math.sign(y - cy) * (0.8 + f), 1.6, 1.6, -E, 4);
      // a stop that lands on another floor part is left out (the TP4056 corner next to the 470 uF capacitor); the hooks still hold the board
      if (floorParts.some((q) => q.id !== id && hits(stop.slice(1), q.box))) { o.dropped?.push(`${id} corner stop at ${x.toFixed(1)}, ${y.toFixed(1)}`); continue; }
      feat.push(stop);
    }
    for (const sgn of [-1, 1]) {
      // a hook on a short side sits 5 mm off centre; if that lands on another floor part (the TP4056 left hook and
      // the capacitor), it moves to the other end of the same side
      const hx = long ? cx : (sgn < 0 ? x0 - 0.6 - f : x1 + 0.6 + f);
      const hook = (hy) => [BC(hx, hy, long ? 4 : 1.2, long ? 1.2 : 4, -E, 3.6), BC(hx - (long ? 0 : sgn * 0.5), hy - (long ? sgn * 0.5 : 0), long ? 4 : 2, long ? 2 : 4, 2.8, 3.6)];
      const free = (h) => !h.some((b) => floorParts.some((q) => q.id !== id && hits(b.slice(1), q.box)));
      const tries = long ? [sgn < 0 ? y0 - 0.6 - f : y1 + 0.6 + f] : [cy + 5, cy - 5];
      const hy = tries.find((y) => free(hook(y)));
      if (hy === undefined) { o.dropped?.push(`${id} hook on side ${sgn}`); continue; }
      if (hy !== tries[0]) o.dropped?.push(`${id} hook on side ${sgn} moved to ${hy.toFixed(1)}`);
      feat.push(...hook(hy));
    }
  }
  const sw = by.sw.box;
  // switch pocket: end stops and a back rib. The left stop has no room (1 mm between the switch and the TP4056), so it is left out.
  for (const [nm, b] of [['left', BC(sw[0] - 0.6 - f, -25.85, 1.2, 4.3, -E, 4)], ['right', BC(sw[3] + 0.6 + f, -25.85, 1.2, 4.3, -E, 4)], ['back', BC((sw[0] + sw[3]) / 2 + 2.3, sw[4] + 0.6 + f, 4, 1.2, -E, 3)]]) {
    if (floorParts.some((q) => q.id !== 'sw' && hits(b.slice(1), q.box))) { o.dropped?.push(`switch ${nm} stop`); continue; }
    feat.push(b);
  }
  const baseHoles = [];
  for (const p of u.posts) {
    // tray posts: M2.5x6 through the 2 mm tray, 4 mm into the post. lid posts: M2.5x20 from the lid top (D + lid) ends at D + lid - 20.
    if (p.screw === 'tray') baseHoles.push(...screwHole(o, p.x, p.y, u.tray.z, 8, 'M2.5', 'pilot'));
    else baseHoles.push(...screwHole(o, p.x, p.y, u.tray.z, u.tray.z - (D + u.lid - 20) + 1.5, 'M2.5', 'insert'));
  }
  // clamp screws M3x8: plate (2.5) + 5.5 into rail and floor; the tip stops 1.5 mm under the inside floor
  const railBottom = -F - cl.railH, railDepth = cl.screwLen - cl.plate[2] + 0.5;
  for (const [x, y] of cl.screws) baseHoles.push(...screwHoleUp(o, x, y, railBottom, railDepth, 'M3', 'insert'));
  const base = { name: 'c7_base', steps: [['add', shell], ['sub', inside], ['add', feat], ['sub', baseHoles]], flip: false, z: [railBottom, D],
    note: 'พื้นลงแท่น ต้องเปิด support จากแท่นใต้พื้นกล่อง (รางหลังกล่องยื่นจากพื้น 5 มม.)' };

  // tray: plate with slots and post holes, bosses for ESP32 and GY-521, ledges and hooks for the two Qwiic adapters
  const tray = [['rbox', -u.tray.w / 2, -u.tray.h / 2, u.tray.z, u.tray.w / 2, u.tray.h / 2, zt, 2]];
  const traySub = u.tray.slots.map(([x0, y0, x1, y1]) => B(x0, y0, u.tray.z - 1, x1, y1, zt + 1));
  for (const p of u.posts) traySub.push(CYL(p.x, p.y, u.tray.z - 1, zt + 1, (HOLES['M2.5'].clear + o.holeAdd) / 2));
  const trayAdd = [], trayHoles = [], lidRibs = [];
  for (const id of ['esp', 'mpu']) for (const [hx, hy] of BOARD[by[id].kind].holes) {
    const [x, y] = boardXY(by[id], hx, hy);
    trayAdd.push(CYL(x, y, zt - E, u.zBoard, 2.2));
    trayHoles.push(CYL(x, y, u.tray.z - 1, u.zBoard + E, (HOLES['M2.5'].pilot + o.holeAdd) / 2));
  }
  for (const id of ['hubA', 'hubB']) {
    const p = by[id], cx = p.at[0], y0 = p.box[1], y1 = p.box[4], zb = u.zBoard;
    trayAdd.push(BC(cx, y1 - 1, 18, 1.4, zt - E, zb));
    for (const [y, s] of [[y0 - 0.6 - f, 1], [y1 + 0.6 + f, -1]]) {
      if (Math.abs(y) + 0.6 > u.tray.h / 2) {
        // no room for a hook between the board and the wall (Adapter 2 is 1.15 mm from the top wall):
        // a rib under the lid presses that edge down instead
        const yb = s > 0 ? y0 : y1, top = zb + BOARD[p.kind].t;
        lidRibs.push(BC(cx, yb + s * 0.6, 10, 1.2, top + 0.2, D + E));
        continue;
      }
      trayAdd.push(BC(cx + 7 * s, y, 4, 1.2, zt - E, zb + 2.6));
      trayAdd.push(BC(cx + 7 * s, y + s * 0.5, 4, 2, zb + 1.8, zb + 2.6));
    }
  }
  const trayPart = { name: 'c7_tray', steps: [['add', tray], ['sub', traySub], ['add', trayAdd], ['sub', trayHoles]], flip: false, z: [u.tray.z, u.zBoard + 2.6], note: 'วางราบ ไม่ต้องใช้ support' };

  // lid: plate, lip inside the walls, two sleeves that press the tray onto the lid posts
  const lidAdd = [['rbox', -W / 2 - t, -H / 2 - t, D, W / 2 + t, H / 2 + t, D + u.lid, 3]];
  for (const s of [-1, 1]) lidAdd.push(BC(0, s * (H / 2 - 0.6 - f), W - 12, 1, D - 1.4, D + E), BC(s * (W / 2 - 0.6 - f), 8, 1, H - 30, D - 1.4, D + E));
  lidAdd.push(...lidRibs);
  const lidSub = [];
  for (const p of u.posts) if (p.screw === 'lid') { lidAdd.push(CYL(p.x, p.y, zt, D + E, 3)); lidSub.push(CYL(p.x, p.y, zt - 1, D + u.lid + 1, (HOLES['M2.5'].clear + o.holeAdd) / 2)); }
  const lid = { name: 'c7_lid', steps: [['add', lidAdd], ['sub', lidSub]], flip: true, z: [zt, D + u.lid], note: 'คว่ำฝาลงแท่น ปลอกและขอบชี้ขึ้น ไม่ต้องใช้ support' };

  // clamp plate under the rails (the soft pad is foam, not printed)
  const zp = -F - cl.railH;
  const clampAdd = [['rbox', -cl.plate[0] / 2, -cl.plate[1] / 2, zp - cl.plate[2], cl.plate[0] / 2, cl.plate[1] / 2, zp, 3]];
  const clampSub = cl.screws.map(([x, y]) => CYL(x, y, zp - cl.plate[2] - 1, zp + 1, (HOLES.M3.clear + o.holeAdd) / 2));
  const clamp = { name: 'c7_clamp', steps: [['add', clampAdd], ['sub', clampSub]], flip: false, z: [zp - cl.plate[2], zp], note: 'วางราบ' };
  return [base, trayPart, lid, clamp];
}

// ---------- ear pods ----------
function podParts(u, o) {
  const s = u.s, id = u.id.slice(3), W = u.in.w, H = u.in.h, D = u.in.d, t = u.wall, F = u.floor, f = o.fit;
  const r = Math.min(3, t * 1.5), bno = u.parts[0];
  const holes = BOARD.bno085.holes.map(([x, y]) => boardXY(bno, x, y));
  const hookX = [-10, 10], hookZ = [D - 2.4, D];

  const shell = [['rbox', -W / 2 - t, -H / 2 - t, -F, W / 2 + t, H / 2 + t, D, r]];
  const inside = [B(-W / 2, -H / 2, 0, W / 2, H / 2, D + 1), B(u.exit.x - u.exit.w / 2, -H / 2 - t - 1, 0.3, u.exit.x + u.exit.w / 2, -H / 2 + E, D + 1)];
  // grooves in the long walls that take the bumps on the lid hooks
  for (const x of hookX) for (const sy of [-1, 1]) inside.push(BC(x, sy * (H / 2 + 0.3), 4.8, 0.6 + 2 * E, hookZ[0] - 0.1, hookZ[0] + 0.7));
  const feat = [], sub = [];
  holes.forEach(([x, y], i) => {
    feat.push(CYL(x, y, -E, bno.at[2], 2.2));
    if (i === 1 || i === 2) feat.push(CYL(x, y, -E, bno.at[2] + 2.6, 1.1));   // locating pins
    else sub.push(CYL(x, y, bno.at[2] - 2.4, bno.at[2] + E, (HOLES['M2.5'].pilot + o.holeAdd) / 2));   // M2.5x4: tip 0.3 mm above the outside of the floor
  });
  // cable clamp: one M2x5 into a boss beside the board; the clamp top sits where structure.js draws the screw head (z 4.2)
  const sx = u.clampAt[0] - s * 4.2, sy = u.clampAt[1], clampBot = 2.8, clampTop = 4.2;
  feat.push(CYL(sx, sy, -E, clampBot, 1.6));
  sub.push(CYL(sx, sy, clampTop - 5, clampBot + E, (HOLES.M2.pilot + o.holeAdd) / 2));
  const base = { name: 'pod_base_' + id, steps: [['add', shell], ['sub', inside], ['add', feat], ['sub', sub]], flip: false, z: [-F, D], note: 'พื้นลงแท่น ไม่ต้องใช้ support' };

  // lid: plate, four snap hooks with a 0.4 mm bump, arrow to the wearer's front engraved on the outside
  const lidAdd = [['rbox', -u.out.w / 2, -u.out.h / 2, D, u.out.w / 2, u.out.h / 2, D + u.lid, 2.2]];
  for (const x of hookX) for (const sy of [-1, 1]) {
    const yo = sy * (H / 2 - f);   // outer face of the hook
    lidAdd.push(B(x - 2, yo, hookZ[0], x + 2, yo - sy * 1, hookZ[1] + E));
    lidAdd.push(B(x - 2, yo - sy * 0.2, hookZ[0], x + 2, sy * (H / 2 + 0.4), hookZ[0] + 0.6));
  }
  const lidSub = [['tri', [[-s * 7, 0], [s * 2, 4.5], [s * 2, -4.5]], D + u.lid - 0.4, D + u.lid + 1]];
  const lid = { name: 'pod_lid_' + id, steps: [['add', lidAdd], ['sub', lidSub]], flip: true, z: [hookZ[0], D + u.lid], note: 'คว่ำฝาลงแท่น ตะขอชี้ขึ้น' };

  // cable clamp: 8 x 3.6 x 1.4 plate with a tongue that presses the cable down to podCable above the floor
  const cx = u.clampAt[0] - s * 1.6;
  const cAdd = [BC(cx, sy, 8, 3.6, clampBot, clampTop), BC(u.clampAt[0], sy, 3.6, 3.6, o.podCable, clampBot + E)];
  const cSub = [CYL(sx, sy, clampBot - 1, clampTop + 1, (HOLES.M2.clear + o.holeAdd) / 2)];
  const clamp = { name: 'pod_clamp_' + id, steps: [['add', cAdd], ['sub', cSub]], flip: true, z: [o.podCable, clampTop], note: 'คว่ำลงแท่น ลิ้นกดสายชี้ขึ้น' };
  return [base, lid, clamp];
}

export function cadParts(opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  return [...c7Parts(o), ...podParts(UNITS.podL, o), ...podParts(UNITS.podR, o)];
}

// bounding box of the solids that are added (cuts can only shrink it)
export function bbox(part) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const [op, prims] of part.steps) if (op === 'add') for (const p of prims) {
    let b;
    if (p[0] === 'box' || p[0] === 'rbox') b = p.slice(1, 7);
    else if (p[0] === 'cyl') b = [p[1] - p[5], p[2] - p[5], p[3], p[1] + p[5], p[2] + p[5], p[4]];
    else { const xs = p[1].map((q) => q[0]), ys = p[1].map((q) => q[1]); b = [Math.min(...xs), Math.min(...ys), p[2], Math.max(...xs), Math.max(...ys), p[3]]; }
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b[i]); hi[i] = Math.max(hi[i], b[i + 3]); }
  }
  return { lo, hi, size: hi.map((h, i) => +(h - lo[i]).toFixed(2)) };
}

const num = (v) => (Math.abs(v) < 1e-9 ? 0 : +v.toFixed(4));
const scad = (v) => (Array.isArray(v) ? '[' + v.map(scad).join(', ') + ']' : typeof v === 'string' ? JSON.stringify(v) : typeof v === 'boolean' ? String(v) : String(num(v)));

// the text of cad/params.scad
export function paramsScad(opt = {}) {
  const o = { ...DEFAULTS, ...opt }, parts = cadParts(o);
  const lines = [
    '// GENERATED by scripts/export-cad.mjs from assets/structure-layout.js. Do not edit by hand:',
    '// change the layout (or the options of export-cad.mjs) and run scripts/build-cad.ps1 again.',
    `// fit = ${o.fit} mm, hole_add = ${o.holeAdd} mm, screw_mode = ${o.screwMode}, pod_cable = ${o.podCable} mm`,
    `CAD_FIT = ${num(o.fit)};`, `CAD_HOLE_ADD = ${num(o.holeAdd)};`, `CAD_SCREW_MODE = ${JSON.stringify(o.screwMode)};`,
    `PART_NAMES = ${scad(parts.map((p) => p.name))};`,
    'PARTS = [',
    parts.map((p) => `  [${JSON.stringify(p.name)}, ${p.flip}, ${scad(p.z)},\n   ${scad(p.steps)}]`).join(',\n'),
    '];', '',
  ];
  return lines.join('\n');
}
