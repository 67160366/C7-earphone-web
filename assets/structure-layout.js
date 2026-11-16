// Enclosure layout for structure.html: where every part sits inside the C7 box and the ear pods,
// what holds it, and which wire goes where. Units are millimetres.
// No DOM and no Three.js here, so scripts/check-web.mjs can load this file and check fit and clearances.
// Box frame: x across (+x = wearer's right), y up, z out of the skin. Origin = centre of the inside floor.

const rot = (k, x, y) => { k = ((k % 4) + 4) % 4; return k === 1 ? [-y, x] : k === 2 ? [-x, -y] : k === 3 ? [y, -x] : [x, y]; };

// A female jumper plugged on a header pin under a board: plastic strip, housing, then room for the wire to turn.
export const JUMPER = { strip: 2.5, housing: 14, bend: 3, w: 2.54 };

// Real board sizes (same as wiring-boards.js) and the pins that take a wire. hdr = header pin pointing down.
const espNames = { L: ['EN', 'VP', 'VN', 'D34', 'D35', 'D32', 'D33', 'D25', 'D26', 'D27', 'D14', 'D12', 'D13', 'GNDL', 'VIN'], R: ['D23', 'D22', 'TX0', 'RX0', 'D21', 'D19', 'D18', 'D5', 'TX2', 'RX2', 'D4', 'D2', 'D15', 'GNDR', '3V3'] };
const espPins = {};
for (const [side, sx] of [['L', -1], ['R', 1]]) espNames[side].forEach((n, i) => { espPins[n] = [sx * 12.7, 16.2 - 2.54 * i, 'hdr']; });
const row4 = (names, x0, y) => Object.fromEntries(names.map((n, i) => [n, [x0 + 2.54 * i, y, 'hdr']]));
export const BOARD = {
  esp32: { w: 28.2, h: 51.8, t: 1.6, top: 3.2, pins: espPins, rows: [[-12.7, -19.36, -12.7, 16.2], [12.7, -19.36, 12.7, 16.2]], holes: [[11.9, 23.7], [-11.9, 23.7], [11.9, -23.7], [-11.9, -23.7]] },   // 2.8 mm holes, 0.8 mm from the edges (measured board, Fritzing forum)
  qwiic: { w: 25.4, h: 12.7, t: 1.6, top: 2.9, pins: { ...row4(['GND', '3V3', 'SDA', 'SCL'], -3.81, -4), QA: [-12.7, 1.8, 'qw'], QB: [12.7, 1.8, 'qw'] }, rows: [[-3.81, -4, 3.81, -4]] },
  gy521: { w: 21, h: 16, t: 1.6, top: 1.6, pins: row4(['VCC', 'GND', 'SCL', 'SDA'], -8.89, 6), rows: [[-8.89, 6, 8.89, 6]], holes: [[-7.8, -5.2], [7.8, -5.2]] },
  tp4056: { w: 28, h: 17, t: 1.6, top: 1.4, bump: [-14.5, -4.5, -7.1, 4.5, 3.2], pins: { 'OUT+': [12, 6.2, 'pad'], 'B+': [12, 2.2, 'pad'], 'B-': [12, -2.2, 'pad'], 'OUT-': [12, -6.2, 'pad'] } },
  mt3608: { w: 36, h: 17, t: 1.6, top: 5, pins: { 'VIN+': [-16, 6, 'pad'], 'VIN-': [-16, -6, 'pad'], 'VOUT+': [16, 6, 'pad'], 'VOUT-': [16, -6, 'pad'] } },
  lipo: { w: 30, h: 40, t: 8, top: 0, pins: { '+': [3, 18.3, 'pad'], '-': [-3, 18.3, 'pad'] } },   // 803040, 1100 mAh
  bno085: { w: 25.6, h: 22.7, t: 1.6, top: 2.9, pins: { QT: [-12.8, 0, 'qw'], QT2: [12.8, 0, 'qw'], '3Vo': [-3.81, -8.9, 'pad'], DI: [3.81, 8.9, 'pad'] }, holes: [[10.3, 8.6], [-10.3, 8.6], [10.3, -8.6], [-10.3, -8.6]] },
};

