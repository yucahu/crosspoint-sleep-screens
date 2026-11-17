# CrossPoint Sleep Screens: Are.na → `/sleep` — design notes

First named arena-sleep. The SD manifest keeps the old name, `.arena-sleep.json`,
and the web app reads settings saved under the old `arena-sleep.` storage keys.

Everything happens in a browser tab: Are.na access, decoding, scaling, dithering.
Firmware is never modified, so nothing runs into `SCOPE.md`'s closed "new external
network connector" area.

Target firmware: `crosspoint-reader/crosspoint-reader` @ `develop`, `pluginApi: 1`.
Line references were read from `develop` on 2026-11-04.

## 1. Layout

| File | Role |
|---|---|
| `core.js` | API client, classification, fit, dither, BMP, ZIP, SD write. Classic script, no dependencies, runs in browsers and Node. |
| `web/` | Static web app. Exports to the SD card or a ZIP. |
| `plugin.js`, `manifest.json` | Reader plugin. Loads `core.js` from its own folder and writes over Wi-Fi. |
| `tools/`, `tests/` | Live probe, local server, checks. All run the real `core.js`. |

No backend: `api.are.na`, `d2w9rnfcy7mm78.cloudfront.net` and `images.are.na` all
answer `Access-Control-Allow-Origin: *`, and the API's preflight allows the
`Authorization` header.

## 2. Are.na: API, not scraping

Uses **API v3** (`/v3/channels/{id}` and `/contents`). The v3 docs still call it a
work in progress and suggest v2 for production. It is used anyway because all of
it is contained in one file and it provides what matters here:

| | v3 | v2 |
|---|---|---|
| Image dimensions and file size before downloading | yes | no |
| Paging metadata | `meta.has_more_pages`, `total_count` | none on `/contents` |
| Documented sort options | yes, `sort=` | not checked |

`sort` is always sent: the API documents two different defaults
(`position_asc`, `position_desc`), and live responses return `position_desc`.

Scraping has no advantage. The channel page renders client-side, so it would mean
running a browser to reach the same data, and Are.na's terms restrict automated
collection. The API's acceptable-use note also prohibits crawling and systematic
downloading, so this stays a user-initiated, capped fetch.

Rate limits are global per account, or per IP for guests:

| Tier | Reads/min |
|---|---|
| Guest | 30 |
| Free | 120 |
| Premium | 300 |
| Supporter | 600 |

A sync costs 1 request plus 1 per 100 blocks. Image downloads aren't API calls.

## 3. Reader contract

| Step | Endpoint | Notes |
|---|---|---|
| Fetch image bytes (fallback only) | `POST /api/fetch` | Used only if a direct fetch fails. Streams to SD. |
| Read those bytes back | `GET /download?path=` | Same-origin, so the canvas is not tainted. |
| Create the temp folder | `POST /mkdir` | Takes `name` plus the parent `path`. |
| List `/sleep` | `GET /api/files?path=/sleep` | |
| Remove old images | `POST /delete` | Accepts `paths=[...]`. |
| Write each BMP | `POST /api/plugin-fs` (via `api.writeFile`) | 256 KB cap per file. |

Host API, from `src/network/html/js/plugin-host.js:186-201`:

```js
{ name, dir, relay(method, url, headers, body), crypto(op, fields),
  writeFile(path, dataB64), fetchToSd(url, dest, headers, options),
  registerAction(action, fn), pluginFile(file) }
```

`registerPlugin(fn)` must be called while the script runs, so `plugin.js` calls it
first and loads `core.js` inside the async render.

`/plugin` serves any file in the plugin folder without authentication
(`CrossPointWebServer.cpp:2142`), so tokens are never written there.

The server enables CORS on every response (`CrossPointWebServer.cpp:415`), so a
page on another origin could talk to the reader. An HTTPS page cannot, because
browsers block requests to plain `http://crosspoint.local` as mixed content. That
is why the hosted web app exports to the card rather than pushing over Wi-Fi.

## 3a. Sleep folder and Wi-Fi sending

The firmware reads `/.sleep` and falls back to `/sleep` (USER_GUIDE 3.7). Output
goes to `/sleep` because:

- macOS hides dot folders, so an unzipped `.sleep` looks like an empty folder.
- The web server refuses any name starting with `.` (`CrossPointWebServer.cpp:917`),
  which also blocked the plugin's old `/.crosspoint/arena-tmp` fallback folder.

The menu is **Settings → Display → Sleep Screen** (USER_GUIDE 3.6.1). Earlier notes
said Appearance.

**Send over Wi-Fi** (`sendToReader()` in `core.js`) uses the reader's own endpoints:
`GET /api/files`, `POST /mkdir` (`name`, `path`), `POST /upload?path=/sleep&overwrite=1`
(multipart) and `POST /delete` (`paths` as a JSON array). Every request is a simple
CORS request, so there's no preflight. From an HTTPS page it relies on Chrome's Local
Network Access exception for `.local` names and private IPs, which needs the user's
permission. Requests carry `targetAddressSpace: 'local'`. Tested only against a fake
reader on localhost.

