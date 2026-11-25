// Runs the real layout() and composeGray() from core.js: the per-image edits.
import '../core.js';

const C = globalThis.SleepScreensCore;
let fails = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
}
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;
const px = (...rgba) => new Uint8ClampedArray(rgba);

console.log('composeGray():');
const e = C.defaultEdit();
check('transparent pixel takes the white background', C.composeGray(px(0, 0, 0, 0), e)[0] === 255);
check('transparent pixel takes the black background', C.composeGray(px(0, 0, 0, 0), { ...e, bg: 'black' })[0] === 0);
check('opaque black stays black', C.composeGray(px(0, 0, 0, 255), e)[0] === 0);
check('invert flips the image', C.composeGray(px(0, 0, 0, 255), { ...e, invert: true })[0] === 255);
check('invert leaves the background alone', C.composeGray(px(0, 0, 0, 0), { ...e, invert: true })[0] === 255);
check('half-transparent black on white is mid grey', near(C.composeGray(px(0, 0, 0, 255 / 2), e)[0], 127.5, 0.6));
const g = C.composeGray(px(128, 128, 128, 255), { ...e, gamma: 1.5 })[0];
check('brightness above 1 lightens', g > 128, `got ${g.toFixed(1)}`);
const gi = C.composeGray(px(64, 64, 64, 255), { ...e, invert: true, gamma: 1.5 })[0];
check('brightness lightens after inverting', gi > 191, `got ${gi.toFixed(1)}`);

console.log('\nlayout() on a 480 x 800 screen:');
let L = C.layout(1000, 1000, 480, 800, e, 'contain');
check('no edit: follows Fit', L.dw === 480 && L.dh === 480 && L.dy === 160 && L.fit === 'contain');
L = C.layout(1000, 1000, 480, 800, { ...e, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } }, 'cover');
check('crop uses only the chosen part', L.sx === 500 && L.sw === 500 && L.sh === 1000);
check('cropped image fills by Fit', L.dw === 480 && L.dh === 960 && L.dy === -80);
L = C.layout(1000, 500, 480, 800, { ...e, dest: { x: 0.25, y: 0.5, w: 0.5 } }, 'cover');
check('placed image keeps its shape', L.dx === 120 && L.dy === 400 && L.dw === 240 && L.dh === 120 && L.fit === 'custom');
L = C.layout(1000, 500, 600, 600, { ...e, dest: { x: 0, y: 0, w: 0.5 } }, 'cover');
check('still unstretched on another screen size', L.dw === 300 && L.dh === 150);

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll compose checks passed.');
process.exit(fails ? 1 : 0);