function place(id, kind, cx, cy, zb, turn, info) {
  const b = BOARD[kind], odd = ((turn % 2) + 2) % 2, w = odd ? b.h : b.w, h = odd ? b.w : b.h;
  const part = { id, kind, at: [cx, cy, zb], turn, box: [cx - w / 2, cy - h / 2, zb, cx + w / 2, cy + h / 2, zb + b.t + b.top], ...info };
  if (b.bump) {   // one tall component (the USB-C socket) on an otherwise low board
    const p = rot(turn, b.bump[0], b.bump[1]), q = rot(turn, b.bump[2], b.bump[3]);
    part.bump = [cx + Math.min(p[0], q[0]), cy + Math.min(p[1], q[1]), zb + b.t, cx + Math.max(p[0], q[0]), cy + Math.max(p[1], q[1]), zb + b.t + b.bump[4]];
  }
  return part;
}
// world x, y of a named pin, and the z a wire starts from
export function pinAt(part, name) {
  const b = BOARD[part.kind], p = b.pins[name], [x, y] = rot(part.turn, p[0], p[1]), zb = part.at[2];
  const z = p[2] === 'hdr' ? zb - JUMPER.strip - JUMPER.housing : p[2] === 'qw' ? zb + b.t + 1.45 : zb + b.t;
  return [part.at[0] + x, part.at[1] + y, z];
}
export const boardXY = (part, x, y) => { const [a, b] = rot(part.turn, x, y); return [part.at[0] + a, part.at[1] + b]; };
// footprint of a jumper (housing + turn of the wire) hanging under one header pin
export function jumperBox(part, name) {
  const [x, y] = pinAt(part, name), zb = part.at[2], h = JUMPER.w / 2;
  return [x - h, y - h, zb - JUMPER.strip - JUMPER.housing - JUMPER.bend, x + h, y + h, zb];
}

