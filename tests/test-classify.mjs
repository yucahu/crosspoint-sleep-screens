// Runs the real classify(), selectBlocks(), resolveFit() and parseChannel() from
// core.js. Block shapes follow live API v3 responses.
import '../core.js';

const C = globalThis.SleepScreensCore;
const cfg = { ...C.DEFAULTS };

const img = (ct, extra = {}) => ({
  content_type: ct, width: 1200, height: 900, src: 'https://cdn/x',
  small: { src: 'https://img/s' }, medium: { src: 'https://img/m' }, large: { src: 'https://img/l' }, ...extra
});

const cases = [
  ['uploaded JPEG',       { id: 1, type: 'Image', state: 'available', title: 'photo', image: img('image/jpeg') }, true],
  ['uploaded PNG',        { id: 2, type: 'Image', title: 'png', image: img('image/png') }, true],
  ['GIF',                 { id: 3, type: 'Image', title: 'gif', image: img('image/gif') }, true],
  ['text block',          { id: 4, type: 'Text', content: { markdown: 'hello' } }, false],
  ['nested channel',      { id: 5, type: 'Channel', title: 'sub' }, false],
  ['link w/ og image',    { id: 6, type: 'Link', title: 'article', image: img('image/jpeg') }, false],
  ['embed poster',        { id: 7, type: 'Embed', title: 'video', image: img('image/jpeg') }, false],
  ['PDF attachment',      { id: 8, type: 'Attachment', title: 'paper', attachment: { content_type: 'application/pdf' }, image: img('image/png') }, false],
  ['image attachment',    { id: 9, type: 'Attachment', title: 'tiff', attachment: { content_type: 'image/tiff' }, image: img('image/png') }, true],
  ['svg',                 { id: 10, type: 'Image', title: 'logo', image: img('image/svg+xml') }, false],
  ['image, no urls',      { id: 11, type: 'Image', title: 'broken', image: { content_type: 'image/jpeg', width: 900, height: 900 } }, false],
  ['image, no ct',        { id: 12, type: 'Image', title: 'noct', image: { src: 'https://cdn/x' } }, false],
  ['Image, no image obj', { id: 13, type: 'Image', title: 'empty' }, false],
  ['still processing',    { id: 14, type: 'Image', state: 'processing', title: 'pending', image: img('image/jpeg') }, false],
  ['wide sliver (live)',  { id: 15, type: 'Image', title: 'sliver', image: img('image/jpeg', { width: 1179, height: 268 }) }, false],
  ['exactly min size',    { id: 16, type: 'Image', title: 'edge', image: img('image/jpeg', { width: 400, height: 400 }) }, true],
  ['no dims: not guarded',{ id: 17, type: 'Image', title: 'nodims', image: img('image/jpeg', { width: null, height: null }) }, true]
];

let fails = 0;
function check(name, pass, detail = '') {
  if (!pass) fails++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

console.log('classify():');
for (const [name, block, want] of cases) {
  const r = C.classify(block, cfg);
  check(name.padEnd(22), r.ok === want, r.ok ? '' : `reason: ${r.reason}`);
  if (!r.ok) check(`${name}: has a reason`.padEnd(22), !!r.reason);
}
check('prefers the resized image', C.classify(cases[0][1], cfg).url === 'https://img/m');
check('falls back to the original', C.classify({ id: 1, type: 'Image', image: { content_type: 'image/png', src: 'https://cdn/o' } }, cfg).url === 'https://cdn/o');

console.log('\nwith opt-ins enabled:');
const open = { ...cfg, includeLinkThumbs: true, includeAttachmentPreviews: true, allowSvg: true };
for (const [name, block] of cases.filter(([n]) => ['link w/ og image', 'embed poster', 'PDF attachment', 'svg'].includes(n))) {
  check(name.padEnd(22), C.classify(block, open).ok === true);
}

console.log('\nselectBlocks():');
// The fixtures share one URL, so give each its own file or they dedupe to one.
const blocks = cases.map(([, b]) => (b.image ? { ...b, image: { ...b.image, filename: `f${b.id}` } } : b));
const a = C.selectBlocks(blocks, cfg);
check('kept + skipped accounts for every block', a.kept.length + a.skipped.length === blocks.length);
const shuffled = C.selectBlocks(blocks, { ...cfg, order: 'random' }, () => 0);
check('random keeps the same set', shuffled.kept.map((x) => x.id).sort().join() === a.kept.map((x) => x.id).sort().join());
check('random changes the order', shuffled.kept.map((x) => x.id).join() !== a.kept.map((x) => x.id).join());

const dupes = C.selectBlocks([
  { id: 50, type: 'Image', image: img('image/png', { filename: 'abc.png' }) },
  { id: 51, type: 'Image', image: img('image/png', { filename: 'abc.png' }) }
], cfg);
check('same file connected twice is kept once', dupes.kept.length === 1 && /duplicate/.test(dupes.skipped[0].reason));

console.log('\nresolveFit() on a 480 x 800 screen:');
for (const [sw, sh, want] of [[1125, 479, 'contain'], [1179, 1450, 'cover'], [480, 800, 'cover'], [1170, 1145, 'contain']]) {
  const got = C.resolveFit('auto', sw, sh, 480, 800);
  check(`${sw} x ${sh}`.padEnd(14) + ` -> ${want}`, got === want, got === want ? '' : `got ${got}`);
}
check('explicit fit is respected', C.resolveFit('cover', 1125, 479, 480, 800) === 'cover');

console.log('\nparseChannel():');
for (const [input, want] of [
  ['https://are.na/enzo/real-3bs49wxggr4', 'real-3bs49wxggr4'],
  ['https://www.are.na/enzo/real-3bs49wxggr4', 'real-3bs49wxggr4'],
  ['are.na/enzo/real-3bs49wxggr4', 'real-3bs49wxggr4'],
  ['https://www.are.na/enzo/real-3bs49wxggr4?foo=1', 'real-3bs49wxggr4'],
  ['enzo/real-3bs49wxggr4', 'real-3bs49wxggr4'],
  ['real-3bs49wxggr4', 'real-3bs49wxggr4'],
  ['  real-3bs49wxggr4  ', 'real-3bs49wxggr4'],
  ['real-3bs49wxggr4?x=1', 'real-3bs49wxggr4'],
  ['', '']
]) {
  const got = C.parseChannel(input);
  check(JSON.stringify(input).padEnd(50), got === want, got === want ? '' : `got ${JSON.stringify(got)}`);
}

console.log(fails ? `\n${fails} FAILURE(S)` : '\nAll classification checks passed.');
process.exit(fails ? 1 : 0);
