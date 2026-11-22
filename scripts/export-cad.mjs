// Write cad/params.scad from assets/structure-layout.js (through scripts/cad-model.mjs).
// node scripts/export-cad.mjs [--fit 0.25] [--hole-add 0.15] [--screw pilot|insert] [--pod-cable 1.2]
// Prints the part names, one per line, so scripts/build-cad.ps1 knows what to render.
import { writeFile } from 'node:fs/promises';
import { paramsScad, cadParts, bbox, DEFAULTS } from './cad-model.mjs';

const args = process.argv.slice(2), opt = { ...DEFAULTS };
for (let i = 0; i < args.length; i += 2) {
  const [k, v] = [args[i], args[i + 1]];
  if (k === '--fit') opt.fit = Number(v);
  else if (k === '--hole-add') opt.holeAdd = Number(v);
  else if (k === '--screw') opt.screwMode = v;
  else if (k === '--pod-cable') opt.podCable = Number(v);
  else { console.error(`unknown option ${k}`); process.exit(2); }
}
if (!(opt.fit >= 0 && opt.fit < 1) || !(opt.holeAdd >= 0 && opt.holeAdd < 1) || !['pilot', 'insert'].includes(opt.screwMode) || !(opt.podCable > 0 && opt.podCable < 2.8)) {
  console.error('bad option value', opt); process.exit(2);
}
await writeFile(new URL('../cad/params.scad', import.meta.url), paramsScad(opt), 'utf8');
const dropped = [];
for (const p of cadParts({ ...opt, dropped })) console.log(p.name, bbox(p).size.join('x'), p.note);
// features of structure.js that do not fit next to another part (left out or moved); stderr so build-cad.ps1 still reads names from stdout
for (const d of dropped) console.error('adjusted:', d);