// ---------- C7 box ----------
const IN = { w: 92, h: 56, d: 31 };
const WALL = 2, ZB = 25, ZF = 1;            // board level on the tray; floor boards sit on 1 mm ribs
const TRAY = { z: 20.5, t: 2, w: 91, h: 55 };
const c7Parts = [
  // floor level. The battery lies under the ESP32, between its two pin rows: no jumper hangs over it.
  place('bat', 'lipo', -12.9, -7, 0.3, 3, { level: 'floor', name: 'แบต LiPo 803040 (1100 mAh)', size: '40 × 30 × 8 มม.',
    where: 'พื้นกล่อง ใต้ ESP32 ระหว่างขา 2 แถว', mount: 'ช่องแบต 42 × 31 มม. (เผื่อแผ่นวงจรป้องกันที่ทำให้บางรุ่นยาวถึง 42 มม.): ครีบกั้นสูง 5 มม. รอบ 4 ด้าน เว้นช่องให้สายออกด้านขวา ติดเทปโฟมสองหน้าใต้แบต ไม่มีสกรูหรือหัวจัมเปอร์อยู่เหนือแบต',
    links: 'สายแดง → TP4056 B+ · สายดำ → TP4056 B- ออกทางช่องของครีบด้านขวา · เหนือแบตเหลือที่ว่าง 12 มม. ถึงใต้ถาด เผื่อแบตบวม' }),
  place('mt', 'mt3608', 27.5, 14, ZF, 2, { level: 'floor', name: 'MT3608 บูสต์เป็น 5 V', size: '36 × 17 มม.',
    where: 'พื้นกล่อง ด้านขวา กลางกล่อง', mount: 'ช่องบนพื้นกล่อง: ครีบรองสูง 1 มม. มุมกั้น 4 มุม และตะขอล็อก 2 ตัว (บอร์ดนี้ไม่มีรูยึด)',
    links: 'VIN ← สวิตช์ และ TP4056 OUT- · VOUT → ขา VIN, GND ของ ESP32 · ไม่มีสายจัมเปอร์ม้วนเก็บเหนือบอร์ดนี้' }),
  place('tp', 'tp4056', 27, -13.5, ZF, 1, { level: 'floor', name: 'TP4056 ชาร์จ USB-C', size: '28 × 17 มม.',
    where: 'พื้นกล่อง ด้านขวา ชิดผนังล่าง', mount: 'ช่องบนพื้นกล่อง: ครีบรองสูง 1 มม. มุมกั้น 4 มุม และตะขอล็อก 2 ตัว · ช่อง USB-C ตรงกับช่องเจาะที่ผนังล่าง',
    links: 'B+ / B- ← แบต · OUT+ → สวิตช์ · OUT- → MT3608 VIN-' }),
  { id: 'sw', level: 'floor', box: [36.5, -28, 0, 45.1, -23.7, 4.7], name: 'สวิตช์เลื่อน SS12D00', size: '8.6 × 4.3 × 4.7 มม.',
    where: 'พื้นกล่อง มุมขวาล่าง ก้านเลื่อนโผล่นอกกล่อง', mount: 'ร่องรับตัวสวิตช์ชิดผนังล่าง มีครีบกั้นหัวท้ายและครีบดันด้านหลัง ก้านเลื่อนลอดช่องผนัง',
    links: 'ขาริม ← TP4056 OUT+ · ขากลาง → MT3608 VIN+', pins: { A: [38.3, -22.4, 2.3], B: [40.8, -22.4, 2.3] } },
  // board level (on the tray)
  place('esp', 'esp32', -19, -11.9, ZB, -1, { level: 'board', name: 'ESP32 DevKit V1', size: '51.8 × 28.2 มม.',
    where: 'บนถาดบอร์ด ด้านซ้ายล่าง ช่อง micro-USB ชิดผนังซ้าย', mount: 'สกรู M2.5×6 4 ตัว ผ่านรูมุมบอร์ด (รู 2.8 มม.) ลงบ่ารับสูง 2.5 มม. บนถาด · ขาบอร์ด 2 แถวลอดร่องของถาดลงชั้นล่าง',
    hw: [['สกรู M2.5×6 เกลียวปล่อย', 4]], links: '3V3, GND, D21, D22 → Adapter 1 (จัมเปอร์ 4 เส้น เสียบจากใต้ถาด) · VIN, GND ← MT3608' }),
  place('hubA', 'qwiic', -25, 17.5, ZB, 0, { level: 'board', name: 'Qwiic Adapter 1 (จุดแยก)', size: '25.4 × 12.7 มม.',
    where: 'บนถาดบอร์ด มุมซ้ายบน ชิดร่องสายหูซ้าย', mount: 'วางบนบ่ารับ มีตะขอล็อกขอบยาว 2 ตัวกดไว้ (แผ่นนี้ไม่มีรูยึด) · ก้านขา 4 ขาลอดร่องของถาด',
    links: 'ก้านขา ← ESP32 · ช่องซ้าย → สาย 20 ซม. ไปหูซ้าย · ช่องขวา → สาย 5 ซม. ไป Adapter 2' }),
  // turned half a turn so its header row drops into the gap above the MT3608, next to the top wall
  place('hubB', 'qwiic', 27, 20.5, ZB, 2, { level: 'board', name: 'Qwiic Adapter 2 (จุดแยก)', size: '25.4 × 12.7 มม.',
    where: 'บนถาดบอร์ด มุมขวาบน ชิดร่องสายหูขวา', mount: 'วางบนบ่ารับ มีตะขอล็อกขอบยาว 2 ตัวกดไว้ · ก้านขา 4 ขาลอดร่องของถาด ลงช่องว่างระหว่าง MT3608 กับผนังบน',
    links: 'ช่องซ้าย ← สาย 5 ซม. จาก Adapter 1 · ก้านขา → GY-521 (จัมเปอร์ 4 เส้น) · ช่องขวา → สาย 20 ซม. ไปหูขวา' }),
  place('mpu', 'gy521', 18.4, -10, ZB, 0, { level: 'board', name: 'GY-521 MPU6050 (0x68)', size: '21 × 16 มม.',
    where: 'บนถาดบอร์ด ด้านขวาล่าง วางราบขนานกับหลังคอ', mount: 'สกรู M2.5×6 2 ตัว ผ่านรู 2 รูของบอร์ด ลงบ่ารับบนถาด · ก้านขาลอดร่องของถาด ลงช่องว่างระหว่างแบตกับ TP4056',
    hw: [['สกรู M2.5×6 เกลียวปล่อย', 2]], links: 'VCC, GND, SCL, SDA ← Adapter 2 (จัมเปอร์ 4 เส้น เสียบจากใต้ถาด)' }),
];
const by = Object.fromEntries(c7Parts.map((p) => [p.id, p]));
const USED = { esp: ['3V3', 'GNDR', 'D21', 'D22', 'VIN', 'GNDL'], hubA: ['GND', '3V3', 'SDA', 'SCL'], hubB: ['GND', '3V3', 'SDA', 'SCL'], mpu: ['VCC', 'GND', 'SCL', 'SDA'] };

