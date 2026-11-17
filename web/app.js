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
  function setDone(msg, isError) {
    var d = $('done');
    d.hidden = !msg;
    d.textContent = msg || '';
    d.classList.toggle('err', !!isError);
  }
  function showRate(r) {
    if (!r.limit) return;
    $('rate').textContent = 'Are.na tier: ' + (r.tier || 'unknown') + ', ' + r.remaining + ' of ' + r.limit + ' requests left this minute.';
  }

  // --- controls ---------------------------------------------------------------
  var RENDER_KEYS = ['panel', 'width', 'height', 'fit', 'bpp', 'gamma', 'invert'];
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
        else if (k === 'gamma') renderSoon();
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
    var g = Number(cfg.gamma);
    $('gamma-out').textContent = g === 1 ? '(neutral)' : g > 1 ? '(lighter, ' + g.toFixed(2) + ')' : '(darker, ' + g.toFixed(2) + ')';
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

  var renderTimer = null;
  function renderSoon() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 200);
  }

  async function render() {
    var gen = ++state.generation;
    var items = activeItems();
    var size = C.panelSize(cfg);
    var bpp = Number(cfg.bpp) === 1 ? 1 : 2;

    state.results = items.map(function (item) { return { item: item, name: null, bytes: null }; });
    setDone('');
    $('empty').hidden = true;
    updateExport(true);

    // One placeholder per image, so the grid keeps its shape while it fills.
    var cards = items.map(function (item) {
      var fig = document.createElement('figure');
      fig.className = 'card';
      var canvas = document.createElement('canvas');
      canvas.className = 'screen';
      canvas.width = size.w; canvas.height = size.h;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', item.label);
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
      fig.append(canvas, drop, cap);
      return { fig: fig, canvas: canvas, cap: cap };
    });
    $('grid').replaceChildren.apply($('grid'), cards.map(function (c) { return c.fig; }));

    var skippedCount = state.selection.skipped.length;
    var title = state.channelTitle;
    if (!items.length) {
      setStatus(title + ': no usable images' + (skippedCount ? ' (' + skippedCount + ' skipped).' : '.'), true);
      updateExport(false);
      return;
    }

    for (var i = 0; i < items.length; i++) {
      setStatus(title + ': rendering ' + (i + 1) + ' of ' + items.length + '…');
      try {
        var bmp = await getBitmap(items[i].url);
        if (gen !== state.generation) return;
        var r = C.rasterize(bmp, size.w, size.h, cfg);
        var levels = C.dither(r.gray, size.w, size.h, bpp === 1 ? 2 : 4);
        drawLevels(cards[i].canvas, levels, size.w, size.h, bpp);
        state.results[i].bytes = C.encodeBmp(levels, size.w, size.h, bpp);
        cards[i].cap.textContent = items[i].label + (r.fit === 'contain' ? ' · whole image' : '');
      } catch (e) {
        if (gen !== state.generation) return;
        cards[i].fig.classList.add('failed');
        cards[i].cap.textContent = items[i].label + ': could not load this image, so it will be left out';
      }
      // Yield so the page stays responsive and a newer render can take over.
      await new Promise(function (res) { setTimeout(res, 0); });
      if (gen !== state.generation) return;
    }

    var failed = state.results.filter(function (x) { return !x.bytes; }).length;
    setStatus(title + ': ' + (items.length - failed) + ' ready' +
      (failed ? ', ' + failed + ' failed' : '') +
      (state.selection.kept.length > items.length ? ', ' + (state.selection.kept.length - items.length) + ' more available' : '') +
      (skippedCount ? ', ' + skippedCount + ' skipped.' : '.'));
    updateExport(false);
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
      setDone('Saved ' + r.written + ' image' + (r.written === 1 ? '' : 's') + ' to the sleep folder' +
        (r.removed ? ' and removed ' + r.removed + ' from last time' : '') +
        '. Put the card back in the reader and set Sleep Screen to Custom.');
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
        onProgress: function (n, total) { setDone('Sending ' + n + ' of ' + total + '…'); }
      });
      setDone('Sent ' + r.written + ' image' + (r.written === 1 ? '' : 's') + ' to the reader' +
        (r.removed ? ' and removed ' + r.removed + ' from last time' : '') + '. Set Sleep Screen to Custom on the reader.');
    } catch (e) {
      // A refused permission, a blocked request and an unreachable reader all
      // look the same to the page: a TypeError with no detail.
      setDone(e instanceof TypeError
        ? 'Couldn\'t reach the reader. Check it\'s on File Transfer, on the same Wi-Fi, and that you allowed local network access. You can also type the address shown on the reader. Otherwise, use the SD card or ZIP.'
        : 'Sending failed: ' + e.message, true);
    } finally {
      button.disabled = false;
    }
  }

  // --- start -------------------------------------------------------------------
  initControls();
  $('channel-form').addEventListener('submit', function (e) { e.preventDefault(); loadChannel(); });
  $('download').addEventListener('click', download);
  $('write-card').addEventListener('click', writeCard);
  $('send-wifi').addEventListener('click', sendWifi);
})();
