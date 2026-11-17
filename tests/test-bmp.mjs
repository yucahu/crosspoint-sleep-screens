// Generates BMPs and a ZIP with the real code in core.js, so verify-bmp.py and
// an independent zip reader can check them. Output goes to tests/out/.
import fs from 'node:fs';
import '../core.js';

const C = globalThis.SleepScreensCore;
const outDir = new URL('./out/', import.meta.url);
fs.mkdirSync(outDir, { recursive: true });

// Horizontal ramp with hard black and white boxes, so the gradient (dither) and
// flat regions can both be checked.
function makeGray(w, h) {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = (x / (w - 1)) * 255;
      if (x < 40 && y < 40) v = 0;
      if (x >= w - 40 && y < 40) v = 255;
      g[y * w + x] = v;
    }
  }
  return g;
}

let fails = 0;
const files = [];
for (const key of ['X4', 'X3']) {
  const { w, h } = C.PANELS[key];
  for (const bpp of [2, 1]) {
    const levels = C.dither(makeGray(w, h), w, h, bpp === 1 ? 2 : 4);
    const bytes = C.encodeBmp(levels, w, h, bpp);
    const name = `out_${key}_${bpp}bpp.bmp`;
    fs.writeFileSync(new URL(name, outDir), bytes);
    files.push({ path: `.sleep/${name}`, bytes });

    const stride = ((w * bpp + 31) >> 5) << 2;
    const firmware = bpp === 2 ? (((w + 15) / 16) | 0) * 4 : stride;
    if (stride !== firmware) fails++;
    console.log(`${key} ${w}x${h} ${bpp}bpp  size=${bytes.length} stride=${stride} firmware_stride=${firmware}`);
  }
}

// Tone: the mean of a dithered mid-grey should stay near mid-grey. Truncating the
// error terms to integers (the old Int16Array) fails this.
const w = 480, h = 800;
for (const target of [40, 128, 200]) {
  const levels = C.dither(new Float32Array(w * h).fill(target), w, h, 4);
  let sum = 0;
  for (const l of levels) sum += l * 85;
  const mean = sum / levels.length, drift = Math.abs(mean - target);
  // Atkinson discards 1/4 of the error, so a small drift is inherent to it.
  const pass = drift < 12;
  if (!pass) fails++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  flat grey ${target} dithers to mean ${mean.toFixed(1)}`);
}

fs.writeFileSync(new URL('out.zip', outDir), C.makeZip(files));
const crc = C.crc32(new TextEncoder().encode('123456789')).toString(16);
if (crc !== 'cbf43926') fails++;
console.log(`${crc === 'cbf43926' ? 'PASS' : 'FAIL'}  crc32 check value (${crc})`);
process.exit(fails ? 1 : 0);