// slots in the tray under every header row (wide enough for a jumper housing to pass)
const slot = (part, pad = 1.7) => BOARD[part.kind].rows.map(([x0, y0, x1, y1]) => {
  const a = boardXY(part, x0, y0), b = boardXY(part, x1, y1);
  return [Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad];
});
// Which Qwiic socket takes which cable. Both sockets of an adapter are the same bus; these are picked by position.
const PORTS = { link: [['hubA', 'QB'], ['hubB', 'QB']], earL: ['hubA', 'QA'], earR: ['hubB', 'QA'] };
// the 5 cm link between the two adapters lies on the tray in a U that dips into the free space above the ESP32.
// Points are [x, y] on the board level; the plugs are 2.5 mm stubs at both ends.
const linkA = pinAt(by.hubA, 'QB'), linkB = pinAt(by.hubB, 'QB'), LINK_LEN = 50;
const linkPath = [[linkA[0], linkA[1]], [linkA[0] + 2.5, linkA[1]], [-7, 12], [-6.5, 5.5], [0, 4.6], [6.5, 5.5], [9, 12], [linkB[0] - 2.5, linkB[1]], [linkB[0], linkB[1]]];
const linkRun = linkPath.slice(1).reduce((t, p, i) => t + Math.hypot(p[0] - linkPath[i][0], p[1] - linkPath[i][1]), 0);

