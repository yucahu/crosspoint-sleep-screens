// CrossPoint Sleep Screens - shared core.
//
// One classic script used by three callers: the web app (web/app.js), the
// CrossPoint plugin (plugin.js) and the terminal tools/tests. No dependencies.
// Everything except rasterize() also runs under Node.
//
// Are.na access uses API v3 directly. api.are.na and both image hosts send
// Access-Control-Allow-Origin: *, so no proxy is needed and a token never
// leaves the browser it was typed into.

(function (root) {
  'use strict';

  var API = 'https://api.are.na/v3';

  // Sleep screens are drawn in portrait: SleepActivity forces
  // Orientation::Portrait and only skips its rescale cache when the BMP matches
  // getScreenWidth() x getScreenHeight() (SleepActivity.cpp:765). So the sizes
  // here are the panel's dimensions turned on end.
  var PANELS = {
    X4: { w: 480, h: 800, label: 'X4 family (480 x 800)' },
    X3: { w: 528, h: 792, label: 'X3 (528 x 792)' },
    CUSTOM: { w: 480, h: 800, label: 'Custom size' }
  };

  var SYNC_PREFIX = 'arena_';
  // Kept from the project's first name, so cards synced before the rename still
  // get their old images cleaned up. Ignored by the firmware: not a .bmp.
  var MANIFEST = '.arena-sleep.json';

  // The firmware reads /.sleep first and /sleep as a fallback (USER_GUIDE 3.7).
  // /sleep is used because a dot folder is hidden on macOS after unzipping, and
  // the reader's web server refuses names starting with "."
  // (CrossPointWebServer.cpp:917).
  var SLEEP_DIR = 'sleep';
  var OWN_FILE = /^arena_\d+\.bmp$/;
  var PER_PAGE = 100;                   // the API maximum
  var MAX_BLOCKS = 1000;                // guard against a runaway channel

  var DEFAULTS = {
    channel: '',
    panel: 'X4',
    width: 480,
    height: 800,
    fit: 'auto',
    bpp: 2,
    gamma: 1,
    order: 'newest',
    maxImages: 24,
    minSourcePx: 400,
    includeLinkThumbs: false,
    includeAttachmentPreviews: false,
    allowSvg: false,
    invert: false
  };

  // --- channel input -------------------------------------------------------
  // Slug from a full URL, a "user/slug" pair, or a bare slug.
  function parseChannel(input) {
    var s = String(input || '').trim();
    if (!s) return '';
    var m = s.match(/are\.na\/[^/]+\/([^/?#]+)/i);
    if (m) return m[1];
    var parts = s.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '').split('/');
    return parts[parts.length - 1];
  }

  // --- API ------------------------------------------------------------------
  function friendlyStatus(status, slug, retryAfter) {
    if (status === 401) return 'Are.na rejected that access token (HTTP 401).';
    if (status === 403) return 'No access to "' + slug + '" (HTTP 403). A private channel needs a token from an account that can see it.';
    if (status === 404) return 'Channel "' + slug + '" was not found (HTTP 404). A private channel also looks like this without a token.';
    if (status === 429) return 'Rate limited by Are.na (HTTP 429). Try again in ' + (retryAfter || 60) + ' seconds.';
    return 'Are.na returned HTTP ' + status + '.';
  }

  async function apiGet(path, slug, opts) {
    var headers = { Accept: 'application/json' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    var fetchFn = opts.fetch || root.fetch.bind(root);
    var res = await fetchFn(API + path, { headers: headers });
    if (opts.onRate) {
      opts.onRate({
        tier: res.headers.get('x-ratelimit-tier'),
        limit: Number(res.headers.get('x-ratelimit-limit')) || null,
        remaining: Number(res.headers.get('x-ratelimit-remaining'))
      });
    }
    if (!res.ok) throw new Error(friendlyStatus(res.status, slug, res.headers.get('retry-after')));
    return res.json();
  }

  // Returns { channel, blocks }. `sort` is always explicit because the API's
  // documented default disagrees with itself (position_asc vs position_desc).
  async function fetchChannel(slug, opts) {
    opts = opts || {};
    var sort = opts.sort || 'position_desc';
    var e = encodeURIComponent(slug);
    var channel = await apiGet('/channels/' + e, slug, opts);
    var blocks = [];
    for (var page = 1; ; page++) {
      var data = await apiGet('/channels/' + e + '/contents?per=' + PER_PAGE + '&page=' + page +
        '&sort=' + sort, slug, opts);
      blocks = blocks.concat(data.data || []);
      if (opts.onProgress) opts.onProgress(blocks.length, data.meta && data.meta.total_count);
      if (!data.meta || !data.meta.has_more_pages || blocks.length >= MAX_BLOCKS) break;
    }
    return { channel: channel, blocks: blocks };
  }

  // --- block classification --------------------------------------------------
  // Returns { ok, reason, label, type, ... }. Every rejection carries a reason so
  // a mixed channel can be audited before anything is written.
  //
  // Field paths are from live v3 responses. Image dimensions come with the block,
  // so the favicon guard runs here rather than after a download.
  function classify(b, cfg) {
    cfg = cfg || DEFAULTS;
    if (!b) return { ok: false, reason: 'empty block', label: 'empty', type: 'Unknown' };
    var type = b.type || 'Unknown';
    var label = b.title || (b.image && b.image.filename) || ('block ' + b.id);
    function no(reason) { return { ok: false, reason: reason, label: label, type: type, id: b.id }; }

    if (type === 'Text') return no('text block');
    if (type === 'Channel') return no('nested channel');
    if (b.state && b.state !== 'available') return no('still processing on Are.na (' + b.state + ')');

    var img = b.image;
    if (!img) return no('no image data (' + type + ' block)');

    var ct = img.content_type || '';
    if (!/^image\//i.test(ct)) return no('image content_type is "' + (ct || 'missing') + '"');
    if (/svg/i.test(ct) && !cfg.allowSvg) return no('SVG');

    // Are.na synthesises a thumbnail for Link and Embed blocks (an og:image or a
    // video poster). Usually not what you want on a sleep screen.
    if ((type === 'Link' || type === 'Embed') && !cfg.includeLinkThumbs) {
      return no(type.toLowerCase() + ' thumbnail, not an uploaded image');
    }

    // An Attachment (PDF, zip, audio) can carry a generated preview image.
    if (type === 'Attachment') {
      var act = (b.attachment && b.attachment.content_type) || '';
      if (!/^image\//i.test(act) && !cfg.includeAttachmentPreviews) {
        return no('attachment is ' + (act || 'not an image') + ', preview only');
      }
    }

    if (img.width && img.height && Math.min(img.width, img.height) < cfg.minSourcePx) {
      return no('only ' + img.width + ' x ' + img.height + ' (under ' + cfg.minSourcePx + 'px)');
    }

    // `medium` is at most 1200px on its long side, already more than any panel
    // needs, and a fraction of the original's bytes.
    var url = (img.medium && img.medium.src) || (img.large && img.large.src) || img.src;
    if (!url) return no('no usable image URL');

    return {
      ok: true, id: b.id, label: label, type: type, ct: ct, url: url,
      thumb: (img.small && img.small.src) || url,
      width: img.width || null, height: img.height || null
    };
  }

  // Splits blocks into { kept, skipped } and applies the order.
  function selectBlocks(blocks, cfg, rand) {
    var kept = [], skipped = [], seen = {};
    blocks.forEach(function (b) {
      var c = classify(b, cfg);
      // The same file can be connected to a channel more than once. Are.na's
      // filenames are content hashes, so they identify it.
      if (c.ok) {
        var key = (b.image && b.image.filename) || c.url;
        if (seen[key]) c = { ok: false, reason: 'duplicate of an image already included', label: c.label, type: c.type, id: c.id };
        else seen[key] = true;
      }
      (c.ok ? kept : skipped).push(c);
    });
    if (cfg.order === 'random') {
      var r = rand || Math.random;
      for (var i = kept.length - 1; i > 0; i--) {
        var j = Math.floor(r() * (i + 1));
        var t = kept[i]; kept[i] = kept[j]; kept[j] = t;
      }
    }
    return { kept: kept, skipped: skipped };
  }

  function sortFor(order) { return order === 'oldest' ? 'position_asc' : 'position_desc'; }

  function panelSize(cfg) {
    if (cfg.panel === 'CUSTOM') return { w: Number(cfg.width) || 480, h: Number(cfg.height) || 800 };
    return PANELS[cfg.panel] || PANELS.X4;
  }

  // --- fit ------------------------------------------------------------------
  // 'auto' crops when that loses at most 30% of the image, otherwise fits the
  // whole thing. A wide screenshot cropped to a portrait panel is unreadable.
  function resolveFit(fit, sw, sh, w, h) {
    if (fit !== 'auto') return fit;
    var ratio = (sw / sh) / (w / h);
    var keep = ratio > 1 ? 1 / ratio : ratio;
    return keep >= 0.7 ? 'cover' : 'contain';
  }

  function placement(sw, sh, w, h, fit) {
    var f = resolveFit(fit, sw, sh, w, h);
    var scale = f === 'cover' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh);
    var dw = Math.round(sw * scale), dh = Math.round(sh * scale);
    return { fit: f, x: Math.round((w - dw) / 2), y: Math.round((h - dh) / 2), w: dw, h: dh };
  }

  // --- pixels ----------------------------------------------------------------
  // Float32 so Atkinson's small error terms are kept. Truncating them to integers
  // throws away most of the error in smooth areas and bands the gradients.
  function toGray(rgba, cfg) {
    var n = rgba.length / 4, gray = new Float32Array(n);
    var gamma = Number(cfg.gamma) || 1, table = null;
    if (gamma !== 1) {
      table = new Float32Array(256);
      for (var t = 0; t < 256; t++) table[t] = 255 * Math.pow(t / 255, 1 / gamma);
    }
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var v = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      if (table) v = table[Math.round(v)];
      gray[i] = cfg.invert ? 255 - v : v;
    }
    return gray;
  }

  // Browser only. `source` is an ImageBitmap. Transparency lands on white.
  function rasterize(source, w, h, cfg) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    var pos = placement(source.width, source.height, w, h, cfg.fit);
    g.drawImage(source, pos.x, pos.y, pos.w, pos.h);
    return { gray: toGray(g.getImageData(0, 0, w, h).data, cfg), fit: pos.fit };
  }

  // --- per-image edits (web app) -------------------------------------------
  // Each screen is a fixed w x h canvas filled with `bg`, with the image on top.
  //   crop:   the part of the source used, as fractions of its width and height
  //   dest:   where the cropped image sits, as fractions of the screen: x, y of
  //           its top-left corner and w of its width. Its height follows from the
  //           crop's shape, so it is never stretched. null means "place it by
  //           the Fit setting", until the image is moved or resized by hand.
  //   bg:     'white' or 'black'
  //   invert: inverts the image only, never the background
  //   gamma:  brightness of the image, 1 is neutral, higher is lighter
  function defaultEdit() {
    return { crop: { x: 0, y: 0, w: 1, h: 1 }, dest: null, bg: 'white', invert: false, gamma: 1 };
  }

  // Source rectangle (pixels) and screen rectangle (pixels) for an edit.
  function layout(sw, sh, w, h, edit, fit) {
    var c = edit.crop;
    var sx = c.x * sw, sy = c.y * sh, cw = c.w * sw, ch = c.h * sh;
    var d = edit.dest, dx, dy, dw, dh, f = 'custom';
    if (d) {
      dw = d.w * w; dh = dw * ch / cw; dx = d.x * w; dy = d.y * h;
    } else {
      var p = placement(cw, ch, w, h, fit);
      dx = p.x; dy = p.y; dw = p.w; dh = p.h; f = p.fit;
    }
    return { sx: sx, sy: sy, sw: cw, sh: ch, dx: dx, dy: dy, dw: dw, dh: dh, fit: f };
  }

  // Greys from RGBA drawn on a transparent canvas: inverts and brightens the
  // image, then lays it over the background by its alpha. Pure, so testable.
  function composeGray(rgba, edit) {
    var n = rgba.length / 4, gray = new Float32Array(n);
    var bg = edit.bg === 'black' ? 0 : 255;
    var gamma = Number(edit.gamma) || 1, table = null;
    if (gamma !== 1) {
      table = new Float32Array(256);
      for (var t = 0; t < 256; t++) table[t] = 255 * Math.pow(t / 255, 1 / gamma);
    }
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var a = rgba[p + 3] / 255;
      if (a === 0) { gray[i] = bg; continue; }
      var v = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      if (edit.invert) v = 255 - v;
      if (table) v = table[Math.round(v)];
      gray[i] = a * v + (1 - a) * bg;
    }
    return gray;
  }

  // Browser only. `source` is an ImageBitmap.
  function compose(source, w, h, edit, fit) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    var L = layout(source.width, source.height, w, h, edit, fit);
    if (L.sw > 0 && L.sh > 0 && L.dw > 0 && L.dh > 0) {
      g.drawImage(source, L.sx, L.sy, L.sw, L.sh, L.dx, L.dy, L.dw, L.dh);
    }
    return { gray: composeGray(g.getImageData(0, 0, w, h).data, edit), fit: L.fit };
  }

  // Atkinson: 1/8 of the error to six neighbours, the rest discarded. The same
  // family the firmware's converters use (USE_ATKINSON). Modifies `gray`.
  function dither(gray, w, h, levels) {
    var out = new Uint8Array(w * h);
    var step = 255 / (levels - 1);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var old = gray[i];
        if (old < 0) old = 0; else if (old > 255) old = 255;
        var lvl = Math.round(old / step);
        out[i] = lvl;
        var err = (old - lvl * step) / 8;
        if (x + 1 < w) gray[i + 1] += err;
        if (x + 2 < w) gray[i + 2] += err;
        if (y + 1 < h) {
          if (x > 0) gray[i + w - 1] += err;
          gray[i + w] += err;
          if (x + 1 < w) gray[i + w + 1] += err;
        }
        if (y + 2 < h) gray[i + 2 * w] += err;
      }
    }
    return out;
  }

  // Top-down (negative biHeight), BI_RGB, greyscale palette, MSB-first pixels.
  // Mirrors the firmware's own covers (BmpViewerActivity.cpp:355-372).
  function encodeBmp(levels, w, h, bpp) {
    var palette = bpp === 1 ? [0, 255] : [0, 85, 170, 255];
    var stride = ((w * bpp + 31) >> 5) << 2;
    var offBits = 14 + 40 + palette.length * 4;
    var size = offBits + stride * h;
    var buf = new ArrayBuffer(size);
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4d);        // "BM"
    dv.setUint32(2, size, true);
    dv.setUint32(10, offBits, true);
    dv.setUint32(14, 40, true);                        // BITMAPINFOHEADER
    dv.setInt32(18, w, true);
    dv.setInt32(22, -h, true);                         // negative = top-down
    dv.setUint16(26, 1, true);                         // planes
    dv.setUint16(28, bpp, true);
    dv.setUint32(30, 0, true);                         // BI_RGB
    dv.setUint32(34, stride * h, true);
    dv.setUint32(46, palette.length, true);            // biClrUsed
    dv.setUint32(50, palette.length, true);            // biClrImportant
    for (var p = 0; p < palette.length; p++) {
      var o = 14 + 40 + p * 4;
      u8[o] = u8[o + 1] = u8[o + 2] = palette[p];      // B, G, R
    }

    var perByte = 8 / bpp, mask = (1 << bpp) - 1;
    for (var y = 0; y < h; y++) {
      var row = offBits + y * stride;
      for (var x = 0; x < w; x++) {
        var byte = row + ((x / perByte) | 0);
        var shift = 8 - bpp - (x % perByte) * bpp;
        u8[byte] |= (levels[y * w + x] & mask) << shift;
      }
    }
    return u8;
  }

  function fileName(index) {
    return SYNC_PREFIX + String(index + 1).padStart(2, '0') + '.bmp';
  }

  function b64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  // --- zip ------------------------------------------------------------------
  // Store-only: dithered BMPs barely compress, so a real deflate earns nothing.
  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  // files: [{ path, bytes }]. Returns a Uint8Array.
  function makeZip(files) {
    var enc = new TextEncoder();
    var entries = files.map(function (f) {
      return { name: enc.encode(f.path), bytes: f.bytes, crc: crc32(f.bytes) };
    });
    var total = 22;
    entries.forEach(function (e) { total += 30 + 46 + 2 * e.name.length + e.bytes.length; });
    var out = new Uint8Array(total), dv = new DataView(out.buffer), at = 0;
    var UTF8 = 0x0800;

    entries.forEach(function (e) {
      e.offset = at;
      dv.setUint32(at, 0x04034b50, true);
      dv.setUint16(at + 4, 20, true);
      dv.setUint16(at + 6, UTF8, true);
      dv.setUint32(at + 14, e.crc, true);
      dv.setUint32(at + 18, e.bytes.length, true);
      dv.setUint32(at + 22, e.bytes.length, true);
      dv.setUint16(at + 26, e.name.length, true);
      out.set(e.name, at + 30);
      out.set(e.bytes, at + 30 + e.name.length);
      at += 30 + e.name.length + e.bytes.length;
    });

    var cdStart = at;
    entries.forEach(function (e) {
      dv.setUint32(at, 0x02014b50, true);
      dv.setUint16(at + 4, 20, true);
      dv.setUint16(at + 6, 20, true);
      dv.setUint16(at + 8, UTF8, true);
      dv.setUint32(at + 16, e.crc, true);
      dv.setUint32(at + 20, e.bytes.length, true);
      dv.setUint32(at + 24, e.bytes.length, true);
      dv.setUint16(at + 28, e.name.length, true);
      dv.setUint32(at + 42, e.offset, true);
      out.set(e.name, at + 46);
      at += 46 + e.name.length;
    });

    dv.setUint32(at, 0x06054b50, true);
    dv.setUint16(at + 8, entries.length, true);
    dv.setUint16(at + 10, entries.length, true);
    dv.setUint32(at + 12, at - cdStart, true);
    dv.setUint32(at + 16, cdStart, true);
    return out;
  }

  // --- write to a mounted SD card (File System Access API) -------------------
  // `dir` is the card root or its sleep folder. Deletes only what the previous
  // write recorded in its manifest, so hand-placed images survive.
  async function writeToDirectory(dir, files, info) {
    var sleep = (dir.name === SLEEP_DIR || dir.name === '.sleep') ? dir
      : await dir.getDirectoryHandle(SLEEP_DIR, { create: true });

    var previous = [];
    try {
      var mf = await (await sleep.getFileHandle(MANIFEST)).getFile();
      var parsed = JSON.parse(await mf.text());
      if (Array.isArray(parsed.files)) previous = parsed.files;
    } catch (e) { /* first write: no manifest yet */ }

    async function put(name, bytes) {
      var h = await sleep.getFileHandle(name, { create: true });
      var w = await h.createWritable();
      await w.write(bytes);
      await w.close();
    }

    var names = files.map(function (f) { return f.name; });
    for (var i = 0; i < files.length; i++) await put(files[i].name, files[i].bytes);

    var removed = 0;
    for (var j = 0; j < previous.length; j++) {
      var old = previous[j];
      // The pattern check stops an edited manifest reaching other files.
      if (names.indexOf(old) !== -1 || !OWN_FILE.test(old)) continue;
      try { await sleep.removeEntry(old); removed++; } catch (e) { /* already gone */ }
    }

    var manifest = Object.assign({ at: new Date().toISOString(), files: names }, info || {});
    await put(MANIFEST, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));

    // What else the reader will show, so the result can say so plainly.
    var others = 0, legacy = 0;
    for await (var entry of sleep.keys()) {
      if (isBmp(entry) && names.indexOf(entry) === -1) others++;
    }
    if (sleep !== dir) {
      try {
        var dot = await dir.getDirectoryHandle('.sleep');
        for await (var e2 of dot.keys()) if (isBmp(e2)) legacy++;
      } catch (e) { /* no .sleep folder */ }
    }
    return { written: names.length, removed: removed, others: others, legacy: legacy };
  }

  function isBmp(name) { return /\.bmp$/i.test(name); }

  // --- send to the reader over Wi-Fi ----------------------------------------
  // Uses the reader's own file-transfer endpoints. The reader is plain HTTP, so
  // from an HTTPS page this relies on Chrome's Local Network Access exception for
  // .local names and private IPs, after the user allows it. Experimental.
  function readerBase(host) {
    var h = String(host || '').trim().replace(/\/+$/, '');
    if (!h) h = 'crosspoint.local';
    return /^https?:\/\//i.test(h) ? h : 'http://' + h;
  }

  async function sendToReader(host, files, opts) {
    opts = opts || {};
    var base = readerBase(host);
    var fetchFn = opts.fetch || root.fetch.bind(root);
    var dir = '/' + SLEEP_DIR;
    function call(path, init) {
      init = init || {};
      init.targetAddressSpace = 'local';   // ignored by browsers without it
      return fetchFn(base + path, init);
    }
    function form(fields) {
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString()
      };
    }

    // Also the reachability check, so it runs first.
    var listing = await call('/api/files?path=' + encodeURIComponent('/'));
    if (!listing.ok) throw new Error('the reader answered HTTP ' + listing.status);
    var top = await listing.json();
    var hasDir = Array.isArray(top) && top.some(function (f) { return f.isDirectory && f.name === SLEEP_DIR; });
    if (!hasDir) {
      var mk = await call('/mkdir', form({ name: SLEEP_DIR, path: '/' }));
      if (!mk.ok) throw new Error('could not create the sleep folder (HTTP ' + mk.status + ')');
    }

    var existing = [];
    var r = await call('/api/files?path=' + encodeURIComponent(dir));
    if (r.ok) existing = (await r.json()).map(function (f) { return f.name; });

    var names = files.map(function (f) { return f.name; });
    for (var i = 0; i < files.length; i++) {
      if (opts.onProgress) opts.onProgress(i + 1, files.length);
      var fd = new FormData();
      fd.append('file', new Blob([files[i].bytes], { type: 'image/bmp' }), files[i].name);
      var up = await call('/upload?path=' + encodeURIComponent(dir) + '&overwrite=1', { method: 'POST', body: fd });
      if (!up.ok) throw new Error(files[i].name + ': ' + ((await up.text()) || 'HTTP ' + up.status));
    }

    // Only names this tool writes, left over from a larger earlier set.
    var stale = existing.filter(function (n) { return OWN_FILE.test(n) && names.indexOf(n) === -1; })
      .map(function (n) { return dir + '/' + n; });
    if (stale.length) {
      var del = await call('/delete', form({ paths: JSON.stringify(stale) }));
      if (!del.ok) throw new Error('uploaded, but could not remove old images (HTTP ' + del.status + ')');
    }

    // What else the reader will show. The web server may refuse to list a dot
    // folder, in which case legacy stays null (unknown).
    var others = existing.filter(function (n) { return isBmp(n) && !OWN_FILE.test(n); }).length;
    var legacy = null;
    try {
      var lr = await call('/api/files?path=' + encodeURIComponent('/.sleep'));
      if (lr.ok) legacy = (await lr.json()).filter(function (f) { return !f.isDirectory && isBmp(f.name); }).length;
    } catch (e) { /* unknown */ }
    return { written: names.length, removed: stale.length, others: others, legacy: legacy };
  }

  root.SleepScreensCore = {
    API: API, PANELS: PANELS, DEFAULTS: DEFAULTS, SYNC_PREFIX: SYNC_PREFIX, MANIFEST: MANIFEST,
    SLEEP_DIR: SLEEP_DIR, readerBase: readerBase, sendToReader: sendToReader,
    parseChannel: parseChannel, fetchChannel: fetchChannel, classify: classify,
    selectBlocks: selectBlocks, sortFor: sortFor, panelSize: panelSize,
    resolveFit: resolveFit, placement: placement, toGray: toGray, rasterize: rasterize,
    defaultEdit: defaultEdit, layout: layout, composeGray: composeGray, compose: compose,
    dither: dither, encodeBmp: encodeBmp, fileName: fileName, b64: b64,
    crc32: crc32, makeZip: makeZip, writeToDirectory: writeToDirectory
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
