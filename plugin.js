// CrossPoint Sleep Screens - CrossPoint browser plugin (mount: settings)
//
// The Wi-Fi front end to core.js: the same fetch, classify and dither as the web
// app, but writing straight to the reader. Nothing runs on the device except the
// documented web endpoints:
//   GET  /plugin          - core.js and this plugin's own files
//   POST /api/fetch       - image bytes to SD, if a direct fetch ever fails
//   GET  /download        - read those bytes back same-origin for canvas
//   GET  /api/files       - list /sleep
//   POST /mkdir           - create the fallback temp folder
//   POST /delete          - remove previously synced files
//   POST /api/plugin-fs   - write each BMP (via api.writeFile)
//
// Are.na itself is called directly: api.are.na allows any origin, so /api/relay
// and its 64 KB cap are not involved.

(function () {
  'use strict';

  var STATE_FILE = 'synced.json';
  var CONFIG_FILE = 'config.json';
  // Not a dot folder: the web server refuses to serve those back.
  var TMP_DIR = '/crosspoint-sleep-screens-tmp';
  var TMP_SRC = TMP_DIR + '/src.bin';

  CrossPoint.registerPlugin(function render(container, api) {
    var C, cfg, token = '';
    var logEl, previewEl, busy = false;

    function loadCore() {
      return new Promise(function (resolve, reject) {
        if (window.SleepScreensCore) return resolve(window.SleepScreensCore);
        var s = document.createElement('script');
        s.src = api.pluginFile('core.js');
        s.onload = function () { resolve(window.SleepScreensCore); };
        s.onerror = function () { reject(new Error('could not load core.js from the plugin folder')); };
        document.head.appendChild(s);
      });
    }

    // --- tiny DOM helpers -------------------------------------------------
    function el(tag, attrs, kids) {
      var n = document.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) {
        if (k === 'style') Object.assign(n.style, attrs[k]);
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
        else if (k === 'text') n.textContent = attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
      (kids || []).forEach(function (c) { n.appendChild(c); });
      return n;
    }

    function log(msg, kind) {
      var line = el('div', { text: msg });
      if (kind === 'err') line.style.color = '#c0392b';
      if (kind === 'skip') line.style.color = '#7f8c8d';
      if (kind === 'ok') line.style.color = '#1e7a3c';
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }

    // --- config persistence (plugin's own folder) -------------------------
    async function loadConfig() {
      try {
        var r = await fetch(api.pluginFile(CONFIG_FILE), { cache: 'no-store' });
        if (r.ok) {
          var saved = await r.json();
          // Earlier versions saved the token here. Never read it back.
          delete saved.token;
          Object.assign(cfg, saved);
        }
      } catch (e) { /* first run: no config.json yet */ }
    }

    async function saveJson(file, obj) {
      var bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2));
      await api.writeFile(api.dir + '/' + file, C.b64(bytes));
    }

    async function loadSynced() {
      try {
        var r = await fetch(api.pluginFile(STATE_FILE), { cache: 'no-store' });
        if (r.ok) {
          var j = await r.json();
          if (Array.isArray(j.files)) return j;
        }
      } catch (e) { /* nothing synced yet */ }
      return { channel: '', files: [] };
    }

    // --- pixel acquisition -------------------------------------------------
    // Both image hosts allow any origin, so the direct fetch is the normal path.
    // The device round-trip stays as a fallback for a network that blocks them.
    async function loadBitmap(url) {
      try {
        var r = await fetch(url, { mode: 'cors', cache: 'no-store' });
        if (r.ok) return { bmp: await createImageBitmap(await r.blob()), via: 'direct' };
      } catch (e) { /* fall through to the device round-trip */ }

      await mkdir(TMP_DIR);
      await api.fetchToSd(url, TMP_SRC, {});
      var d = await fetch('/download?path=' + encodeURIComponent(TMP_SRC), { cache: 'no-store' });
      if (!d.ok) throw new Error('could not read the staged file back (HTTP ' + d.status + ')');
      return { bmp: await createImageBitmap(await d.blob()), via: 'device' };
    }

    // --- device file helpers --------------------------------------------------
    function post(path, form) {
      return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString()
      });
    }

    // /mkdir takes the new folder's name plus its parent path.
    async function mkdir(path) {
      var at = path.lastIndexOf('/');
      try {
        await post('/mkdir', { name: path.slice(at + 1), path: path.slice(0, at) || '/' });
      } catch (e) { /* already exists */ }
    }

    async function listDir(path) {
      var r = await fetch('/api/files?path=' + encodeURIComponent(path), { cache: 'no-store' });
      if (!r.ok) return [];
      var j = await r.json();
      return Array.isArray(j) ? j : [];
    }

    // Only removes what a previous sync wrote, so hand-placed images survive.
    async function prune(previous) {
      var existing = {};
      (await listDir(SLEEP)).forEach(function (f) { if (!f.isDirectory) existing[f.name] = true; });
      var doomed = previous.filter(function (n) { return existing[n]; })
        .map(function (n) { return SLEEP + '/' + n; });
      if (!doomed.length) return 0;
      var r = await post('/delete', { paths: JSON.stringify(doomed) });
      if (!r.ok) throw new Error('/delete failed (HTTP ' + r.status + ')');
      return doomed.length;
    }

    // --- the sync ---------------------------------------------------------------
    async function run(dryRun) {
      if (busy) return;
      busy = true;
      logEl.replaceChildren();
      previewEl.replaceChildren();

      try {
        var slug = C.parseChannel(cfg.channel);
        if (!slug) throw new Error('Enter an Are.na channel URL or slug first.');

        var panel = C.panelSize(cfg);
        log((dryRun ? 'Dry run' : 'Sync') + ' - channel "' + slug + '", target ' +
          panel.w + ' x ' + panel.h + ', ' + cfg.bpp + 'bpp, fit=' + cfg.fit);

        var res = await C.fetchChannel(slug, { token: token, sort: C.sortFor(cfg.order) });
        log('Channel: ' + (res.channel.title || slug) + ' - ' + res.blocks.length + ' blocks.');

        var sel = C.selectBlocks(res.blocks, cfg);
        sel.skipped.forEach(function (c) { log('skip - ' + c.label + ': ' + c.reason, 'skip'); });
        log('Usable images: ' + sel.kept.length + ' (skipped ' + sel.skipped.length + ').');

        var kept = sel.kept;
        if (kept.length > cfg.maxImages) {
          log('Taking ' + cfg.maxImages + ' (the reader scans every file in /sleep each time it sleeps).');
          kept = kept.slice(0, cfg.maxImages);
        }

        var levelsCount = Number(cfg.bpp) === 1 ? 2 : 4, bpp = Number(cfg.bpp) === 1 ? 1 : 2;
        var written = [], failures = 0;
        for (var i = 0; i < kept.length; i++) {
          var item = kept[i];
          var name = C.fileName(written.length);
          try {
            var loaded = await loadBitmap(item.url);
            var r = C.rasterize(loaded.bmp, panel.w, panel.h, cfg);
            if (loaded.bmp.close) loaded.bmp.close();
            var levels = C.dither(r.gray, panel.w, panel.h, levelsCount);
            var bytes = C.encodeBmp(levels, panel.w, panel.h, bpp);

            showPreview(levels, panel, bpp, name, item.label);

            if (dryRun) {
              log('would write ' + name + ' - ' + Math.round(bytes.length / 1024) + ' KB (' +
                loaded.via + ', ' + r.fit + ') - ' + item.label, 'ok');
              written.push(name);
            } else {
              if (bytes.length > 256 * 1024) {
                throw new Error('BMP is ' + Math.round(bytes.length / 1024) +
                  ' KB, over the 256KB /api/plugin-fs cap');
              }
              await api.writeFile(SLEEP + '/' + name, C.b64(bytes));
              written.push(name);
              log('wrote ' + name + ' - ' + Math.round(bytes.length / 1024) + ' KB (' +
                loaded.via + ', ' + r.fit + ') - ' + item.label, 'ok');
            }
          } catch (e) {
            failures++;
            log('failed - ' + item.label + ': ' + ((e && e.message) || e), 'err');
          }
        }

        if (!dryRun) {
          var prior = await loadSynced();
          var stale = prior.files.filter(function (n) { return written.indexOf(n) === -1; });
          if (stale.length) {
            var removed = await prune(stale);
            log('Removed ' + removed + ' file(s) from the previous sync.');
          }
          await saveJson(STATE_FILE, { channel: slug, at: new Date().toISOString(), files: written });
          await saveJson(CONFIG_FILE, cfg);
          log('Done: ' + written.length + ' image(s) in ' + SLEEP +
            (failures ? ', ' + failures + ' failure(s)' : '') + '.', 'ok');
          log('Set Settings > Display > Sleep Screen to Custom to use them.');
        } else {
          log('Dry run complete - nothing was written.', 'ok');
        }
      } catch (e) {
        log('Error: ' + ((e && e.message) || e), 'err');
      } finally {
        busy = false;
      }
    }

    // Draws the dithered result at a readable size so a bad crop is obvious
    // before it reaches the card.
    function showPreview(levels, panel, bpp, name, label) {
      var c = document.createElement('canvas');
      c.width = panel.w; c.height = panel.h;
      var g = c.getContext('2d');
      var img = g.createImageData(panel.w, panel.h);
      var step = bpp === 1 ? 255 : 85;
      for (var i = 0; i < levels.length; i++) {
        var v = levels[i] * step;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      c.style.width = '120px';
      c.style.height = 'auto';
      c.style.border = '1px solid #ccc';
      c.title = name + ' - ' + label;
      previewEl.appendChild(c);
    }

    // --- UI ------------------------------------------------------------------
    function field(labelText, node) {
      return el('label', { style: { display: 'block', margin: '8px 0' } },
        [el('span', { text: labelText, style: { display: 'block', fontSize: '0.85em', opacity: '0.8' } }), node]);
    }

    function textInput(key, placeholder, type) {
      var n = el('input', {
        type: type || 'text', value: cfg[key] == null ? '' : String(cfg[key]),
        placeholder: placeholder || '', style: { width: '100%', boxSizing: 'border-box' },
        oninput: function () { cfg[key] = type === 'number' ? Number(n.value) : n.value; }
      });
      return n;
    }

    function checkbox(key, labelText) {
      var n = el('input', {
        type: 'checkbox',
        onchange: function () { cfg[key] = n.checked; }
      });
      n.checked = !!cfg[key];
      return el('label', { style: { display: 'block', margin: '4px 0', fontSize: '0.9em' } },
        [n, el('span', { text: ' ' + labelText })]);
    }

    function select(key, options, numeric) {
      var n = el('select', {
        style: { width: '100%' },
        onchange: function () { cfg[key] = numeric ? Number(n.value) : n.value; if (key === 'panel') syncCustom(); }
      }, options.map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      n.value = String(cfg[key]);
      return n;
    }

    var customRow;
    function syncCustom() { customRow.style.display = cfg.panel === 'CUSTOM' ? 'block' : 'none'; }

    function build() {
      customRow = el('div', {}, [
        field('Width', textInput('width', '480', 'number')),
        field('Height', textInput('height', '800', 'number'))
      ]);
      syncCustom();

      // Session only. Anything in this folder can be read by anyone on the
      // network through /plugin, so a token is never written to config.json.
      var tokenInput = el('input', {
        type: 'password', style: { width: '100%', boxSizing: 'border-box' },
        oninput: function () { token = tokenInput.value.trim(); }
      });

      logEl = el('pre', {
        style: {
          maxHeight: '260px', overflow: 'auto', background: '#f6f6f6', padding: '8px',
          fontSize: '0.8em', whiteSpace: 'pre-wrap', margin: '8px 0'
        }
      });
      previewEl = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '8px 0' } });

      container.replaceChildren(
        el('h2', { text: 'CrossPoint Sleep Screens' }),
        el('p', {
          text: 'Converts a channel\'s image blocks into screen-sized dithered BMPs in /sleep. ' +
            'Dry run first - it reports every block it skips and why.',
          style: { fontSize: '0.9em', opacity: '0.85' }
        }),
        field('Channel URL or slug', textInput('channel', 'https://are.na/you/your-channel')),
        field('Personal access token (private channels, not saved)', tokenInput),
        field('Reader', select('panel', Object.keys(C.PANELS).map(function (k) { return [k, C.PANELS[k].label]; }))),
        customRow,
        field('Fit', select('fit', [
          ['auto', 'Auto - crop unless it loses too much'],
          ['cover', 'Always crop to fill'],
          ['contain', 'Always show the whole image']
        ])),
        field('Depth', select('bpp', [
          ['2', '2-bit - four greys (matches firmware)'],
          ['1', '1-bit - black and white']
        ], true)),
        field('Order', select('order', [
          ['newest', 'Newest in channel first'],
          ['oldest', 'Oldest in channel first'],
          ['random', 'Random']
        ])),
        field('Maximum images', textInput('maxImages', '24', 'number')),
        field('Minimum source size (px)', textInput('minSourcePx', '400', 'number')),
        field('Brightness (1 is neutral, higher is lighter)', textInput('gamma', '1', 'number')),
        el('div', { style: { margin: '8px 0' } }, [
          checkbox('includeLinkThumbs', 'Include link and video thumbnails'),
          checkbox('includeAttachmentPreviews', 'Include PDF and file previews'),
          checkbox('allowSvg', 'Include SVGs'),
          checkbox('invert', 'Invert')
        ]),
        el('div', { style: { display: 'flex', gap: '8px', margin: '12px 0' } }, [
          el('button', { text: 'Dry run', onclick: function () { run(true); } }),
          el('button', { text: 'Sync to /sleep', onclick: function () { run(false); } })
        ]),
        previewEl,
        logEl
      );
    }

    var SLEEP;
    return (async function () {
      C = await loadCore();
      SLEEP = '/' + C.SLEEP_DIR;
      cfg = Object.assign({}, C.DEFAULTS);
      await loadConfig();
      build();
      var prior = await loadSynced();
      if (prior.files.length) {
        log('Previous sync: ' + prior.files.length + ' file(s) from "' + prior.channel + '"' +
          (prior.at ? ' at ' + prior.at : '') + '.');
      }
    })();
  });
})();