export const C7 = {
  id: 'c7', name: 'กล่อง C7', in: IN, wall: WALL, floor: 2, lid: 2,
  out: { w: IN.w + 2 * WALL, h: IN.h + 2 * WALL, d: IN.d + 4 },
  zBoard: ZB, tray: { ...TRAY, slots: ['esp', 'hubA', 'hubB', 'mpu'].flatMap((id) => slot(by[id])) },
  // posts carry the tray; left/right take the tray screws, top/bottom take the long lid screws
  posts: [{ id: 'left', x: -43, y: 7, screw: 'tray' }, { id: 'top', x: 0, y: 24.5, screw: 'lid' }, { id: 'right', x: 43, y: -13, screw: 'tray' }, { id: 'bottom', x: 14.5, y: -25, screw: 'lid' }],
  postR: 3,
  parts: c7Parts, used: USED,
  // openings in the walls: [wall, centre along the wall, z0, z1, width]; z1 >= in.d means a notch open to the lid
  openings: [
    { id: 'usbEsp', wall: 'left', at: -11.9, z0: 23.6, z1: 31, w: 13, name: 'ช่อง micro-USB ของ ESP32 (ส่งข้อมูล)' },
    { id: 'usbC', wall: 'bottom', at: 27, z0: 0.6, z1: 7.8, w: 12.5, name: 'ช่อง USB-C ชาร์จแบต' },
    { id: 'swSlot', wall: 'bottom', at: 40.8, z0: 1.1, z1: 3.6, w: 6.5, name: 'ช่องก้านสวิตช์' },
    { id: 'glandL', wall: 'top', at: -42.5, z0: 25.6, z1: 31, w: 5, name: 'ร่องสายจากหูซ้าย' },
    { id: 'glandR', wall: 'top', at: 42.5, z0: 25.6, z1: 31, w: 5, name: 'ร่องสายจากหูขวา' },
  ],
  // [x0, y0, x1, y1], ribH tall. The right end is two pieces: the battery leads leave through the gap between them.
  batteryRibs: [[-35.1, -20, -33.9, -2.5], [-35.1, 3.6, -33.9, 7], [-30, -23.7, 5, -22.5], [-30, 8.5, 5, 9.7], [8.1, -22.5, 9.3, -13], [8.1, -1, 9.3, 8.5]], ribH: 5,
  batteryBay: [-33.9, -22.5, 8.1, 8.5],   // 42 x 31 mm: some 803040 cells are 42 mm long with their protection board
  ports: PORTS,
  link: { len: LINK_LEN, path: linkPath, run: linkRun, lowY: Math.min(...linkPath.map((p) => p[1])) },
  // strip clamp on the back: two rails on the outside of the floor, a plate screwed onto them
  clamp: { railY: 13.7, railW: 6, railH: 5, railL: 64, plate: [64, 40, 2.5], pad: 2, screwLen: 8, screws: [[-26, 16.7], [26, 16.7], [-26, -16.7], [26, -16.7]] },
  strip: { alu: 1.5, foam: 4, width: 19.05 },
  // the height budget that sets the box thickness
  stack: [
    ['ช่องเดินสายบนพื้น (สายวงจรแบต, TP4056, สวิตช์)', 5.5], ['ที่ให้สายจัมเปอร์เลี้ยว', JUMPER.bend], ['หัวจัมเปอร์ตัวเมีย', JUMPER.housing],
    ['พลาสติกของก้านขาใต้บอร์ด', JUMPER.strip], ['แผ่น PCB ของ ESP32', 1.6], ['ชิ้นส่วนบน ESP32 (ฝาครอบโมดูล)', 3.2], ['ช่องว่างใต้ฝา', 1.2],
  ],
  shell: [
    { id: 'base', level: 'base', name: 'ฐานกล่อง', size: '96 × 60 × 33 มม.', where: 'ชิ้นหลักของกล่อง: พื้น ผนัง 4 ด้าน เสา 4 ต้น ช่องแบต ช่องบอร์ด และราง 2 เส้นด้านหลัง',
      mount: 'ยึดกับแถบพาดบ่าด้วยแผ่นหนีบด้านหลัง (สกรู M3×8 4 ตัว)', links: 'ช่องเจาะ: micro-USB ผนังซ้าย, USB-C และก้านสวิตช์ผนังล่าง, ร่องสายหู 2 ร่องผนังบน' },
    { id: 'tray', level: 'tray', name: 'ถาดบอร์ด', size: '91 × 55 × 2 มม.', where: 'กลางกล่อง สูงจากพื้น 20.5 มม. แบ่งกล่องเป็น 2 ชั้น',
      mount: 'วางบนเสา 4 ต้น · สกรู M2.5×6 2 ตัวที่เสาซ้ายและเสาขวา · อีก 2 เสาถูกสกรูฝาขันทะลุถาดลงไป', hw: [['สกรู M2.5×6 เกลียวปล่อย', 2]],
      links: 'มีร่อง 5 ร่องให้ขาบอร์ดและหัวจัมเปอร์ลอดลงชั้นล่าง' },
    { id: 'lid', level: 'lid', name: 'ฝากล่อง', size: '96 × 60 × 2 มม.', where: 'ด้านนอกสุด (ด้านที่หันออกจากตัว)',
      mount: 'ขอบฝาสวมในผนัง · สกรู M2.5×20 2 ตัว ผ่านปลอกใต้ฝา ทะลุถาด ลงเสาบนและเสาล่าง', hw: [['สกรู M2.5×20 เกลียวปล่อย', 2]],
      links: 'ปิดร่องสายหูและช่อง micro-USB จากด้านบน' },
    { id: 'clamp', level: 'clamp', name: 'แผ่นหนีบแถบ + แผ่นรองนุ่ม', size: '64 × 40 × 2.5 มม.', where: 'หลังกล่อง ด้านที่ชิดตัว',
      mount: 'สกรู M3×8 หัวจม 4 ตัว ขันเข้าราง 2 เส้นหลังกล่อง ปลายสกรูหยุดก่อนถึงด้านในกล่อง 1.5 มม. (ห้ามใช้ยาวกว่า 8 มม. เพราะแบตอยู่หลังพื้นกล่องตรงนั้น) หนีบแถบไว้ระหว่างราง', hw: [['สกรู M3×8 หัวจม', 4]],
      links: 'รางห่างกัน 27.4 มม. ใส่แถบได้ถึง 1 นิ้ว' },
    { id: 'strip', level: 'strip', name: 'แถบที่ดามนิ้ว (โครงพาดบ่า)', size: 'กว้าง ½–1 นิ้ว หนา ~5.5 มม.', where: 'ลอดระหว่างราง 2 เส้นหลังกล่อง',
      mount: 'ถูกแผ่นหนีบกดกับหลังกล่อง ไม่ต้องเจาะแถบ', links: 'พาดบ่าทั้งสองข้าง ดูหน้าแบบอุปกรณ์เสริม' },
  ],
};

