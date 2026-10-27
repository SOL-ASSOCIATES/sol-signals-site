/* render_assets.js - renderers for the manifest kinds "lines", "points" and "outline". Renderers for the other kinds ("cells", "raster", "panel" and "choropleth")
 * register in the same registry, window.AtlasRenderers, keyed by the manifest kind.
 *
 * Renderer contract (all functions optional unless marked):
 *   load(entry, ctx) -> Promise<state>   [required] fetch the data; state.whenComplete (a Promise) may hold background loading
 *   show(entry, state, ctx) / hide(entry, state, ctx)   [required] add / remove the layer on the map
 *   counts(entry, state) -> {category: n}   [required] the numbers the legend shows, counted from the loaded data (must equal entry.counts)
 *   legend(entry, state, ctx) -> {rows, note}   [required] rows for AtlasUI.legend
 *   rank(entry) -> number    draw order on the shared canvas (lower is drawn first)
 *   front(entry, state, ctx) bring the layer's objects to the front of the canvas
 *   restyle(entry, state, ctx) after a theme change;  onZoom(entry, state, ctx) after a zoom change
 *   info(entry, state, ctx) -> object   what is drawn right now (merged into __atlas.info(id), used by the checks)
 *   describe(entry, state, index, ctx) -> {el, latlng}   popup content for the feature at index (used by __atlas.openPopup)
 *   complete(state) -> boolean   false skips the count check (the layer drew nothing, e.g. an out-of-date forecast);
 *   state.unavailable = "text" makes the page switch the layer off and show the text (see atlas.js markUnavailable)
 * legend() may also return {extra: node} and {after: node}: nodes the renderer keeps (controls, a chart / a table) that stay above / below the rows while the rows are rebuilt.
 * The lines and points are NOT one Leaflet object per feature: each layer is one path on the shared canvas (canvas_assets.js) that draws its features itself from typed
 * arrays (draw_core.js), skipping everything outside the area being redrawn. info(id).drawn is what the layer has on the map (all of its features); info(id).painted is
 * what the last full redraw really put on the canvas, which is less when the view shows only part of the country.
 * ctx: {map, renderers: {assets (shared canvas), outlines (country fill), boundaries (county lines, above everything, no pointer events)}, pal(cssVar), dark() -> boolean,
 *   hooks (window.__atlas), fetchJson(url), assetUrl(url) (adds the build id), showPopup(el, latlng), flush(), restack(rank), basemapOn, refreshLegend(id),
 *   entries(kind) (the manifest entries of a kind), isOn(id), setOn(id, on), loadLayer(id) -> Promise<state of another layer> (the ATR layer reads the county outlines this way)} */
