// CrossPoint Sleep Screens - web app. Static: all logic is in ../core.js and here.
(function () {
  'use strict';

  var C = window.SleepScreensCore;
  var SETTINGS_KEY = 'crosspoint-sleep-screens.settings';
  var TOKEN_KEY = 'crosspoint-sleep-screens.token';
  var HOST_KEY = 'crosspoint-sleep-screens.reader';
  var OLD_PREFIX = 'arena-sleep.';   // the project's first name

  var $ = function (id) { return document.getElementById(id); };
  var cfg = Object.assign({}, C.DEFAULTS);

  var state = {
    blocks: null,        // raw blocks from the last load
    channelTitle: '',
    order: null,         // the order the blocks were fetched in
    selection: { kept: [], skipped: [] },
    dropped: {},         // block id -> true, removed by hand this session
    results: [],         // { item, name, bytes } per rendered image, in order
    items: [],           // the images on screen, in order
    cards: [],           // { fig, canvas, cap } per image
    edits: {},           // block id -> edit made in the editor; kept for this page only
    editsSlug: '',       // the channel those edits belong to
    rendering: false,
    generation: 0        // bumped to abandon a render in progress
  };
  var bitmaps = new Map();   // url -> Promise<ImageBitmap>

  // --- storage: per-browser convenience only, so failures are ignored -------
  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* private window or blocked storage */ }
  }
  // Falls back to the key used before the rename, so saved settings carry over.
  function recall(key) {
    try {
      var v = localStorage.getItem(key);
      return v !== null ? v : localStorage.getItem(OLD_PREFIX + key.split('.').pop());
    } catch (e) { return null; }
  }
  function saveSettings() { store(SETTINGS_KEY, JSON.stringify(cfg)); }

  // --- status ----------------------------------------------------------------
  function setStatus(msg, isError) {
    var s = $('status');
    s.textContent = msg || '';
    s.classList.toggle('err', !!isError);
  }
  // kind: true for an error, 'info' for progress, anything else for success.
  function setDone(msg, kind) {
    var d = $('done');
    d.hidden = !msg;
    d.textContent = msg || '';
    d.classList.toggle('err', kind === true);
    d.classList.toggle('info', kind === 'info');
  }
  function showRate(r) {
    if (!r.limit) return;
    $('rate').textContent = 'Are.na tier: ' + (r.tier || 'unknown') + ', ' + r.remaining + ' of ' + r.limit + ' requests left this minute.';
  }

  // --- controls ---------------------------------------------------------------
  var RENDER_KEYS = ['panel', 'width', 'height', 'fit', 'bpp'];
  var SELECT_KEYS = ['maxImages', 'minSourcePx', 'includeLinkThumbs', 'includeAttachmentPreviews', 'allowSvg'];

  function initControls() {
    var panel = $('panel');
    Object.keys(C.PANELS).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = C.PANELS[k].label;
      panel.appendChild(o);
    });

    var raw = recall(SETTINGS_KEY);
    if (raw) { try { Object.assign(cfg, JSON.parse(raw)); } catch (e) { /* ignore */ } }

    RENDER_KEYS.concat(SELECT_KEYS, ['order']).forEach(function (k) {
      var n = $(k);
      if (n.type === 'checkbox') n.checked = !!cfg[k]; else n.value = String(cfg[k]);
      n.addEventListener(n.type === 'range' ? 'input' : 'change', function () {
        cfg[k] = n.type === 'checkbox' ? n.checked : (n.type === 'number' || n.type === 'range' || k === 'bpp') ? Number(n.value) : n.value;
        saveSettings();
        syncControls();
        if (!state.blocks) return;
        if (k === 'order') loadChannel();
        else if (SELECT_KEYS.indexOf(k) !== -1) { reselect(); render(); }
        else render();
      });
    });

    $('channel').value = cfg.channel || '';
    var savedToken = recall(TOKEN_KEY);
    if (savedToken) { $('token').value = savedToken; $('remember').checked = true; }
    function syncToken() { store(TOKEN_KEY, $('remember').checked && $('token').value ? $('token').value : null); }
    $('token').addEventListener('change', syncToken);
    $('remember').addEventListener('change', syncToken);

    // Without the File System Access API the card option can't work, so the ZIP
    // becomes the main choice.
    if (!window.showDirectoryPicker) {
      $('way-card').hidden = true;
      $('download').classList.add('primary');
    }
    $('reader-host').value = recall(HOST_KEY) || '';
    $('reader-host').addEventListener('change', function () { store(HOST_KEY, $('reader-host').value.trim() || null); });
    syncControls();
  }

  function syncControls() {
    $('custom-size').hidden = cfg.panel !== 'CUSTOM';
  }

  function brightnessText(g) {
    return g === 1 ? '(neutral)' : g > 1 ? '(lighter, ' + g.toFixed(2) + ')' : '(darker, ' + g.toFixed(2) + ')';
  }

  // --- load -------------------------------------------------------------------
  async function loadChannel() {
    var slug = C.parseChannel($('channel').value);
    if (!slug) { setStatus('Enter an Are.na channel URL or slug first.', true); return; }

    cfg.channel = $('channel').value.trim();
    saveSettings();
    var gen = ++state.generation;
    $('load').disabled = true;
    setDone('');
    setStatus('Fetching "' + slug + '"…');

    try {
      var res = await C.fetchChannel(slug, {
        token: $('token').value.trim(),
        sort: C.sortFor(cfg.order),
        onRate: showRate,
        onProgress: function (n, total) { setStatus('Fetched ' + n + (total ? ' of ' + total : '') + ' blocks…'); }
      });
      if (gen !== state.generation) return;
      state.blocks = res.blocks;
      state.channelTitle = res.channel.title || slug;
      state.dropped = {};
      if (slug !== state.editsSlug) { state.edits = {}; state.editsSlug = slug; }
      reselect();
      await render();
    } catch (e) {
      if (gen !== state.generation) return;
      // fetch() reports a network or CORS failure as a bare TypeError.
      setStatus(e instanceof TypeError ? 'Could not reach Are.na. Check your connection and try again.' : e.message, true);
    } finally {
      $('load').disabled = false;
    }
  }

  function reselect() {
    state.selection = C.selectBlocks(state.blocks, cfg);
    drawSkipped();
  }

  function activeItems() {
    return state.selection.kept
      .filter(function (it) { return !state.dropped[it.id]; })
      .slice(0, Number(cfg.maxImages) || 1);
  }

  function drawSkipped() {
    var list = state.selection.skipped;
    var box = $('skipped-box');
    box.hidden = !list.length;
    $('skipped-title').textContent = list.length + ' block' + (list.length === 1 ? '' : 's') + ' skipped';
    $('skipped').replaceChildren.apply($('skipped'), list.map(function (s) {
      var li = document.createElement('li');
      li.textContent = s.label + ' ';
      var why = document.createElement('span');
      why.textContent = '(' + s.type + ') ' + s.reason;
      li.appendChild(why);
      return li;
    }));
  }

  // --- render ------------------------------------------------------------------
  function getBitmap(url) {
    if (!bitmaps.has(url)) {
      bitmaps.set(url, (async function () {
        var r = await fetch(url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return createImageBitmap(await r.blob());
      })().catch(function (e) { bitmaps.delete(url); throw e; }));
    }
    return bitmaps.get(url);
  }

  function drawLevels(canvas, levels, w, h, bpp) {
    canvas.width = w; canvas.height = h;
    var g = canvas.getContext('2d');
    var img = g.createImageData(w, h);
    var step = bpp === 1 ? 255 : 85;
    for (var i = 0; i < levels.length; i++) {
      var v = levels[i] * step, p = i * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }

  function editFor(item) { return state.edits[item.id] || C.defaultEdit(); }

  async function render() {
    var gen = ++state.generation;
    var items = activeItems();
    var size = C.panelSize(cfg);

    state.items = items;
    state.results = items.map(function (item) { return { item: item, name: null, bytes: null }; });
    state.rendering = true;
    setDone('');
    $('empty').hidden = true;
    updateExport(true);

    // One placeholder per image, so the grid keeps its shape while it fills.
    state.cards = items.map(function (item, idx) {
      var fig = document.createElement('figure');
      fig.className = 'card';
      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'open';
      open.setAttribute('aria-label', 'Edit ' + item.label);
      open.addEventListener('click', function () { openEditor(idx); });
      var canvas = document.createElement('canvas');
      canvas.className = 'screen';
      canvas.width = size.w; canvas.height = size.h;
      open.appendChild(canvas);
      var cap = document.createElement('figcaption');
      cap.textContent = item.label;
      var drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'drop';
      drop.textContent = 'Remove';
      drop.setAttribute('aria-label', 'Remove ' + item.label);
      drop.addEventListener('click', function () {
        state.dropped[item.id] = true;
        render();
      });
      fig.append(open, drop, cap);
      return { fig: fig, canvas: canvas, cap: cap };
    });
    $('grid').replaceChildren.apply($('grid'), state.cards.map(function (c) { return c.fig; }));

    var skippedCount = state.selection.skipped.length;
    var title = state.channelTitle;
    if (!items.length) {
      setStatus(title + ': no usable images' + (skippedCount ? ' (' + skippedCount + ' skipped).' : '.'), true);
      state.rendering = false;
      updateExport(false);
      return;
    }

    for (var i = 0; i < items.length; i++) {
      setStatus(title + ': rendering ' + (i + 1) + ' of ' + items.length + '…');
      await renderCard(i, gen);
      // Yield so the page stays responsive and a newer render can take over.
      await new Promise(function (res) { setTimeout(res, 0); });
      if (gen !== state.generation) return;
    }

    var failed = state.results.filter(function (x) { return !x.bytes; }).length;
    setStatus(title + ': ' + (items.length - failed) + ' ready' +
      (failed ? ', ' + failed + ' failed' : '') +
      (state.selection.kept.length > items.length ? ', ' + (state.selection.kept.length - items.length) + ' more available' : '') +
      (skippedCount ? ', ' + skippedCount + ' skipped.' : '.'));
    state.rendering = false;
    updateExport(false);
  }

  // Renders one image into its card and its BMP. Also used after editing.
  async function renderCard(i, gen) {
    var item = state.items[i], card = state.cards[i];
    var size = C.panelSize(cfg);
    var bpp = Number(cfg.bpp) === 1 ? 1 : 2;
    try {
      var bmp = await getBitmap(item.url);
      if (gen !== state.generation) return;
      var r = C.compose(bmp, size.w, size.h, editFor(item), cfg.fit);
      var levels = C.dither(r.gray, size.w, size.h, bpp === 1 ? 2 : 4);
      drawLevels(card.canvas, levels, size.w, size.h, bpp);
      state.results[i].bytes = C.encodeBmp(levels, size.w, size.h, bpp);
      card.fig.classList.remove('failed');
      card.fig.classList.toggle('edited', !!state.edits[item.id]);
      card.cap.textContent = item.label + (state.edits[item.id] ? ' · edited' : r.fit === 'contain' ? ' · whole image' : '');
    } catch (e) {
      if (gen !== state.generation) return;
      state.results[i].bytes = null;
      card.fig.classList.add('failed');
      card.cap.textContent = item.label + ': could not load this image, so it will be left out';
    }
  }

  // --- editor ------------------------------------------------------------------
  // Works on a copy of the image's edit, and stores it in state.edits as soon as
  // anything changes. The card is re-rendered when the editor closes.
  var ed = { index: -1, item: null, bmp: null, edit: null, size: null, frame: 0, drag: null };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function copyEdit(e) {
    return { crop: Object.assign({}, e.crop), dest: e.dest ? Object.assign({}, e.dest) : null, bg: e.bg, invert: e.invert, gamma: e.gamma };
  }
  function edLayout() { return C.layout(ed.bmp.width, ed.bmp.height, ed.size.w, ed.size.h, ed.edit, cfg.fit); }
  function commit() { state.edits[ed.item.id] = ed.edit; drawEditorSoon(); }

  // Pins the image where Fit put it, so moving or cropping starts from there.
  function ensureDest() {
    if (ed.edit.dest) return;
    var L = edLayout();
    ed.edit.dest = { x: L.dx / ed.size.w, y: L.dy / ed.size.h, w: L.dw / ed.size.w };
  }
  // Keeps at least a sliver of the image on screen, so it can't be lost.
  function clampDest() {
    var d = ed.edit.dest, W = ed.size.w, H = ed.size.h, L = edLayout(), m = 8;
    d.x = clamp(d.x * W, m - L.dw, W - m) / W;
    d.y = clamp(d.y * H, m - L.dh, H - m) / H;
  }
  // Width of the cropped image when it just fits the screen: Size 1.
  function containWidth() {
    var L = edLayout();
    return L.sw * Math.min(ed.size.w / L.sw, ed.size.h / L.sh);
  }
  function currentScale() { return edLayout().dw / containWidth(); }
  // Resizes about the image's centre, or puts it in the screen's centre.
  function setScale(s, recenter) {
    ensureDest();
    var L = edLayout(), W = ed.size.w, H = ed.size.h;
    var cx = recenter ? W / 2 : L.dx + L.dw / 2, cy = recenter ? H / 2 : L.dy + L.dh / 2;
    var dw = clamp(s, 0.1, 4) * containWidth(), dh = dw * L.sh / L.sw;
    ed.edit.dest = { x: (cx - dw / 2) / W, y: (cy - dh / 2) / H, w: dw / W };
    clampDest();
    commit();
  }

  async function openEditor(i) {
    var item = state.items[i];
    if (!item) return;
    var bmp;
    try { bmp = await getBitmap(item.url); } catch (e) { return; }
    ed.index = i; ed.item = item; ed.bmp = bmp;
    ed.size = C.panelSize(cfg);
    ed.edit = copyEdit(editFor(item));

    // The crop view only needs to be screen-sharp, so large sources are shrunk.
    var src = $('ed-source'), k = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    src.width = Math.max(1, Math.round(bmp.width * k));
    src.height = Math.max(1, Math.round(bmp.height * k));
    src.getContext('2d').drawImage(bmp, 0, 0, src.width, src.height);
    $('ed-crop').style.setProperty('--ar', String(bmp.width / bmp.height));
    $('ed-screen').style.setProperty('--ar', String(ed.size.w / ed.size.h));
    $('ed-preview').width = ed.size.w;
    $('ed-preview').height = ed.size.h;

    $('ed-title').textContent = item.label;
    $('ed-prev').disabled = i === 0;
    $('ed-next').disabled = i === state.items.length - 1;
    drawEditor();
    if (!$('editor').open) $('editor').showModal();
  }

  function leaveImage() {
    if (ed.index >= 0 && state.items[ed.index] === ed.item) {
      var i = ed.index;
      renderCard(i, state.generation).then(function () { if (!state.rendering) updateExport(false); });
    }
  }

  function drawEditorSoon() {
    if (ed.frame) return;
    ed.frame = requestAnimationFrame(function () { ed.frame = 0; drawEditor(); });
  }

  function drawEditor() {
    if (!ed.bmp) return;
    var W = ed.size.w, H = ed.size.h, e = ed.edit;
    var bpp = Number(cfg.bpp) === 1 ? 1 : 2;
    var r = C.compose(ed.bmp, W, H, e, cfg.fit);
    drawLevels($('ed-preview'), C.dither(r.gray, W, H, bpp === 1 ? 2 : 4), W, H, bpp);

    var box = $('ed-cropbox').style, c = e.crop;
    box.left = c.x * 100 + '%'; box.top = c.y * 100 + '%';
    box.width = c.w * 100 + '%'; box.height = c.h * 100 + '%';

    var L = edLayout(), pb = $('ed-placebox').style;
    pb.left = L.dx / W * 100 + '%'; pb.top = L.dy / H * 100 + '%';
    pb.width = L.dw / W * 100 + '%'; pb.height = L.dh / H * 100 + '%';

    var s = currentScale();
    $('ed-scale').value = String(s);
    $('ed-scale-out').textContent = '(' + Math.round(s * 100) + '%)';
    document.querySelectorAll('input[name="ed-bg"]').forEach(function (n) { n.checked = n.value === e.bg; });
    $('ed-invert').checked = !!e.invert;
    $('ed-gamma').value = String(e.gamma);
    $('ed-gamma-out').textContent = brightnessText(Number(e.gamma));
  }

  // Crop handles. Resizing trims the image where it stands on the screen;
  // dragging the box pans the image inside its frame.
  function cropFrom(start, h, dx, dy) {
    var c = Object.assign({}, start), min = 0.02;
    if (h === 'move') {
      c.x = clamp(c.x + dx, 0, 1 - c.w);
      c.y = clamp(c.y + dy, 0, 1 - c.h);
      return c;
    }
    if (h.indexOf('w') !== -1) { var nx = clamp(c.x + dx, 0, c.x + c.w - min); c.w += c.x - nx; c.x = nx; }
    if (h.indexOf('e') !== -1) c.w = clamp(c.w + dx, min, 1 - c.x);
    if (h.indexOf('n') !== -1) { var ny = clamp(c.y + dy, 0, c.y + c.h - min); c.h += c.y - ny; c.y = ny; }
    if (h.indexOf('s') !== -1) c.h = clamp(c.h + dy, min, 1 - c.y);
    return c;
  }

  function applyCrop(start, c, h) {
    ed.edit.crop = c;
    var d = start.dest;
    if (h === 'move') {
      ed.edit.dest = Object.assign({}, d);
    } else {
      // Screen pixels per source pixel stays the same, so the kept part of the
      // image doesn't move or change size.
      var k = start.k, sw = ed.bmp.width, sh = ed.bmp.height, W = ed.size.w, H = ed.size.h;
      ed.edit.dest = {
        x: d.x + (c.x - start.crop.x) * sw * k / W,
        y: d.y + (c.y - start.crop.y) * sh * k / H,
        w: c.w * sw * k / W
      };
    }
    commit();
  }

  function cropStart() {
    ensureDest();
    var L = edLayout();
    return { crop: Object.assign({}, ed.edit.crop), dest: Object.assign({}, ed.edit.dest), k: L.dw / L.sw };
  }

  function initEditor() {
    var dlg = $('editor'), cropbox = $('ed-cropbox'), screen = $('ed-screen');

    cropbox.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      cropbox.setPointerCapture(ev.pointerId);
      ed.drag = { kind: 'crop', h: ev.target.dataset.h || 'move', x: ev.clientX, y: ev.clientY, start: cropStart() };
    });
    cropbox.addEventListener('pointermove', function (ev) {
      var d = ed.drag;
      if (!d || d.kind !== 'crop') return;
      var rect = $('ed-crop').getBoundingClientRect();
      var c = cropFrom(d.start.crop, d.h, (ev.clientX - d.x) / rect.width, (ev.clientY - d.y) / rect.height);
      applyCrop(d.start, c, d.h);
    });
    cropbox.addEventListener('keydown', function (ev) {
      var keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (!keys) return;
      ev.preventDefault();
      var start = cropStart(), h = ev.shiftKey ? 'se' : 'move';
      applyCrop(start, cropFrom(start.crop, h, keys[0] * 0.01, keys[1] * 0.01), h);
    });

    screen.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      screen.setPointerCapture(ev.pointerId);
      ensureDest();
      ed.drag = { kind: 'move', x: ev.clientX, y: ev.clientY, dest: Object.assign({}, ed.edit.dest) };
    });
    screen.addEventListener('pointermove', function (ev) {
      var d = ed.drag;
      if (!d || d.kind !== 'move') return;
      var rect = screen.getBoundingClientRect();
      ed.edit.dest = { x: d.dest.x + (ev.clientX - d.x) / rect.width, y: d.dest.y + (ev.clientY - d.y) / rect.height, w: d.dest.w };
      clampDest();
      commit();
    });
    screen.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      setScale(currentScale() * Math.exp(-ev.deltaY * 0.0015));
    }, { passive: false });
    screen.addEventListener('keydown', function (ev) {
      var keys = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[ev.key];
      if (!keys) return;
      ev.preventDefault();
      ensureDest();
      var step = ev.shiftKey ? 20 : 4;
      ed.edit.dest.x += keys[0] * step / ed.size.w;
      ed.edit.dest.y += keys[1] * step / ed.size.h;
      clampDest();
      commit();
    });
    ['pointerup', 'pointercancel'].forEach(function (t) {
      cropbox.addEventListener(t, function () { ed.drag = null; });
      screen.addEventListener(t, function () { ed.drag = null; });
    });

    $('ed-scale').addEventListener('input', function () { setScale(Number($('ed-scale').value)); });
    $('ed-fit').addEventListener('click', function () { setScale(1, true); });
    $('ed-fill').addEventListener('click', function () {
      var L = edLayout();
      setScale(Math.max(ed.size.w / L.sw, ed.size.h / L.sh) * L.sw / containWidth(), true);
    });
    $('ed-center').addEventListener('click', function () { setScale(currentScale(), true); });
    document.querySelectorAll('input[name="ed-bg"]').forEach(function (n) {
      n.addEventListener('change', function () { ed.edit.bg = n.value; commit(); });
    });
    $('ed-invert').addEventListener('change', function () { ed.edit.invert = $('ed-invert').checked; commit(); });
    $('ed-gamma').addEventListener('input', function () { ed.edit.gamma = Number($('ed-gamma').value); commit(); });
    $('ed-reset').addEventListener('click', function () {
      delete state.edits[ed.item.id];
      ed.edit = C.defaultEdit();
      drawEditor();
    });

    $('ed-prev').addEventListener('click', function () { leaveImage(); openEditor(ed.index - 1); });
    $('ed-next').addEventListener('click', function () { leaveImage(); openEditor(ed.index + 1); });
    $('ed-done').addEventListener('click', function () { dlg.close(); });
    // Esc and Done both end here.
    dlg.addEventListener('close', function () { leaveImage(); ed.bmp = null; ed.index = -1; ed.item = null; });
    // A click on the backdrop closes it too.
    dlg.addEventListener('click', function (ev) { if (ev.target === dlg) dlg.close(); });
  }

  function outputFiles() {
    return state.results.filter(function (r) { return r.bytes; }).map(function (r, i) {
      return { name: C.fileName(i), bytes: r.bytes, label: r.item.label };
    });
  }

  function updateExport(rendering) {
    var files = outputFiles();
    var total = files.reduce(function (n, f) { return n + f.bytes.length; }, 0);
    var size = C.panelSize(cfg);
    $('export').hidden = !state.results.length;
    $('export-summary').textContent = rendering ? 'Rendering…' :
      files.length + ' image' + (files.length === 1 ? '' : 's') + ' ready, ' + (total / 1048576).toFixed(1) + ' MB';
    $('export-note').textContent = size.w + ' x ' + size.h + ', ' + (Number(cfg.bpp) === 1 ? '1-bit' : '2-bit') +
      ' BMP files. They\'re made for the reader, so your computer may say it can\'t open them. That\'s normal.';
    ['write-card', 'download', 'send-wifi'].forEach(function (id) { $(id).disabled = rendering || !files.length; });
  }

  // --- export ------------------------------------------------------------------
  function download() {
    var files = outputFiles();
    var zip = C.makeZip(files.map(function (f) { return { path: C.SLEEP_DIR + '/' + f.name, bytes: f.bytes }; }));
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
    a.download = 'crosspoint-sleep-screens-' + (C.parseChannel(cfg.channel) || 'channel') + '.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
    setDone('ZIP downloaded. Open it and drag the sleep folder onto your SD card.');
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  // Says what else the reader will show, since only this site's own images are
  // ever replaced.
  function leftoverNote(r) {
    var notes = [];
    if (r.others) notes.push('The sleep folder also has ' + plural(r.others, 'image') + ' this site didn\'t add, and ' + (r.others === 1 ? 'it stays.' : 'they stay.'));
    if (r.legacy) notes.push('A .sleep folder has ' + plural(r.legacy, 'more image') + '. The reader shows ' + (r.legacy === 1 ? 'it' : 'those') + ' too, so delete ' + (r.legacy === 1 ? 'it' : 'them') + ' if you only want this set.');
    return notes.length ? ' ' + notes.join(' ') : '';
  }

  async function writeCard() {
    var dir;
    try {
      dir = await window.showDirectoryPicker({ id: 'crosspoint-sleep-screens', mode: 'readwrite' });
    } catch (e) {
      if (e.name !== 'AbortError') setDone('Could not open that folder: ' + e.message, true);
      return;
    }
    var button = $('write-card');
    button.disabled = true;
    try {
      var r = await C.writeToDirectory(dir, outputFiles(), { channel: C.parseChannel(cfg.channel) });
      setDone('Saved ' + plural(r.written, 'image') + ' to the sleep folder' +
        (r.removed ? ' and removed ' + r.removed + ' left over from last time' : '') + '.' + leftoverNote(r) +
        ' Put the card back in the reader and set Sleep Screen to Custom.');
    } catch (e) {
      setDone('Could not save to the card: ' + e.message + '. Download the ZIP instead.', true);
    } finally {
      button.disabled = false;
    }
  }

  async function sendWifi() {
    var button = $('send-wifi');
    button.disabled = true;
    setDone('');
    try {
      var r = await C.sendToReader($('reader-host').value, outputFiles(), {
        onProgress: function (n, total) { setDone('Sending ' + n + ' of ' + total + '…', 'info'); }
      });
      setDone('Sent ' + plural(r.written, 'image') + ' to the reader' +
        (r.removed ? ' and removed ' + r.removed + ' left over from last time' : '') + '.' + leftoverNote(r) +
        ' Set Sleep Screen to Custom on the reader.');
    } catch (e) {
      // A refused permission, a blocked request and an unreachable reader all
      // look the same to the page: a TypeError with no detail. A VPN is the
      // most common cause: it routes the request away from your home network.
      setDone(e instanceof TypeError
        ? 'Couldn\'t reach the reader. Turn off any VPN, check the reader is on File Transfer and the same Wi-Fi, and allow local network access if Chrome asks. You can also type the address shown on the reader. Otherwise, use the SD card or ZIP.'
        : 'Sending failed: ' + e.message, true);
    } finally {
      button.disabled = false;
    }
  }

  // --- start -------------------------------------------------------------------
  initControls();
  initEditor();
  $('channel-form').addEventListener('submit', function (e) { e.preventDefault(); loadChannel(); });
  $('download').addEventListener('click', download);
  $('write-card').addEventListener('click', writeCard);
  $('send-wifi').addEventListener('click', sendWifi);
})();