// Wires inside the C7 box. via = waypoints [x, y, z, level]; level says which layer the point moves with when exploded.
const J = 'สายจัมเปอร์เมีย-เมีย', SOLDER = 'สายไฟอ่อน บัดกรี';
export const C7_WIRES = [
  { cable: 'jEsp', net: 'v33', a: ['esp', '3V3'], b: ['hubA', '3V3'], type: J },
  { cable: 'jEsp', net: 'gnd', a: ['esp', 'GNDR'], b: ['hubA', 'GND'], type: J },
  { cable: 'jEsp', net: 'sda', a: ['esp', 'D21'], b: ['hubA', 'SDA'], type: J },
  { cable: 'jEsp', net: 'scl', a: ['esp', 'D22'], b: ['hubA', 'SCL'], type: J },
  { cable: 'jGy', net: 'v33', a: ['hubB', '3V3'], b: ['mpu', 'VCC'], type: J, viaLevel: 'tray', via: [[19, 25, 11], [8.4, 22, 12], [9.0, 4, 12]] },
  { cable: 'jGy', net: 'gnd', a: ['hubB', 'GND'], b: ['mpu', 'GND'], type: J, viaLevel: 'tray', via: [[18, 24.6, 11], [8.9, 21, 12], [10.6, 4, 12]] },
  { cable: 'jGy', net: 'sda', a: ['hubB', 'SDA'], b: ['mpu', 'SDA'], type: J, viaLevel: 'tray', via: [[17, 24.2, 11], [9.4, 20, 12], [12.2, 4, 12]] },
  { cable: 'jGy', net: 'scl', a: ['hubB', 'SCL'], b: ['mpu', 'SCL'], type: J, viaLevel: 'tray', via: [[16, 23.8, 11], [9.9, 19, 12], [13.8, 4, 12]] },
  { cable: 'pwr', net: 'bat', a: ['bat', '+'], b: ['tp', 'B+'], type: SOLDER, via: [[11, -10, 5], [14, -4, 2.5], [16, 2.5, 2.5], [24.6, 2.6, 2.6]] },
  { cable: 'pwr', net: 'gnd', a: ['bat', '-'], b: ['tp', 'B-'], type: SOLDER, via: [[11, -4, 5], [15.5, -1, 2.5], [18, 4.2, 2.5], [29, 4.2, 2.6]] },
  { cable: 'pwr', net: 'bat', a: ['tp', 'OUT+'], b: ['sw', 'A'], type: SOLDER, via: [[20.8, 1.8, 3], [36.8, 1.6, 3.2], [37.6, -10, 3], [37.9, -19, 2.5]] },
  { cable: 'pwr', net: 'bat', a: ['sw', 'B'], b: ['mt', 'VIN+'], type: SOLDER, via: [[40.8, -19.5, 3], [38.8, -17, 3.2], [38.8, -8, 3.2], [41, 1.5, 3], [43.5, 5, 3]] },
  { cable: 'pwr', net: 'gnd', a: ['tp', 'OUT-'], b: ['mt', 'VIN-'], type: SOLDER, via: [[33.4, 2.5, 3], [42, 4, 3.5], [45.3, 7, 5], [45.3, 18.5, 5]] },
  { cable: 'pwr5', net: 'bat', a: ['mt', 'VOUT+'], b: ['esp', 'VIN'], type: 'สายจัมเปอร์ตัดปลาย บัดกรีที่ MT3608', via: [[8.6, 10.6, 4], [-10, 11.2, 4], [-36, 10.5, 4], [-38.4, 4, 5]] },
  { cable: 'pwr5', net: 'gnd', a: ['mt', 'VOUT-'], b: ['esp', 'GNDL'], type: 'สายจัมเปอร์ตัดปลาย บัดกรีที่ MT3608', via: [[7, 21, 4], [-10, 13.5, 4], [-33.5, 12.5, 4], [-35.8, 4.5, 5]] },
];
export const C7_CABLES = {
  jEsp: ['จัมเปอร์ ESP32 → Adapter 1 (4 เส้น)', 'เสียบใต้ถาดทั้งสองปลาย เดินเหนือแบตใต้ถาด สายส่วนเกินพับเก็บในที่ว่างมุมซ้ายบนของชั้นล่าง ห่างจาก MT3608 (ห้ามม้วนเก็บเหนือ MT3608)'],
  jGy: ['จัมเปอร์ Adapter 2 → GY-521 (4 เส้น)', 'เสียบใต้ถาดทั้งสองปลาย เดินอ้อมมุมซ้ายบนของ MT3608 ไม่พาดข้ามบอร์ด สายส่วนเกินพับเก็บในช่องว่างระหว่างแบตกับ TP4056'],
  pwr: ['สายวงจรแบต (พื้นกล่อง)', 'แบต → TP4056 → สวิตช์ → MT3608 เดินชิดพื้นฝั่งขวาของกล่อง ออกจากช่องแบตทางช่องของครีบ'],
  pwr5: ['สาย 5 V ขึ้น ESP32', 'จาก MT3608 VOUT เดินชิดพื้นด้านบนของช่องแบต ไปเสียบขา VIN และ GND ของ ESP32 จากใต้ถาด (ราว 7 ซม.)'],
  link: ['สาย Qwiic 5 ซม. (Adapter 1 → 2)', 'โค้งเป็นรูปตัว U บนถาด ในที่ว่างระหว่าง Adapter ทั้งสอง'],
  earL: ['สาย Qwiic 20 ซม. จากหูซ้าย (เส้นเดียว)', 'จากตลับหูซ้ายตรงมาเข้ากล่องทางร่องผนังบนด้านซ้าย มียางกันสายและเคเบิลไทร์รัดด้านในกันดึง แล้วเสียบช่องซ้ายของ Adapter 1 ซึ่งอยู่ติดร่อง'],
  earR: ['สาย Qwiic 20 ซม. จากหูขวา (เส้นเดียว)', 'จากตลับหูขวาตรงมาเข้ากล่องทางร่องผนังบนด้านขวา มียางกันสายและเคเบิลไทร์รัดด้านในกันดึง แล้วเสียบช่องขวาของ Adapter 2 ซึ่งอยู่ติดร่อง'],
};

