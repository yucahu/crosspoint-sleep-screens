#!/usr/bin/env node
// Runs the real classifier from core.js against a live channel and reports what
// a sync would do, plus the facts the design depends on: CORS on the API and on
// both image hosts, and which rate-limit tier the request landed in.
//
//   node tools/probe-arena.mjs https://are.na/you/your-channel
//   ARENA_TOKEN=... node tools/probe-arena.mjs your-channel
//   node tools/probe-arena.mjs your-channel --raw > raw.json

import '../core.js';

const C = globalThis.SleepScreensCore;
const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const token = args.includes('--token') ? args[args.indexOf('--token') + 1] : process.env.ARENA_TOKEN || '';
const cfg = {
  ...C.DEFAULTS,
  includeLinkThumbs: args.includes('--link-thumbs'),
  includeAttachmentPreviews: args.includes('--attachment-previews'),
  allowSvg: args.includes('--allow-svg')
};

if (!input) {
  console.error('usage: node tools/probe-arena.mjs <channel-url-or-slug> [--token T] [--raw]');
  process.exit(2);
}

const slug = C.parseChannel(input);
let rate = null;
const { channel, blocks } = await C.fetchChannel(slug, { token, onRate: (r) => { rate = r; } });

if (args.includes('--raw')) {
  console.log(JSON.stringify({ channel, blocks }, null, 2));
  process.exit(0);
}

console.log(`Channel : ${channel.title} (${channel.visibility}), ${blocks.length} of ${channel.counts?.contents} reported`);
console.log(`Tier    : ${rate?.tier}, ${rate?.remaining} of ${rate?.limit} reads left this minute`);

const byType = {};
blocks.forEach((b) => { byType[b.type] = (byType[b.type] || 0) + 1; });
console.log(`Types   : ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(', ')}`);

const { kept, skipped } = C.selectBlocks(blocks, cfg);
console.log(`\n--- would sync (${kept.length}) ---`);
kept.forEach((c, i) => console.log(`  ${String(i + 1).padStart(2)}. ${c.ct.padEnd(10)} ${String(c.width).padStart(5)} x ${String(c.height).padEnd(5)} ${c.label}`));
console.log(`\n--- would skip (${skipped.length}) ---`);
skipped.forEach((c) => console.log(`  [${c.type}] ${c.label}  ->  ${c.reason}`));

// A server only answers CORS when the request carries an Origin, so sending one
// is what makes this test mean anything. HEAD is not used: the CDN's WAF can
// answer it with an empty 202 while serving GET normally.
async function cors(name, url, headers = {}) {
  const res = await fetch(url, { headers: { Origin: 'http://crosspoint.local', ...headers } });
  await res.arrayBuffer();
  console.log(`  ${name.padEnd(12)} HTTP ${res.status}, ${String(res.headers.get('content-type')).padEnd(24)} ` +
    `allow-origin: ${res.headers.get('access-control-allow-origin') || 'ABSENT'}`);
}

console.log('\n--- cross-origin access ---');
await cors('API', `${C.API}/ping`);
if (kept[0]) {
  const original = blocks.find((b) => b.id === kept[0].id).image.src;
  await cors('resized', kept[0].url);
  await cors('original', original);
}