(function () {
  "use strict";
  var L = window.L, Lib = window.AtlasLib, UI = window.AtlasUI, Draw = window.AtlasDraw, Canvas = window.AtlasCanvas, Sched = window.AtlasScheduler;
  var R = (window.AtlasRenderers = window.AtlasRenderers || {});

  var LOD_ZOOM = Draw.LOD_ZOOM;                       // lines: coarse file below this zoom, detailed file from it
  var CLICK_PIXELS = 5;                               // how far from a drawn object a click still counts, on top of half its stroke
  var FUEL_NAMES = Lib.FUEL_NAMES;                    // shared with the production panel
  var VOLT_NAMES = Lib.VOLTAGE_NAMES;
  var VOLT_SUB = { other: "listed, but not 750/400/220/110 kV" };
  var STATUS_NAMES = { as_mapped: "As mapped", construction: "Under construction", proposed: "Proposed", disused: "Disused" };
  var KIND_NAMES = { line: "Line", minor_line: "Minor line", cable: "Cable" };
  var BASIS_NAMES = { plant_tag: "plant output tag", sum_generators: "sum of its generators" };
  var LINE_WEIGHT = { "750": 2.8, "400": 2.4, "220": 1.9, "110": 1.3, other: 0.9, unknown: 1.1 };
  var LOW_CLASSES = { "750": 1, "400": 1, "220": 1, unknown: 1 };
  var SUB_HALF = { "750": 5.5, "400": 5, "220": 4.5, "110": 3.6, other: 2.8, unknown: 2.8 };
  var RANK = { assets_lines: 0, assets_substations: 1, assets_generators_unassigned: 2, assets_plants: 3 };

  function cap(text) { return text.charAt(0).toUpperCase() + text.slice(1); }
  function totalOf(counts) { return Object.keys(counts).reduce(function (n, key) { return n + counts[key]; }, 0); }
  function titleOf(props, tags) { return Lib.hasLatin(props.name) ? props.name.trim() : cap(Lib.genericLabel(tags)); }
  function link(props, tags, osmId) {
    return [{ href: Lib.gmapsLink(tags), text: "Find on Google Maps" }, { href: Lib.osmUrl(osmId), text: "View on OpenStreetMap" }];
  }
  function onMap(ctx, path) { return !!path && ctx.map.hasLayer(path); }
  function latlngOf(feature) { var c = feature.geometry.coordinates; return L.latLng(c[1], c[0]); }

  // ------------------------------------------------------------------ lines
  function linePopup(props) {
    var tags = { name: props.name, county: props.county, kind: props.kind, kv: Lib.maxKv(props.voltages_kv) };
    return UI.popupBox(titleOf(props, tags), "Power line, OpenStreetMap", [["Voltage", Lib.voltageText(props.voltages_kv)], ["Type", KIND_NAMES[props.kind]],
      ["Operator", props.operator], ["Status", STATUS_NAMES[props.status]], ["County", props.county]], link(props, tags, props.id));
  }
  function classOfProps(props) { return props.voltage_class; }
  function classOfFeature(feature) { return feature.properties.voltage_class; }
  function midpoint(feature) { var c = feature.geometry.coordinates[Math.floor(feature.geometry.coordinates.length / 2)]; return L.latLng(c[1], c[0]); }

  /* The set drawn at a zoom: the detailed lines from LOD_ZOOM once they are built, else the coarse ones. Never nothing: a layer is not blank while the detail is still being built. */
  function lodAt(state, zoom) { return Draw.lodFor(zoom, !!state.sets.high); }

  /* The style of a class for the draw loop, or null for a class that is hidden. */
  function lineStyleFor(state, ctx) {
    return function (cls) {
      if (cls === "unknown" && !state.unknownOn) { return null; }
      return { color: ctx.pal("--v" + cls), width: LINE_WEIGHT[cls], alpha: cls === "other" ? 0.8 : 0.92, dash: cls === "unknown" ? [5, 4] : null };
    };
  }

  function linesImpl(entry, state, ctx) {
    var style = lineStyleFor(state, ctx);
    var tolerance = function (cls) { return cls === "unknown" && !state.unknownOn ? null : LINE_WEIGHT[cls] / 2 + CLICK_PIXELS; };
    return {
      margin: 6,
      box: function () { return state.sets.low && state.sets.low.box; },
      paint: function (g, view) {
        var out = Draw.paintLines(g, state.sets[lodAt(state, view.z)], view, style);
        if (view.full) { state.painted = out; }
      },
      hit: function (view, x, y) {
        var lod = lodAt(state, view.z), found = Draw.hitLines(state.sets[lod], view, x, y, tolerance);
        state.hit = found ? { lod: lod, feature: found.feature } : null;
        return !!found;
      }
    };
  }

  /* The detailed lines are converted to drawing arrays in idle time, a few milliseconds at a time (never on the zoom that first needs them). The coarse lines are drawn
   * until then. The job pauses while the layer is hidden and continues when it is shown again. */
  function startBuild(entry, state, ctx) {
    if (state.sets.high || !state.high || state.highFailed) { return; }                 // nothing to build, built already, or a build that failed once: not tried again
    if (!state.job) {
      var builder;
      try { builder = Draw.lineBuilder(state.high.features, classOfProps); } catch (error) { buildFailed(entry, state, ctx); return; }          // the first pass reads every feature
      state.job = Sched.run({
        name: "lines-detail", priority: 1,
        step: function (deadline, now) { return builder.step(deadline, now); },
        onDone: function () { state.sets.high = builder.result(); state.job = null; builtLines(entry, state, ctx); },
        onError: function () { state.job = null; buildFailed(entry, state, ctx); }
      });
    } else { state.job.resume(); }
  }
  /* The detail cannot be built: the coarse lines stay, the legend says so, and nothing waits for it. */
  function buildFailed(entry, state, ctx) {
    state.highFailed = true;
    releaseWaiters(state);
    ctx.refreshLegend(entry.id);
  }
  function releaseWaiters(state) {
    var waiting = state.waiting;
    state.waiting = [];
    waiting.forEach(function (resolve) { resolve(state); });
  }
  function builtLines(entry, state, ctx) {
    syncLod(entry, state, ctx);
    if (onMap(ctx, state.path)) { state.path.redraw(); }
    releaseWaiters(state);
  }
  /* Keeps state.lod (what the legend says) in step with the zoom; returns true when it changed. */
  function syncLod(entry, state, ctx) {
    var want = lodAt(state, ctx.map.getZoom());
    if (want === state.lod) { return false; }
    state.lod = want;
    ctx.refreshLegend(entry.id);
    return true;
  }

  R.lines = {
    rank: function () { return RANK.assets_lines; },
    load: function (entry, ctx) {
      return ctx.fetchJson(entry.files.low).then(function (low) {
        var state = { low: low, high: null, sets: { low: Draw.buildLines(low.features, classOfProps), high: null }, path: null, job: null, waiting: [], shown: false,
          unknownOn: true, lod: "low", painted: { parts: 0, classes: [] }, hit: null };
        state.whenComplete = ctx.fetchJson(entry.files.high).then(function (high) {
          state.high = high;
          ctx.refreshLegend(entry.id);
          if (!state.shown) { return state; }                                   // hidden: the detail is built when the layer is first shown
          return new Promise(function (resolve) { state.waiting.push(resolve); startBuild(entry, state, ctx); });
        }, function (error) {
          state.highFailed = true;                       // the coarse lines stay on the map; the legend says the detailed file is missing
          ctx.refreshLegend(entry.id);
          throw error;
        });
        return state;
      });
    },
    show: function (entry, state, ctx) {
      if (!state.path) {
        state.path = Canvas.path(ctx.renderers.assets, linesImpl(entry, state, ctx));
        state.path.on("click", function (ev) {
          var hit = state.hit;
          if (hit) { ctx.showPopup(linePopup(state[hit.lod].features[hit.feature].properties), ev.latlng); }
        });
      }
      state.shown = true;
      startBuild(entry, state, ctx);
      syncLod(entry, state, ctx);
      ctx.map.addLayer(state.path);
      ctx.restack(R.lines.rank());
    },
    hide: function (entry, state, ctx) {
      state.shown = false;
      if (state.job) { state.job.cancel(); }
      releaseWaiters(state);                             // the page must not wait for a detail nobody is looking at
      if (state.path) { ctx.map.removeLayer(state.path); }
    },
    onZoom: function (entry, state, ctx) { syncLod(entry, state, ctx); },
    front: function (entry, state, ctx) { if (onMap(ctx, state.path)) { state.path.bringToFront(); } },
    restyle: function (entry, state, ctx) { if (onMap(ctx, state.path)) { state.path.redraw(); } },
    info: function (entry, state, ctx) {
      var lod = lodAt(state, ctx.map.getZoom()), drawn = [];
      if (onMap(ctx, state.path)) { state.sets[lod].classes.forEach(function (c) { if (c.cls !== "unknown" || state.unknownOn) { drawn.push(c.cls); } }); }
      return { lod: lod, drawnClasses: drawn, features: (state[lod] || state.low).features.length, highLoaded: !!state.high, highBuilt: !!state.sets.high,
        painted: state.painted.parts, paintedClasses: state.painted.classes.slice() };
    },
    counts: function (entry, state) {
      return Lib.categoryCounts((state.high || state.low).features, classOfFeature, entry.categories);
    },
    legend: function (entry, state, ctx) {
      var counts = R.lines.counts(entry, state);
      var rows = entry.categories.map(function (cls) {
        var row = { key: cls, label: VOLT_NAMES[cls], count: counts[cls], notMapped: Lib.notMapped(entry, cls, counts[cls]), sub: VOLT_SUB[cls] || null, swatch: { shape: "line", c: "var(--v" + cls + ")", w: Math.max(1.5, LINE_WEIGHT[cls]), dash: cls === "unknown" } };
        if (!LOW_CLASSES[cls] && state.lod === "low") { row.sub = "from zoom " + LOD_ZOOM; }
        if (cls === "unknown") {
          row.toggle = { checked: state.unknownOn, aria: "Show lines with unknown voltage", onChange: function (on) { state.unknownOn = on; if (onMap(ctx, state.path)) { state.path.redraw(); } ctx.flush(); } };
        }
        return row;
      });
      var note = state.highFailed ? "The detailed lines are not available (the file could not be loaded or read): only the coarse lines are drawn."
        : state.high ? "Detailed geometry from zoom " + LOD_ZOOM + ", coarse below." : "Loading the detailed line file.";
      var count = state.high ? Lib.featureCountText(entry.id, totalOf(counts)) : null;                  // the whole layer is counted once the detailed file is in
      return { rows: rows, note: (count ? count + ". " : "") + note };
    },
    describe: function (entry, state, index) {
      var f = (state.high || state.low).features[index];
      return { el: linePopup(f.properties), latlng: midpoint(f) };
    }
  };

  // ------------------------------------------------------------------ points (plants, generators outside a plant, substations)
  function isSubstation(entry) { return entry.id === "assets_substations"; }
  function keyOf(entry) { return isSubstation(entry) ? "voltage_class" : "fuel"; }

  function baseRadius(entry, props) {
    if (isSubstation(entry)) { return SUB_HALF[props.voltage_class] || 3; }
    var r = Lib.plantRadius(props.mw);
    return entry.id === "assets_generators_unassigned" ? Math.max(2.5, r * 0.55) : r;
  }
  function isHollow(entry, props) { return isSubstation(entry) ? props.voltage_class === "unknown" : (props.mw === null || props.mw === undefined || props.fuel === "unknown"); }

  /* A marker look is a variant: the legend category (voltage class or fuel) times filled or hollow. */
  function variantOf(entry) {
    var cats = entry.categories, key = keyOf(entry), fallback = Math.max(0, cats.indexOf("unknown"));
    return function (props) {
      var at = cats.indexOf(props[key]);
      return (at < 0 ? fallback : at) * 2 + (isHollow(entry, props) ? 1 : 0);
    };
  }

  /* How a variant is drawn, as the sprite cache needs it (the same look the page has always had): filled markers have a thin outline, hollow ones a ring of the
   * category colour, and a hollow circle also a light casing so it reads over any ground. */
  function describeVariant(entry, ctx) {
    var sub = isSubstation(entry);
    return function (variant, ring) {
      var cat = entry.categories[variant >> 1], hollow = (variant & 1) === 1, colour = ctx.pal((sub ? "--v" : "--f-") + cat), outline = ctx.pal("--marker-outline");
      if (hollow) {
        return { shape: sub ? "square" : "circle", fill: null, color: colour, weight: sub ? 1.6 : ring, opacity: 1, ring: !sub,
          casing: sub ? null : { color: outline, weight: ring + 2.4, opacity: 0.85 } };
      }
      return { shape: sub ? "square" : "circle", fill: colour, fillOpacity: sub ? 0.95 : 0.72, color: outline, weight: 1, opacity: 0.9, casing: null };
    };
  }

  function pointPopup(entry, props) {
    var gm = { name: props.name, county: props.county };
    if (isSubstation(entry)) {
      gm.kind = "substation";
      return UI.popupBox(titleOf(props, gm), "Substation, OpenStreetMap", [["Voltage", Lib.voltageText(props.voltages_kv)], ["Class", VOLT_NAMES[props.voltage_class]],
        ["Operator", props.operator], ["Status", STATUS_NAMES[props.status]], ["County", props.county]], link(props, gm, props.id));
    }
    gm.fuel = props.fuel;
    if (entry.id === "assets_generators_unassigned") { gm.kind = "generator"; }
    var basis = props.mw_basis && BASIS_NAMES[props.mw_basis] ? " (" + BASIS_NAMES[props.mw_basis] + ")" : "";
    var what = entry.id === "assets_plants" ? "Power plant, OpenStreetMap" : "Generator not assigned to a plant, OpenStreetMap";
    return UI.popupBox(titleOf(props, gm), what, [["Output", Lib.formatMw(props.mw) + (props.mw === null || props.mw === undefined ? "" : basis)], ["Fuel", FUEL_NAMES[props.fuel]],
      ["Generators", props.n_generators > 0 ? props.n_generators : null], ["Operator", props.operator], ["Status", STATUS_NAMES[props.status]], ["County", props.county]], link(props, gm, props.id));
  }

  /* How far beyond its radius a marker is clicked, by variant: the renderer's 5 px plus half the weight of the marker's stroke (a filled marker's outline is 1 px, a hollow
   * circle's ring is the ring weight of the zoom, a hollow square's 1.6 px), as it was when each marker was a Leaflet circle marker. */
  var extrasByRing = {};
  function clickExtras(entry, ring) {
    var key = entry.id + ":" + entry.categories.length + ":" + ring;
    if (!extrasByRing[key]) {
      var sub = isSubstation(entry), list = [];
      for (var v = 0; v < entry.categories.length * 2; v++) { list.push(CLICK_PIXELS + ((v & 1) === 1 ? (sub ? 1.6 : ring) : 1) / 2); }
      extrasByRing[key] = list;
    }
    return extrasByRing[key];
  }

  function pointsImpl(entry, state, ctx) {
    return {
      margin: 50,                                        // the biggest marker (46 px at the highest zoom) and its sprite padding
      box: function () { return state.set.box; },
      paint: function (g, view) {
        var zs = Draw.zoomScale(view.z);
        state.sprites.setRing(Draw.ringWeight(zs));
        var painted = Draw.paintPoints(g, state.set, view, zs, state.spriteOf);
        if (view.full) { state.painted = painted; }
      },
      hit: function (view, x, y) {
        var zs = Draw.zoomScale(view.z);
        state.hit = Draw.hitPoints(state.set, view, x, y, clickExtras(entry, Draw.ringWeight(zs)), zs);
        return state.hit >= 0;
      }
    };
  }

  R.points = {
    rank: function (entry) { return RANK[entry.id]; },
    load: function (entry, ctx) {
      return ctx.fetchJson(entry.files.data).then(function (fc) {
        var sprites = Canvas.sprites(describeVariant(entry, ctx));
        var set = Draw.buildPoints(fc.features, { variantOf: variantOf(entry), radiusOf: function (props) { return baseRadius(entry, props); } });
        return { fc: fc, set: set, sprites: sprites, spriteOf: function (variant, r) { return sprites.get(variant, r); }, path: null, shown: false, painted: 0, hit: -1 };
      });
    },
    show: function (entry, state, ctx) {
      if (!state.path) {
        state.path = Canvas.path(ctx.renderers.assets, pointsImpl(entry, state, ctx));
        state.path.on("click", function () {
          if (state.hit >= 0) { var f = state.fc.features[state.hit]; ctx.showPopup(pointPopup(entry, f.properties), latlngOf(f)); }
        });
      }
      ctx.map.addLayer(state.path);
      state.shown = true;
      ctx.restack(R.points.rank(entry));
    },
    hide: function (entry, state, ctx) {
      if (state.path) { ctx.map.removeLayer(state.path); }
      state.shown = false;
    },
    info: function (entry, state, ctx) {
      return { drawn: onMap(ctx, state.path) ? state.set.n : 0, features: state.fc.features.length, painted: state.painted };
    },
    front: function (entry, state, ctx) { if (onMap(ctx, state.path)) { state.path.bringToFront(); } },
    restyle: function (entry, state, ctx) {
      state.sprites.reset();
      if (onMap(ctx, state.path)) { state.path.redraw(); }
    },
    counts: function (entry, state) {
      return Lib.categoryCounts(state.fc.features, function (f) { return f.properties[keyOf(entry)]; }, entry.categories);
    },
    legend: function (entry, state) {
      var counts = R.points.counts(entry, state), sub = isSubstation(entry);
      var rows = entry.categories.map(function (cat) {
        var colour = "var(" + (sub ? "--v" : "--f-") + cat + ")";
        return { key: cat, label: sub ? VOLT_NAMES[cat] : FUEL_NAMES[cat], sub: sub ? VOLT_SUB[cat] || null : null, count: counts[cat], notMapped: Lib.notMapped(entry, cat, counts[cat]),
          swatch: { shape: sub ? "square" : "circle", c: colour, hollow: cat === "unknown", s: sub ? 8 + Math.min(4, (SUB_HALF[cat] || 3) / 2) : 13 } };
      });
      var note = sub ? "Square size grows with voltage. A hollow square means the voltage is not stated."
        : entry.id === "assets_plants" ? Lib.PLANT_SIZE_NOTE
          : "Small circles. A hollow ring means the output or the fuel is not stated.";
      var count = Lib.featureCountText(entry.id, totalOf(counts));                                       // how many features OpenStreetMap holds in this snapshot, worded as that
      return { rows: rows, note: (count ? count + ". " : "") + note };
    },
    describe: function (entry, state, index) {
      var f = state.fc.features[index];
      return { el: pointPopup(entry, f.properties), latlng: latlngOf(f) };
    }
  };

  // ------------------------------------------------------------------ outline (country, counties)
  /* The polygons are static and not clickable, so each outline layer is one path on its own canvas that draws the rings straight from typed arrays (see draw_core.js);
   * the country boundary also fills the land with the page ground when there is no base map. */
  function outlineStyleFor(entry, ctx) {
    var country = entry.id === "country";
    return function () {
      return { fill: country && !ctx.basemapOn ? { color: ctx.pal("--bg"), alpha: 1 } : null,
        stroke: { color: ctx.pal(country ? "--outline-country" : "--outline-county"), width: country ? 1.6 : 0.9, alpha: 0.95 } };
    };
  }

  R.outline = {
    rank: function (entry) { return entry.id === "country" ? 0 : 1; },
    load: function (entry, ctx) {
      return ctx.fetchJson(entry.files.data).then(function (fc) { return { fc: fc, set: Draw.buildRings(fc.features), path: null, painted: 0 }; });
    },
    show: function (entry, state, ctx) {
      if (!state.path) {
        var style = outlineStyleFor(entry, ctx), country = entry.id === "country";
        state.path = Canvas.path(country ? ctx.renderers.outlines : ctx.renderers.boundaries, {
          margin: 2, box: function () { return state.set.bounds; }, hit: function () { return false; },
          paint: function (g, view) { var n = Draw.paintRings(g, state.set, view, style()); if (view.full) { state.painted = n; } }
        }, { interactive: false });
      }
      ctx.map.addLayer(state.path);
    },
    hide: function (entry, state, ctx) { if (state.path) { ctx.map.removeLayer(state.path); } },
    restyle: function (entry, state, ctx) { if (onMap(ctx, state.path)) { state.path.redraw(); } },
    info: function (entry, state, ctx) { return { drawn: onMap(ctx, state.path) ? state.fc.features.length : 0, features: state.fc.features.length, painted: state.painted }; },
    counts: function (entry, state) { return { features: state.fc.features.length }; },
    legend: function (entry, state) {
      var country = entry.id === "country";
      return { rows: [{ key: "features", label: country ? "Country boundary" : "County boundary", sub: country ? null : "OSM admin level 4", count: state.fc.features.length,
        swatch: { shape: "outline", c: "var(" + (country ? "--outline-country" : "--outline-county") + ")", w: country ? 2 : 1 } }], note: null };
    }
  };
})();