// ---------- ear pod (one each side). Pod frame: x along the cup (cable end at +x * s), y up, z out of the cup. ----------
// s = +1 for the left pod (cable leaves towards the back = +x), -1 for the right pod (mirror image).
const POD_IN = { w: 36, h: 25.5, d: 6.3 };
export function pod(s) {
  const side = s > 0 ? 'ซ้าย' : 'ขวา', id = s > 0 ? 'L' : 'R';
  const bno = place('bno' + id, 'bno085', -s * 4.2, 0, 1.2, 0, { level: 'board', name: `BNO085 ${side} (${s > 0 ? '0x4A' : '0x4B'})`, size: '25.6 × 22.7 มม.',
    where: 'ในตลับ หน้าบอร์ดหันออกนอกหู', mount: 'สกรู M2.5×4 2 ตัว (มุมทแยง) ลงบ่ารับสูง 1.2 มม. อีก 2 มุมเป็นหมุดนำตำแหน่ง', hw: [['สกรู M2.5×4 เกลียวปล่อย', 2]],
    links: s > 0 ? 'ช่อง STEMMA QT ด้านหลัง ← สาย Qwiic 20 ซม. · ขา DI ปล่อยว่าง = 0x4A' : 'ช่อง STEMMA QT ด้านหลัง ← สาย Qwiic 20 ซม. · บัดกรีสายสั้น 3Vo → DI = 0x4B' });
  return {
    id: 'pod' + id, s, name: 'ตลับเซ็นเซอร์' + side, in: POD_IN, wall: 1.5, floor: 1.5, lid: 1.2,
    out: { w: POD_IN.w + 3, h: POD_IN.h + 3, d: POD_IN.d + 2.7 },
    parts: [bno], socket: s > 0 ? 'QT2' : 'QT',
    cableRoom: POD_IN.w / 2 - (bno.box[s > 0 ? 3 : 0]) * s,
    exit: { x: s * 14.5, w: 4 }, clampAt: [s * 14.5, -8.2],
    shell: [
      { id: 'podBase' + id, level: 'base', name: `ฐานตลับ${side}`, size: '39 × 28.5 × 7.8 มม.', where: 'แปะด้านนอกฝาครอบหูฟัง', mount: 'แผ่นตีนตุ๊กแก 34 × 24 มม. ใต้ฐาน แปะกับฝาครอบหู ถอดได้', links: 'ร่องสายออกที่มุมล่างด้านหลัง' },
      { id: 'podLid' + id, level: 'lid', name: `ฝาตลับ${side}`, size: '39 × 28.5 × 1.2 มม.', where: 'ด้านนอกสุด มีลูกศรชี้ไปด้านหน้า', mount: 'กดล็อกด้วยตะขอ 4 จุด (ขอบยาวด้านละ 2)', links: '' },
      { id: 'podClamp' + id, level: 'clamp', name: 'แคลมป์รัดสาย', size: '8 × 4 มม.', where: 'ในตลับ ก่อนสายออกนอกตลับ', mount: 'สกรู M2×5 1 ตัว กดสายกับพื้นตลับ กันสายดึงหัวต่อ', hw: [['สกรู M2×5 เกลียวปล่อย', 1]], links: '' },
    ],
  };
}