## 4. Output format

Mirrors what the firmware writes for its own covers
(`src/activities/util/BmpViewerActivity.cpp:355-372`):

- 2 bpp, top-down (negative `biHeight`), `BITMAPINFOHEADER`, `BI_RGB`, `biClrUsed = 4`
- Palette `0, 85, 170, 255`
- Row stride `((width * bpp + 31) >> 5) << 2`, equal to the firmware's `(width + 15) / 16 * 4`
- Pixels packed MSB-first

Dithering is Atkinson on a `Float32Array`. The earlier `Int16Array` truncated the
error terms and lost most of them in smooth areas.

## 5. Screen size: portrait

Sleep screens are drawn in portrait. `SleepActivity` sets
`Orientation::Portrait` (`SleepActivity.cpp:734`), and `getScreenWidth()` then
returns the panel's short side (`GfxRenderer.cpp:1936`). The rescale cache is
skipped only when the BMP matches that size (`SleepActivity.cpp:765`).

| Reader | BMP size | 2-bit file |
|---|---|---|
| X4 / X4 Pro / X4 Classic | 480 × 800 | 96,070 bytes |
| X3 | 528 × 792 | 104,614 bytes |
| Others | enter by hand | |

The first version wrote 800 × 480 and 792 × 528, so every image would have missed
the direct path and been rescaled on the device.

## 6. Block classification

Field paths are from live v3 responses. Every skip carries a reason.

| Block | Default | Reason |
|---|---|---|
| `Image` with `image.content_type: image/*` | sync | an uploaded image |
| `Attachment` with `attachment.content_type: image/*` | sync | an image filed as an attachment |
| `Text`, `Channel` | skip | no image |
| `Link`, `Embed` | skip | generated thumbnail. v3's `Embed` is v2's `Media`. |
| `Attachment` that isn't an image | skip | the image is a generated preview |
| `image/svg+xml` | skip | rasterises unpredictably |
| `state` other than `available` | skip | still processing |
| missing `image`, `content_type` or URL | skip | malformed |
| short side under `minSourcePx` (400) | skip | checked from the block's own dimensions |
| same `image.filename` as an earlier block | skip | filenames are content hashes |

Link, attachment-preview and SVG rows have opt-ins.

Image URL preference: `image.medium.src` (up to 1200px, usually a fraction of the
original's bytes), then `large`, then the original `src`.

Live result for `real-3bs49wxggr4`, 77 blocks: 61 kept; 16 skipped, being
4 channels, 2 embeds, 1 link and 9 images under 400px.

## 7. Fit

`auto` is the default: crop if that keeps at least 70% of the image, otherwise show
the whole image on white. This matters because the screen is portrait and many
images are wide: 19 of the first 24 in the test channel use the whole-image path.

## 8. Replacing images

Each writer records what it wrote and deletes only those names: the plugin in
`synced.json`, the SD writer in `sleep/.arena-sleep.json`. The firmware only
considers `.bmp` files (`SleepActivity.cpp:487`), so the manifest is ignored by it.
The SD writer also refuses to delete any name not matching `arena_NN.bmp`.

## 9. Keep the count modest

`selectRandomSleepFile` scans the folders and validates BMPs on every sleep
(`SleepActivity.cpp:508`). Default cap: 24.

## 10. What has and hasn't been tested

**Tested**

- `tests/test-classify.mjs`: classification, ordering, dedupe, fit and slug parsing.
- `tests/test-bmp.mjs` + `tests/verify-bmp.py`: X3 and X4 BMPs at both depths
  re-parsed independently, dither tone, CRC. ZIP output checked with Python's `zipfile`.
- `tools/probe-arena.mjs`: live API shape and cross-origin headers.
- Web app in a real browser against the live channel: load, render, remove, brightness,
  depth, order, 404 handling, and phone width.
- `writeToDirectory()` against the browser's origin-private file system, including
  keeping a hand-placed file.
- `plugin.js` against a fake host: dry run writes nothing, sync writes, a smaller
  sync prunes, `relay` and `fetchToSd` unused.

- On a real reader (2026-11-04): 2-bit images from the ZIP display and look good, by the owner's eye.

**Not tested**

- Whether the reader draws them directly, without building a rescale cache.
- The plugin on the reader itself, including loading `core.js` through `/plugin`.
- The folder picker dialog with a real SD card. Browsers can refuse some folders.
- Private channels and token auth. No token has been used yet.
- The `/api/fetch` fallback.
- Clicking **Download ZIP** in a browser. The ZIP builder itself is tested.

## 11. Open items

1. Check `/.crosspoint` for new `sleep_*.bmp` files, to confirm the direct draw path.
1. On the live site: test the `sleep` folder from the ZIP and the card writer, and **Send over Wi-Fi** on a real reader.
2. Add a channel picker from the user's account once token auth is verified.
3. If sharing widely: register an OAuth app (PKCE) so people can sign in rather than
   paste a token.
4. Optional: `api.registerAction('sync', …)` so `/plugins-run` can re-sync headlessly.
