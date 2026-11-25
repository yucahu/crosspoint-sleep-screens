# CrossPoint Sleep Screens

Turns the images in an [Are.na](https://www.are.na) channel into screen-sized,
dithered sleep screens for Xteink e-readers running
[CrossPoint](https://github.com/crosspoint-reader/crosspoint-reader) firmware.
All the work happens in your browser, and there is no server.

**[Try it: yucahu.github.io/crosspoint-sleep-screens](https://yucahu.github.io/crosspoint-sleep-screens/)**

**Status:** saving to an SD card or a ZIP is in daily use on a reader. Sending over
Wi-Fi worked on an X4 Pro from the live site in Chrome, but has only been tried a few
times, so it's still marked experimental. The reader plugin hasn't been tested on a
device yet.

## How to use it

1. Open the app and paste a public Are.na channel URL.
2. Remove any images you don't want. Click an image to crop it, move or resize it on
   the screen, invert it, change its brightness, or give it a black or white
   background. Edits last until you close the page.
3. Get them onto the reader's SD card, using any of these:
   - **Save to SD card** (Chrome or Edge): put the card in your computer, click,
     and choose the card. On an X4 Pro, USB Drive mode works too.
   - **Download ZIP** (any browser): open it and drag the `sleep` folder onto the
     card.
   - **Send over Wi-Fi** (Chrome, experimental): turn off any VPN, start File
     Transfer on the reader, then click send and allow local network access when
     Chrome asks.
4. On the reader, set **Settings → Display → Sleep Screen** to **Custom**.

The files go in a folder named `sleep` at the top of the card:

```
SD card
└── sleep
    ├── arena_01.bmp
    ├── arena_02.bmp
    └── …
```

A file named `sleep.bmp` at the top of the card replaces these, so remove it if you
have one. The reader also reads a folder named `.sleep`. If you've used one before,
clear out old images there too, or they'll keep appearing.

## Requirements

- An Xteink X4 or X3 running CrossPoint. For other CrossPoint devices, enter the
  screen size by hand.
- Chrome or Edge to save straight to the card, or any modern browser for the ZIP.

## Run it on your own computer

You need [Node.js](https://nodejs.org) 18 or newer. There are no dependencies to
install.

```bash
git clone https://github.com/yucahu/crosspoint-sleep-screens.git
```

```bash
cd crosspoint-sleep-screens
```

```bash
node tools/serve.mjs
```

Then open <http://localhost:8787/web/>.

## Host your own copy

It's a static site, so any host works. On GitHub: **Settings → Pages**, set
**Source** to **Deploy from a branch**, and choose `main` and `/ (root)`. The
root `index.html` sends visitors to `web/`.

## Reader plugin (experimental)

A version that runs inside the reader's own web interface, writing over Wi-Fi.
Copy `manifest.json`, `plugin.js` and `core.js` to the card as
`/.crosspoint/plugins/crosspoint-sleep-screens/`, `/plugins/crosspoint-sleep-screens/` or
`/.plugins/crosspoint-sleep-screens/`, and turn on **Settings → Connectivity → Plugins**. Start
File Transfer, open `http://crosspoint.local/plugins`, find the **CrossPoint Sleep
Screens** card, and press **Dry run** before **Sync to /sleep**.

The reader and your browser both need internet access, so this won't work while the
reader is running its own hotspot.

## Private channels

Public channels don't need anything. Private ones need a personal access token
from [are.na/settings/personal-access-tokens](https://www.are.na/settings/personal-access-tokens).

- The web app sends it only to `api.are.na`, and keeps it only if you tick
  **Remember in this browser**.
- The plugin never saves it, because anyone on your network can read files in the
  plugin folder through the reader's `/plugin` endpoint.

## What gets skipped

By default only uploaded images are used. Everything else is listed with a reason:

- text blocks and nested channels
- link and video thumbnails that Are.na generated
- PDFs, zips and audio, whose preview image is not the content
- SVGs
- images under 400px on their short side
- a second copy of the same file

Checkboxes let the link, file-preview and SVG groups back in.

## Replacing images

**Save to SD card**, **Send over Wi-Fi** and the plugin all remove the images they
added last time, then add the new set. Images you added to the folder yourself are
left alone, and so is anything in a `.sleep` folder. The reader shows all of them, and
the app tells you after each save how many other images are still there. A ZIP can't
remove anything, so if the new set is smaller, delete the old `arena_*.bmp` files
first.

Keep the count low. The reader checks every image in the folder each time it sleeps,
so a few dozen is comfortable and hundreds will be slower. The default is 24.

## Depth

**2-bit** gives four greys and matches what the firmware writes for its own covers.
It's a CrossPoint extension, so your computer may say it can't open these files.
That's normal. **1-bit** is pure black and white and opens anywhere.

## Checks

```bash
node tests/test-classify.mjs
```

```bash
node tests/test-bmp.mjs
```

```bash
python tests/verify-bmp.py "tests/out/out_*.bmp"
```

```bash
node tools/probe-arena.mjs https://are.na/enzo/real-3bs49wxggr4
```

The probe runs the real classifier against a live channel and reports cross-origin
access and your rate-limit tier. Set `ARENA_TOKEN` to test with a token.

## Using Are.na content

The tool fetches a capped set of images when you ask it to and keeps them on your
device. It's not a crawler, and it shouldn't be run as one: Are.na's API policy
prohibits scraping and systematic downloading. Images belong to the people who
uploaded them.

Not affiliated with Are.na, Xteink or the CrossPoint project.