// One 200 mm Flexible Qwiic cable per ear, no joint. How much of it is used up inside the enclosures (mm):
// socket -> gland in the C7 box, and exit -> clamp -> socket in the pod. What is left runs from ear to neck.
const glandRun = (id, pin, gx) => { const p = pinAt(by[id], pin); return 3 + Math.hypot(gx - (p[0] + Math.sign(gx) * 3), 3.2) + (IN.h / 2 - p[1] - 3.2) + WALL; };
const EAR_IN_POD = 18;
export const EAR_CABLE = {
  len: 200, inPod: EAR_IN_POD,
  inBox: { L: glandRun(...PORTS.earL, -42.5), R: glandRun(...PORTS.earR, 42.5) },
  get outside() { return this.len - this.inPod - Math.max(this.inBox.L, this.inBox.R); },
};

export const UNITS = { c7: C7, podL: pod(1), podR: pod(-1) };
// every screw and small fixing in the design, for the hardware table
export function hardware() {
  const sum = new Map();
  const add = (list, times = 1) => { for (const [n, c] of list || []) sum.set(n, (sum.get(n) || 0) + c * times); };
  for (const u of Object.values(UNITS)) for (const p of [...u.parts, ...u.shell]) add(p.hw);
  return [...sum.entries()].sort();
}
