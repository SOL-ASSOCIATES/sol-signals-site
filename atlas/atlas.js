/* atlas.js - core of the Romanian Energy Grid Atlas page: manifest, map, layer panel, legend, drawer, theme, test hooks.
 * It knows nothing about individual layers: each manifest layer has a "kind" and is drawn by window.AtlasRenderers[kind] (see render_assets.js for the
 * contract). A layer whose kind has no renderer is listed in the panel as disabled. Plain script, no build step, no external requests except base-map tiles. */
(function () {
  "use strict";
  var L = window.L, Lib = window.AtlasLib, UI = window.AtlasUI, Renderers = window.AtlasRenderers || {};
  var GROUPS = ["Assets", "Weather", "Production", "Connection approvals (ATR)"];
  var RO_BOUNDS = [[43.6, 20.2], [48.3, 29.8]];
  var CANVAS_PADDING = 0.5;
  var $ = function (id) { return document.getElementById(id); };
  var S = { manifest: null, map: null, layers: {}, order: [], ctx: null, palette: {}, popup: null, openerFor: null, errors: [], starting: false };

  /* Hooks for the verification harness. toggle(id) returns the milliseconds until the redraw finished; while a layer's data is still loading it
   * returns a Promise of that number instead. ready becomes true once every renderable layer is in memory (a shown layer that converts its detail in idle time has finished
   * that too) and the first useful time has been measured. */
  var hooks = window.__atlas = {
    ready: false, firstUsefulMs: NaN, errors: S.errors, failed: [], unavailable: [], map: null, gmapsLink: Lib.gmapsLink,
    layerIds: function () { return S.order.filter(function (id) { return S.layers[id].renderer; }); },
    mapView: function () {                               // what the verification reads: does Leaflet know the size of its box, and is Romania inside the view
      var m = S.map, c = m.getContainer(), s = m.getSize();
      return { synced: s.x === c.clientWidth && s.y === c.clientHeight, contains: m.getBounds().contains(RO_BOUNDS), width: c.clientWidth, height: c.clientHeight };
    },
    toggle: function (id) { return setOn(id, !layer(id).on); },
    isOn: function (id) { return layer(id).on; },
    legendCounts: function (id) { var l = layer(id); return l.state ? l.renderer.counts(l.entry, l.state) : {}; },
    info: function (id) {
      var l = layer(id), base = { on: l.on, loaded: !!l.state };
      return l.state && l.renderer.info ? Object.assign(base, l.renderer.info(l.entry, l.state, S.ctx)) : base;
    },
    openPopup: function (layerId, index, opts) {
      var l = layer(layerId);
      if (!l.state) { throw new Error("layer " + layerId + " is not loaded yet; wait for __atlas.ready"); }
      if (!l.on) { setOn(layerId, true); }
      var d = l.renderer.describe(l.entry, l.state, index, S.ctx);
      if (opts && opts.pan) { S.map.setView(d.latlng, Math.max(S.map.getZoom(), 9), { animate: false }); }
      S.ctx.showPopup(d.el, d.latlng);
      return d.el;
    }
  };

  function titleOf(entry) { return entry && (entry.title || entry.id) ? String(entry.title || entry.id) : "a layer"; }
  function layer(id) {
    if (!S.layers[id]) { throw new Error("unknown layer " + id); }
    return S.layers[id];
  }
  function cssVar(name) {
    if (!S.palette[name]) { S.palette[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
    return S.palette[name];
  }
  /* The address of a data file (an image, for instance) with the build id, so a new build never shows a cached old file. */
  function assetUrl(url) { return url + "?v=" + S.manifest.build_id; }
  function fetchJson(url) {
    return fetch(assetUrl(url)).then(function (res) {
      if (!res.ok) { throw new Error(url + " answered HTTP " + res.status); }
      return res.json();
    });
  }
  function fail(message) {
    if (S.errors.indexOf(message) >= 0) { return; }
    S.errors.push(message);
    UI.notice($("notices"), message, "bad");
  }

  // ------------------------------------------------------------------ theme
  function systemDark() { return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches; }
  function currentTheme() {
    var attr = document.documentElement.getAttribute("data-theme");
    return attr === "dark" || attr === "light" ? attr : (systemDark() ? "dark" : "light");
  }
  function themeChanged() {
    var dark = currentTheme() === "dark", btn = $("theme-btn");
    btn.textContent = dark ? "Light mode" : "Dark mode";
    btn.setAttribute("aria-pressed", dark ? "true" : "false");
    S.palette = {};
    if (!S.ctx) { return; }
    S.order.forEach(function (id) {
      var l = S.layers[id];
      if (l.state && l.renderer.restyle) { l.renderer.restyle(l.entry, l.state, S.ctx); }
    });
    S.ctx.flush();
  }
  function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem("atlas-theme"); } catch (e) { stored = null; }
    if (stored === "dark" || stored === "light") { document.documentElement.setAttribute("data-theme", stored); }
    $("theme-btn").addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("atlas-theme", next); } catch (e) { /* storage may be blocked */ }
      themeChanged();
    });
    if (window.matchMedia) {
      var query = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () { if (!document.documentElement.getAttribute("data-theme")) { themeChanged(); } };
      if (query.addEventListener) { query.addEventListener("change", onChange); }
    }
    themeChanged();
  }

  // ------------------------------------------------------------------ map and context
  function flush() {
    var r = S.ctx.renderers;
    [r.outlines, r.assets, r.boundaries].forEach(function (renderer) {
      try { if (renderer._redrawRequest) { L.Util.cancelAnimFrame(renderer._redrawRequest); renderer._redraw(); } } catch (e) { /* the frame callback will draw */ }
    });
  }
  function showPopup(el, latlng) {
    if (!S.popup) { S.popup = L.popup({ maxWidth: 320, autoPanPadding: [16, 16] }); }
    S.popup.setLatLng(latlng).setContent(el).openOn(S.map);
    S.map.fire("atlaspopup", { el: el });                  // the one popup object is reused, so Leaflet sends no close event when another layer takes it over: renderers listen to this
  }
  /* Bring every shown layer that ranks above `rank` to the front of the shared canvas, lowest rank first, so the draw order (lines, substations,
   * generators, plants) and therefore the click order do not depend on the order in which layers were switched on. */
  function restack(rank) {
    S.order.map(function (id) { return S.layers[id]; }).filter(function (l) {
      return l.on && l.renderer && l.renderer.front && l.renderer.rank && l.renderer.rank(l.entry) > rank;
    }).sort(function (x, y) { return x.renderer.rank(x.entry) - y.renderer.rank(y.entry); }).forEach(function (l) { l.renderer.front(l.entry, l.state, S.ctx); });
  }
  function initMap(manifest) {
    var basemap = manifest.basemap;
    var map = L.map("map", { preferCanvas: true, zoomSnap: 0.5, minZoom: 5, maxZoom: basemap ? basemap.max_zoom : 14, attributionControl: true, maxBoundsViscosity: 0.6 });
    map.setMaxBounds([[42.0, 18.0], [50.0, 32.0]]);
    /* Stacking, bottom to top: country fill (outlines, 350), climatology image (raster, 355), the shared canvas of the weather cells and the assets (Leaflet's
     * overlay pane, 400: the cells are sent to the back of it so a click reaches a line or a plant first), county lines (boundaries, 450, never takes pointer events). */
    map.createPane("outlines").style.zIndex = 350;
    map.createPane("raster").style.zIndex = 355;
    var boundaries = map.createPane("boundaries");
    boundaries.style.zIndex = 450;
    boundaries.style.pointerEvents = "none";
    map.attributionControl.setPrefix("Leaflet");
    /* The credit of the control comes from the page text of the manifest: links to the licensors, always shown (the OpenStreetMap-derived layers need it even with no base map).
     * Without that text (an old manifest) the plain attribution of the base map is used. */
    var page = manifest.page || {}, credit = page.map_credit && page.map_credit.length ? UI.attributionHtml(page.map_credit, page.link_hosts) : "";
    /* Light use of the tile server (the OpenStreetMap tile usage policy of the demo): the zoom limit comes from the manifest (17), retina tiles are off (a second, four times larger request per
     * tile), nothing loads tiles ahead of the view, and the browser sets User-Agent and Referer. */
    var tiles = basemap ? L.tileLayer(basemap.url, { attribution: credit ? "" : basemap.attribution, maxZoom: basemap.max_zoom, crossOrigin: true, detectRetina: false }).addTo(map) : null;
    if (tiles && window.AtlasTiles) {                    // tiles.js: when the tiles do not load, one plain notice, a neutral ground, and every layer keeps drawing; it clears when tiles return
      hooks.tileState = window.AtlasTiles.watch(tiles, {
        show: function () { var node = UI.notice($("notices"), Lib.TILE_DOWN_TEXT, "warn"); node.setAttribute("data-role", "tiles-down"); return node; },
        hide: function (node) { if (node.parentNode) { node.parentNode.removeChild(node); } },
        changed: function (down) { document.documentElement.setAttribute("data-tiles", down ? "down" : "up"); if (S.ctx) { S.ctx.basemapOn = !down; themeChanged(); } } });
    }
    if (credit) { map.attributionControl.addAttribution(credit); }
    /* The compact call to action in the bottom-left corner of the map: a link to Sol's own pages, labelled as coming from Sol Associates. Its address and label come from the manifest. */
    var cta = UI.mapCta(page.ctas && page.ctas.map_corner, page.link_hosts), interests = UI.interestsLink(manifest);
    if (cta && interests) { cta.appendChild(document.createTextNode(" | ")); cta.appendChild(interests); }                 // the disclosure of interests next to the call to action
    if (cta) {
      var corner = L.control({ position: "bottomleft" });
      corner.onAdd = function () { if (L.DomEvent && L.DomEvent.disableClickPropagation) { L.DomEvent.disableClickPropagation(cta); } return cta; };
      corner.addTo(map);
    }
    map.fitBounds(RO_BOUNDS);
    S.map = map;
    hooks.map = map;
    /* The canvases are the page's own canvas renderers (canvas_assets.js): one redraw per view change instead of two. The padding is the extra canvas around the view that
     * lets the map be dragged without blank edges. */
    var canvasFor = function (options) { return window.AtlasCanvas ? window.AtlasCanvas.renderer(options) : L.canvas(options); };
    S.ctx = { map: map, renderers: { assets: canvasFor({ padding: CANVAS_PADDING, tolerance: 5 }), outlines: canvasFor({ pane: "outlines", padding: CANVAS_PADDING }),
      boundaries: canvasFor({ pane: "boundaries", padding: CANVAS_PADDING }) }, pal: cssVar, dark: function () { return currentTheme() === "dark"; }, hooks: hooks,
      fetchJson: fetchJson, assetUrl: assetUrl, setUnavailable: setUnavailable, showPopup: showPopup, flush: flush, restack: restack, basemapOn: !!basemap, refreshLegend: refreshLegend,
      /* the edition of the build ("demo", "production" or "preview": the age limit of a forecast depends on it) and the notices on the map that a layer may add and take away again (the demo's forecast label) */
      edition: manifest.edition, page: page, addNotice: function (text, cls) { return UI.notice($("notices"), text, cls); },
      removeNotice: function (node) { if (node && node.parentNode) { node.parentNode.removeChild(node); } },
      /* the view of the other layers that a renderer may need (the ATR layer takes its county outlines from the county layer and keeps one snapshot on at a time) */
      entries: function (kind) { return (S.manifest.layers || []).filter(function (e) { return e && e.kind === kind; }); },
      isOn: function (id) { return !!(S.layers[id] && S.layers[id].on); },
      setOn: function (id, on) { return setOn(id, on); },
      loadLayer: function (id) { var l = S.layers[id]; return l && l.renderer ? loadLayer(l) : Promise.reject(new Error("layer " + id + " cannot be loaded")); } };
    map.on("zoomend", function () {                      // the canvases redraw themselves once per view change: a renderer only notes the new zoom here
      S.order.forEach(function (id) {
        var l = S.layers[id];
        if (l.on && l.renderer.onZoom) { l.renderer.onZoom(l.entry, l.state, S.ctx); }
      });
    });
    map.on("click", function () { if (isSmall()) { setPanel(false); } });
    if (!basemap) { UI.notice($("notices"), "Base map pending - not available in this build.", "warn"); }
    if (manifest.preview) { UI.notice($("notices"), "PREVIEW ONLY - not for publication", "preview"); }
  }

  // ------------------------------------------------------------------ layers: load, toggle, legend
  function loadLayer(l) {
    if (!l.loading) {
      l.loading = Lib.startLoad(function () { return l.renderer.load(l.entry, S.ctx); }).then(function (state) {
        l.state = state;
        if (state.unavailable) { markUnavailable(l, state.unavailable); }
        if (state.whenComplete) { state.whenComplete.then(function () { state.done = true; refreshLegend(l.entry.id); }, function () { fail("Could not load all of " + titleOf(l.entry) + "."); }); }
        refreshLegend(l.entry.id);
        return state;
      }).catch(function (error) {
        l.failed = true;
        hooks.failed.push(l.entry.id);
        fail("Could not load " + titleOf(l.entry) + ".");
        l.ui.box.disabled = true;
        l.ui.root.classList.add("is-unavailable");
        l.ui.warnHost.appendChild(UI.el("p", { class: "mismatch", text: "This layer could not be loaded. The other layers are not affected." }));
        throw error;
      });
    }
    return l.loading;
  }

  /* Draw or remove one layer; a renderer that throws is reported and leaves the other layers alone. */
  function showSafely(l) {
    try { applyOn(l, true); } catch (error) { l.failed = true; hooks.failed.push(l.entry.id); l.ui.box.disabled = true; fail("Could not draw " + l.entry.title + "."); }
  }

  /* A layer that refuses to be drawn (a forecast that is out of date on the viewer's clock) is switched off and disabled, with the reason on its card and in the
   * notices. A renderer says so by setting state.unavailable to the text to show; nothing of that layer is drawn. */
  function markUnavailable(l, text) {
    if (l.unavailable) { return; }
    l.unavailable = text;
    hooks.unavailable.push(l.entry.id);
    l.on = false;
    l.ui.box.checked = false;
    l.ui.box.disabled = true;
    l.ui.root.classList.add("is-unavailable", "is-off");
    var ageNote = l.ui.root.querySelector('[data-role="forecast-age"]');           // a forecast's card states its age on the viewer's clock: keep that line true
    if (ageNote) { ageNote.textContent = Lib.forecastCardText(Lib.forecastAge(l.entry.meta.issued_at, Date.now(), S.manifest.edition)); ageNote.classList.add("is-stale"); }
    UI.notice($("notices"), text, "bad");
  }

  /* For a renderer that finds out later that its layer must not stay on (the forecast aged past its limit while the page was open). */
  function setUnavailable(id, text) {
    var l = layer(id);
    if (l.on) { l.renderer.hide(l.entry, l.state, S.ctx); }
    markUnavailable(l, text);
    refreshLegend(id);
    S.ctx.flush();
  }

  function applyOn(l, on) {
    if (on === l.on) { return; }
    if (on) {
      l.renderer.show(l.entry, l.state, S.ctx);
      if (l.state.unavailable) { markUnavailable(l, l.state.unavailable); refreshLegend(l.entry.id); return; }
    } else { l.renderer.hide(l.entry, l.state, S.ctx); }
    l.on = on;
    l.ui.box.checked = on;
    l.ui.root.classList.toggle("is-off", !on);
    if (!S.starting) { S.ctx.flush(); }                   // a switch made by hand is drawn at once; the first layers of the page are drawn together in the next frame
    refreshLegend(l.entry.id);
  }

  function setOn(id, on) {
    var l = layer(id), t0 = performance.now();
    if (!l.renderer) { return 0; }
    if (l.failed || l.unavailable) { return NaN; }     // a layer that failed to load, or refuses to be drawn, has no redraw time
    if (!l.state) {
      return loadLayer(l).then(function () { applyOn(l, on); return performance.now() - t0; });
    }
    applyOn(l, on);
    return performance.now() - t0;
  }

  function mismatch(entry, counts) {
    var diffs = [];
    Object.keys(entry.counts).forEach(function (key) {
      if (counts[key] !== entry.counts[key]) { diffs.push(key + ": page " + counts[key] + ", build " + entry.counts[key]); }
    });
    return diffs;
  }

  function refreshLegend(id) {
    var l = S.layers[id];
    if (!l || !l.state || !l.ui) { return; }
    var legend = l.renderer.legend(l.entry, l.state, S.ctx), host = l.ui.legendHost;
    UI.refreshForecastLabel(l.ui, l.entry, S.manifest.edition);          // the card of a forecast keeps its label true while the page stays open (the valid-until time may pass)
    /* legend.extra (above the rows: controls, a chart) and legend.after (below them: a table) are nodes the renderer keeps alive: they stay in the page while the
     * rows between them are rebuilt, so a slider keeps its focus. */
    var keep = [legend.extra, legend.after].filter(Boolean);
    Array.prototype.slice.call(host.childNodes).forEach(function (node) { if (keep.indexOf(node) < 0) { host.removeChild(node); } });
    if (legend.extra && legend.extra.parentNode !== host) { host.insertBefore(legend.extra, host.firstChild); }
    var tail = legend.after && legend.after.parentNode === host ? legend.after : null;
    host.insertBefore(UI.legend(legend.rows), tail);
    if (legend.note) { host.insertBefore(UI.el("p", { class: "legend-note", text: legend.note }), tail); }
    if (legend.after && !tail) { host.appendChild(legend.after); }
    UI.clear(l.ui.warnHost);
    if (l.unavailable) { l.ui.warnHost.appendChild(UI.el("p", { class: "mismatch", role: "alert", text: l.unavailable })); }
    var complete = l.renderer.complete ? l.renderer.complete(l.state) : !(l.state.whenComplete && !l.state.done);
    var diffs = complete ? mismatch(l.entry, l.renderer.counts(l.entry, l.state)) : [];
    if (diffs.length) {
      fail("Count check failed for " + l.entry.title + ".");
      l.ui.warnHost.appendChild(UI.el("p", { class: "mismatch", text: "Count check failed (" + diffs.join("; ") + "). Do not rely on this layer." }));
    }
  }

  // ------------------------------------------------------------------ drawer, panel, footer
  function openDrawer(title, nodes, opener) {
    var drawer = $("drawer");
    $("drawer-title").textContent = title;
    var body = UI.clear($("drawer-body"));
    nodes.forEach(function (n) { body.appendChild(n); });
    body.scrollTop = 0;
    drawer.hidden = false;
    S.openerFor = opener || null;
    $("drawer-close").focus();
  }
  function closeDrawer() {
    var drawer = $("drawer");
    if (drawer.hidden) { return; }
    drawer.hidden = true;
    if (S.openerFor && S.openerFor.focus) { S.openerFor.focus(); }
    S.openerFor = null;
  }
  function isSmall() { return window.matchMedia && window.matchMedia("(max-width: 767px)").matches; }
  function setPanel(open) {
    $("panel").classList.toggle("open", open);
    $("panel-toggle").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function buildPanel(manifest) {
    var host = $("layers");
    var groupOf = {};
    (manifest.layers || []).forEach(function (entry) {
      try {
        var renderer = Renderers[entry.kind] || null;
        var l = { entry: entry, renderer: renderer, state: null, on: false, loading: null, ui: null };
        l.ui = UI.layerCard(entry, { available: !!renderer, edition: manifest.edition, onToggle: function (on) { setOn(entry.id, on); },
          onDetails: function (opener) {
            var note = l.state && l.renderer.legend ? l.renderer.legend(entry, l.state, S.ctx).note : null;
            openDrawer(entry.title, UI.drawerBody(entry, manifest, note), opener);
          } });
        S.layers[entry.id] = l;
        S.order.push(entry.id);
        (groupOf[entry.group] = groupOf[entry.group] || []).push(l.ui.root);
      } catch (error) {
        hooks.failed.push(entry && entry.id ? String(entry.id) : "unknown");
        fail("A layer entry of this build is incomplete and was skipped: " + titleOf(entry) + ".");
      }
    });
    (manifest.withheld || []).forEach(function (item) { (groupOf[item.group] = groupOf[item.group] || []).push(UI.withheldCard(item)); });
    GROUPS.concat(Object.keys(groupOf).filter(function (g) { return GROUPS.indexOf(g) < 0; })).forEach(function (name) {
      if (groupOf[name]) { host.appendChild(UI.groupBlock(name, groupOf[name])); }
    });
  }

  /* The strip under the header while the publisher's details or a confirmed notice are missing: the build can be looked at, never published. */
  function buildStrip(manifest) { UI.pendingStrip($("pending-strip"), manifest); }          // the three states are UI.pendingStrip's (tested under the fake DOM)

  /* The footer is the permanent part of the page text (ui.js footer: the legal block in a details that is closed on a phone, the build line outside it). */
  function buildFooter(manifest) {
    var label = editionLabel(manifest), narrow = window.matchMedia ? window.matchMedia("(max-width: 767px)") : null;
    UI.footer($("foot"), manifest, { label: label, narrow: narrow });
    var edition = manifest.preview ? "PREVIEW edition (not for publication)" : (label || (manifest.tier === "PUBLIC" ? "Public edition" : manifest.tier + " edition"));
    $("edition").textContent = edition + " v0.1 | build " + manifest.build_id + " | " + UI.fmtTime(manifest.built_at);
  }

  function editionLabel(manifest) {
    var e = manifest && manifest.page && manifest.page.edition;
    return e && typeof e.label === "string" && e.label ? e.label : null;
  }

  /* The edition in the header: the badge, the sentence under the header, the attribute the style sheet reads (the edition line is shown on a phone for the demo). */
  function buildEdition(manifest) {
    document.documentElement.setAttribute("data-edition", editionLabel(manifest) ? String(manifest.edition || "") : "");
    UI.editionBadge($("demo-badge"), manifest);
    UI.editionNote($("demo-note"), manifest);
  }

  /* Inside a frame (the framing page on the firm's own site) the page offers "Open full screen": the page itself in a new tab. The page never tries to leave the frame. */
  function buildFrameLink(manifest) {
    var seo = manifest.page && manifest.page.seo, base = seo && typeof seo.base_url === "string" ? seo.base_url : null;
    UI.frameLink($("frame-link"), UI.isFramed(window), base || String(window.location.href).split("#")[0]);
  }

  function wireChrome(manifest) {
    $("panel-toggle").addEventListener("click", function () { setPanel(!$("panel").classList.contains("open")); });
    $("about-btn").addEventListener("click", function () { openDrawer("About this edition", UI.aboutBody(manifest), $("about-btn")); });
    $("drawer-close").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") { return; }
      if (!$("drawer").hidden) { closeDrawer(); } else if (isSmall()) { setPanel(false); }
    });
  }

  // ------------------------------------------------------------------ start
  /* One part of the page that fails to build is reported by name (the detail goes to __atlas.errors) and the rest of the page carries on. */
  function step(name, build) {
    try { build(); } catch (error) {
      S.errors.push(name + ": " + String(error && error.message));
      UI.notice($("notices"), "The " + name + " could not be built. The rest of the page is still usable.", "bad");
    }
  }

  /* The map measured its box when it was made. The notice strips, the edition line and the footer came after it and took height from it, and Leaflet keeps the size it measured: so
   * measure again and fit Romania to the box the map really has. Later changes of the box (the sources list of the footer opened, a phone turned) are followed by a size observer. */
  function fitMap() {
    S.map.invalidateSize({ animate: false });
    S.map.fitBounds(RO_BOUNDS);
    if (typeof ResizeObserver === "function") { new ResizeObserver(function () { S.map.invalidateSize({ animate: false }); }).observe($("map")); }
  }

  function start(manifest) {
    S.manifest = manifest;
    step("theme switch", initTheme);
    initMap(manifest);                                  // without a map there is nothing to show: a failure here is the "could not finish starting" case
    step("layer panel", function () { buildPanel(manifest); });
    step("footer", function () { buildFooter(manifest); });
    step("edition label", function () { buildEdition(manifest); });
    step("full screen link", function () { buildFrameLink(manifest); });
    step("notice strip", function () { buildStrip(manifest); });
    step("page controls", function () { wireChrome(manifest); });
    step("map size", fitMap);
    step("theme switch", themeChanged);
    var ids = hooks.layerIds();
    var first = ids.filter(function (id) { return layer(id).entry.default_on; });
    var rest = ids.filter(function (id) { return !layer(id).entry.default_on; });
    var settle = function (id) { return loadLayer(layer(id)).then(function (state) { return state.whenComplete; }); };
    /* Every layer is settled on its own: a layer that fails to load is reported (notice and card) and the others are still drawn and still loaded. */
    var firstFrames = null;                              // resolves once the first layers have been on screen for two frames (firstUsefulMs is read there)
    return Lib.settleAll(first.map(function (id) { return loadLayer(layer(id)); })).then(function (results) {
      S.starting = true;
      first.forEach(function (id, i) { if (results[i].ok) { showSafely(layer(id)); } });
      S.starting = false;
      firstFrames = new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(function () { hooks.firstUsefulMs = performance.now(); resolve(); }); });
        setTimeout(resolve, 2000);                       // a tab in the background runs no frames: the page is still reported ready
      });
      return Lib.settleAll(first.map(function (id, i) { return results[i].ok ? settle(id) : null; }));
    }).then(function () {
      return rest.reduce(function (chain, id) { return chain.then(function () { return Lib.settleAll([settle(id)]); }); }, Promise.resolve());
    }).then(function () {
      return firstFrames;                                // ready never comes before the first useful time has been measured
    }).then(function () {
      hooks.ready = true;
    });
  }

  /* Two different failures: the manifest could not be fetched or parsed (second argument of the first then), or the page failed while starting from a manifest
   * it did load (the final catch). The visible text says which, and never shows an internal error message; the detail goes to __atlas.errors. */
  fetch("data/manifest.json", { cache: "no-cache" }).then(function (res) {
    if (!res.ok) { throw new Error("manifest answered HTTP " + res.status); }
    return res.json();
  }).then(function (manifest) { return { manifest: manifest }; }, function (error) {
    UI.notice($("notices"), "The atlas could not load its manifest (" + (error && /HTTP \d+/.test(error.message) ? error.message.replace("manifest answered ", "") : "the file is missing or damaged") + "). Reload the page; if it persists the build is incomplete.", "bad");
    S.errors.push("manifest: " + String(error && error.message));
    hooks.ready = true;
    return null;
  }).then(function (loaded) {
    return loaded ? start(loaded.manifest) : null;
  }).catch(function (error) {
    UI.notice($("notices"), "The atlas could not finish starting. Reload the page; if it persists the build is incomplete.", "bad");
    S.errors.push("start: " + String(error && error.message));
    hooks.ready = true;
  });
})();
