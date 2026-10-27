/* render_atr.js - renderer for the manifest kind "choropleth": the ATR layer, listed capacity by county at the date a source list was published.
 * The county outlines come from the county layer the page has already loaded (ctx.loadLayer("counties")); the figures come from the layer's own aggregate object.
 * Two colour modes: "mw" (fixed MW classes, the same breaks for every snapshot) and "bands" (each county by its dominant date band of the ATR issue date).
 * Filters (technology, status, operator) recompute every county from the released cells with AtlasLib.aggregateCounty. Counties whose detail is withheld are hatched.
 * The fills are polygons on the shared canvas, sent in front of the weather cells and behind the lines and points (they never hide a marker); the county lines stay in
 * their own pane above everything. A click or Enter (from the table) opens a text-only popup. Nothing about the ATR texts is written here: banner, source, legend title,
 * band labels and the band note come from the data object (see atr_ui.js for the interface wording).
 * Hooks on window.__atlas: setAtrMode("mw" | "bands") (shared by every snapshot), setAtrFilters({technology, status, operator}) (the snapshot that is on).
 * legendCounts(id) is always the bundler's definition (counties per dominant band plus the suppressed counties, no filter), whatever the mode: in "mw" mode the legend
 * rows count counties per MW class, in "bands" mode per dominant band under the current filters; with no filter the bands rows equal the manifest counts. */
(function () {
  "use strict";
  var L = window.L, Lib = window.AtlasLib, UI = window.AtlasUI, Ui = window.AtlasAtrUi;
  var R = (window.AtlasRenderers = window.AtlasRenderers || {});

  var MODES = ["mw", "bands"], FILTER_NAMES = ["technology", "status", "operator"];
  var FILL_OPACITY = 0.78;                              // over a base map; on the neutral ground the fills are opaque so they match the legend swatches
  var MIN_OPACITY = 0.2;                                // the opacity slider never makes the fills invisible
  var instances = [], shared = { mode: "mw" };          // one entry per loaded ATR snapshot; the colour mode is shared, the filters are each snapshot's own

  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function noFilters() { return { technology: null, status: null, operator: null }; }
  function isFiltered(f) { return !!(f.technology || f.status || f.operator); }

  // ------------------------------------------------------------------ geometry
  /* Leaflet lat/lng rings of a GeoJSON Polygon or MultiPolygon, or null. */
  function latlngsOf(feature) {
    var g = feature && feature.geometry;
    if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon") || !Array.isArray(g.coordinates)) { return null; }
    var rings = function (poly) { return poly.map(function (ring) { return ring.map(function (c) { return [c[1], c[0]]; }); }); };
    return g.type === "Polygon" ? rings(g.coordinates) : g.coordinates.map(rings);
  }

  // ------------------------------------------------------------------ colours and styles
  /* How a county is drawn: "fill" (a colour of the current mode), "hatch" (detail withheld in this edition), "dots" (a filter is set and nothing of the county matches it: not
   * low capacity, a state of its own) or "outline" (an outline with no ATR data: no fill at all). Shapes differ as well as colours, so no state rests on colour alone. */
  function kindOf(state, name) {
    if (!own(state.obj.counties, name)) { return "outline"; }
    if (state.obj.counties[name].suppressed === true) { return "hatch"; }
    return isFiltered(state.filters) && !state.aggs[name].mw ? "dots" : "fill";
  }

  /* The fill colour of a county drawn as "fill": the MW class, or the dominant date band (neutral when it has no dated detail released). */
  function fillFor(state, ctx, name) {
    var dark = ctx.dark(), agg = state.aggs[name];
    if (state.mode === "bands") {
      var band = Lib.dominantCohort(agg.by_cohort);
      return band ? Lib.cohortColour(band, dark) : Lib.atrNeutral(dark);
    }
    return Lib.atrMwColour(agg.mw, dark);
  }

  /* An 8 px canvas pattern, "hatch" (diagonal lines) or "dots", per theme and cached, or null when the browser gives no 2d context: the county then keeps its dashed
   * (hatch) or dotted (dots) outline. Both are drawn in --ink-3 on --panel-2, at least 3:1 against every ground of both themes. */
  function patternFor(state, ctx, kind) {
    var key = kind + ":" + (ctx.dark() ? "dark" : "light");
    if (state.patterns[key] !== undefined) { return state.patterns[key]; }
    var pattern = null;
    try {
      var canvas = document.createElement("canvas");
      canvas.width = 8; canvas.height = 8;
      var g = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
      if (g && typeof g.createPattern === "function") {
        g.fillStyle = ctx.pal("--panel-2"); g.fillRect(0, 0, 8, 8);
        g.strokeStyle = ctx.pal("--ink-3"); g.fillStyle = ctx.pal("--ink-3"); g.lineWidth = 1.3; g.beginPath();
        if (kind === "dots") {
          [[2, 2], [6, 6]].forEach(function (c) { g.moveTo(c[0] + 1.2, c[1]); g.arc(c[0], c[1], 1.2, 0, 2 * Math.PI); });
          g.fill();
        } else {
          [[0, 8, 8, 0], [-2, 2, 2, -2], [6, 10, 10, 6]].forEach(function (s) { g.moveTo(s[0], s[1]); g.lineTo(s[2], s[3]); });
          g.stroke();
        }
        pattern = g.createPattern(canvas, "repeat");
      }
    } catch (e) { pattern = null; }
    state.patterns[key] = pattern;
    return pattern;
  }

  function styleFor(state, ctx, name) {
    var kind = kindOf(state, name), opacity = state.opacity;
    if (kind === "fill") { return { fill: true, fillColor: fillFor(state, ctx, name), fillOpacity: opacity, stroke: false, weight: 0, dashArray: null }; }
    if (kind === "outline") {                                       // still a filled path (so it takes clicks), drawn with no fill: only a solid outline
      return { fill: true, fillColor: ctx.pal("--bg"), fillOpacity: 0, stroke: true, color: ctx.pal("--ink-2"), weight: 1.6, opacity: 0.95, dashArray: null };
    }
    var pattern = patternFor(state, ctx, kind);
    if (kind === "hatch") { return { fill: true, fillColor: pattern || ctx.pal("--panel-2"), fillOpacity: opacity, stroke: true, color: ctx.pal("--ink-3"), weight: 1.3, opacity: 0.9, dashArray: "4 3" }; }
    return { fill: true, fillColor: pattern || ctx.pal("--panel-2"), fillOpacity: opacity, stroke: !pattern, color: ctx.pal("--ink-3"), weight: 1.3, opacity: 0.9, dashArray: pattern ? null : "1 4" };
  }
  function restyleAll(state, ctx) { Object.keys(state.polys).forEach(function (name) { state.polys[name].setStyle(styleFor(state, ctx, name)); }); }

  // ------------------------------------------------------------------ the data under the filters
  function computeAggs(state) {
    Object.keys(state.obj.counties).forEach(function (name) { state.aggs[name] = Lib.aggregateCounty(state.obj.counties[name], state.filters); });
    state.unknownAgg = Lib.aggregateCounty(state.obj.unknown_county, state.filters);
  }

  function legendRows(state, ctx) {
    var obj = state.obj, dark = ctx.dark(), names = Object.keys(obj.counties), rows, counts, none = 0, suppressed = 0, nomatch = 0, filtered = isFiltered(state.filters);
    var square = function (c) { return { shape: "square", c: c, s: 14 }; };
    var open = names.filter(function (n) { if (obj.counties[n].suppressed === true) { suppressed += 1; return false; } return true; });
    if (state.mode === "mw") {
      counts = Lib.ATR_BREAKS.map(function () { return 0; });
      open.forEach(function (n) { if (filtered && !state.aggs[n].mw) { nomatch += 1; } else { counts[Lib.atrMwClass(state.aggs[n].mw)] += 1; } });
      rows = Lib.atrClassLabels().map(function (label, i) { return { key: "class" + i, label: label, count: counts[i], swatch: square(Lib.atrMwColour(Lib.ATR_BREAKS[i], dark)) }; });
    } else {
      counts = {};
      Lib.ATR_COHORTS.forEach(function (id) { counts[id] = 0; });
      open.forEach(function (n) {
        if (filtered && !state.aggs[n].mw) { nomatch += 1; return; }                // nothing matches the filters: its own row, never "no dated detail released"
        var band = Lib.dominantCohort(state.aggs[n].by_cohort);
        if (band) { counts[band] += 1; } else { none += 1; }
      });
      rows = Lib.ATR_COHORTS.map(function (id) {
        var unassessed = id === "date_conflicted" && !obj.totals.conflict_assessed;
        var empty = !unassessed && !counts[id] && Ui.emptyByConstruction(obj, id);                 // the last band of a list published before its boundary: empty by construction, not a measured nothing
        return { key: id, label: obj.cohort_labels[id], count: unassessed ? Ui.NOT_ASSESSED : (empty ? Ui.EMPTY_BY_CONSTRUCTION : counts[id]), swatch: square(Lib.cohortColour(id, dark)) };
      });
      rows.push({ key: "none", label: Ui.NO_DATED_DETAIL, count: none, swatch: square(Lib.atrNeutral(dark)) });
    }
    if (filtered) { rows.push({ key: "nomatch", label: Ui.NO_MATCH_TEXT, count: nomatch, swatch: { shape: "dots" } }); }
    rows.push({ key: "suppressed", label: Ui.SUPPRESSED_TEXT, count: suppressed, swatch: { shape: "hatch" } });
    var noData = state.unmatched.in_outline_only.length;
    if (noData) { rows.push({ key: "nodata", label: "Outline without ATR data", count: noData, swatch: { shape: "outline", c: "var(--ink-2)", w: 2 } }); }
    return rows;
  }

  var NOTE_MW = "Colour classes are fixed MW breaks, the same for every list. A county with 0 MW is in the lowest class; a zero is not evidence that no ATR exists there. Under filters, a county with no ATR " +
    "matching them is dotted (No ATR matching the filters): it is not low capacity. Hatched counties have their detail withheld in this edition. Row counts are counties, for the filters set.";
  var NOTE_BANDS = "Each county is coloured by the date band with the most MW among its released detail. Merged detail has no band and never decides the colour, so open the popup for the " +
    "whole split. A county with no dated detail released is neutral; under filters, a county with no ATR matching them is dotted (No ATR matching the filters). Hatched counties have their " +
    "detail withheld in this edition. Row counts are counties, for the filters set.";

  // ------------------------------------------------------------------ the table and the side panel (data for atr_ui.js)
  function tableRows(state) {
    var obj = state.obj, collator = new Intl.Collator("ro"), sort = state.sort;
    var rows = Object.keys(obj.counties).map(function (name) {
      var suppressed = obj.counties[name].suppressed === true, agg = state.aggs[name], none = !suppressed && isFiltered(state.filters) && !agg.mw;
      var noAtr = !suppressed && !isFiltered(state.filters) && obj.counties[name].n === 0;            // a county of the list with n = 0: said in words, not as "0 MW"
      return { name: name, mw: suppressed ? null : agg.mw, mwText: suppressed ? "withheld" : (noAtr ? Ui.NO_ATR_TEXT : Lib.atrMwText(agg.mw)),
        band: suppressed ? Ui.SUPPRESSED_TEXT : (none ? Ui.NO_MATCH_TEXT : Ui.dominantLabel(obj, Lib.dominantCohort(agg.by_cohort))) + (state.polys[name] ? "" : " (no county outline)") };
    });
    rows.sort(function (a, b) {
      var c;
      if (sort.key === "mw") {
        if (a.mw === null || b.mw === null) { return a.mw === b.mw ? collator.compare(a.name, b.name) : (a.mw === null ? 1 : -1); }       // withheld counties are last, either way
        c = a.mw - b.mw;
      } else { c = collator.compare(a.name, b.name); }
      return (sort.dir === "desc" ? -c : c) || collator.compare(a.name, b.name);
    });
    return rows;
  }

  function viewOf(entry, state, ctx) {
    var obj = state.obj, t = obj.totals, filtered = isFiltered(state.filters), dataOnly = state.unmatched.in_data_only, outlineOnly = state.unmatched.in_outline_only;
    var extra = 0;
    dataOnly.forEach(function (n) { if (state.aggs[n].mw) { extra += state.aggs[n].mw; } });
    var group = obj.unknown_county.suppressed === true ? Ui.SUPPRESSED_TEXT : Lib.atrMwText(state.unknownAgg.mw);
    var records = function (n) { return typeof n === "number" ? " (" + n.toLocaleString("en-GB") + " ATR records)" : ""; };
    var unmatched = dataOnly.length + outlineOnly.length, coverage = Lib.atrCoverage(t);
    var shown = 0;                                                  // the MW of the published detail that matches the filters, wherever it is (counties, the unknown-county group)
    Object.keys(obj.counties).forEach(function (n) { if (state.aggs[n].mw) { shown += state.aggs[n].mw; } });
    if (obj.unknown_county.suppressed !== true && state.unknownAgg.mw) { shown += state.unknownAgg.mw; }
    var shownText = Lib.atrShownText(Math.round(shown * 10) / 10, t, filtered) || "";
    var rest = filtered || !ctx.page ? null : Lib.atrRemainder(obj, Math.round(shown * 10) / 10), notes = ctx.page && ctx.page.atr_notes ? ctx.page.atr_notes : {};            // about the whole list: not under filters, and only with the page text of the manifest
    var on = ctx.entries ? ctx.entries("choropleth").filter(function (e) { return ctx.isOn(e.id); }) : [];
    return {
      mode: state.mode, filters: state.filters, opacity: state.opacity, snapshot: on.length ? on[0].id : null, selected: state.selected, tableOpen: state.tableOpen, sort: state.sort,
      legendTitle: (state.mode === "bands" ? obj.cohort_legend_title : "ATR MW per county, fixed classes") + (filtered ? " (filters applied, released detail only)" : ""),
      side: [["Not mapped to a county", group + (extra > 0 ? "; counties without an outline: " + Lib.atrMwText(extra) : "")],
        ["Withheld in this edition", Lib.atrMwText(t.suppressed_mw) + records(t.suppressed_n)], ["All counties and groups", Lib.atrMwText(t.mw) + records(t.n)]],
      coverageText: coverage ? coverage.text : "", shownText: shownText, remainderText: rest ? rest + (typeof notes.limited === "string" && notes.limited ? " " + notes.limited : "") : "",
      announce: "Colouring counties by " + Ui.modeLabel(state.mode) + ". Filters: " + Ui.filterSummary(state.filters) + ". " + (shownText ? shownText + "." : ""),
      unmatchedText: unmatched ? unmatched + (unmatched === 1 ? " county" : " counties") + " not matched between the ATR data and the county outlines" +
        (dataOnly.length ? "; in the data only: " + dataOnly.join(", ") : "") + (outlineOnly.length ? "; in the outlines only: " + outlineOnly.join(", ") : "") + "." : "",
      rows: state.tableOpen ? tableRows(state) : []
    };
  }

  // ------------------------------------------------------------------ selection, popups, highlight
  function popupFor(state, name) {
    var known = own(state.obj.counties, name);
    return Ui.countyPopup(state.obj, name, known ? state.obj.counties[name] : undefined, known ? state.aggs[name] : null, isFiltered(state.filters));
  }
  function centreOf(state, ctx, name) { return state.polys[name] ? state.polys[name].getBounds().getCenter() : ctx.map.getCenter(); }

  /* One outline polygon in the top pane (no pointer events) marks the county under the pointer, or else the selected county. */
  function drawHighlight(state, ctx) {
    if (!state.shown) { return; }
    var name = state.hovered || state.selected, rings = name && state.rings[name];
    if (!rings) { if (state.highlight && ctx.map.hasLayer(state.highlight)) { ctx.map.removeLayer(state.highlight); } return; }
    if (!state.highlight) {
      state.highlight = L.polygon(rings, { renderer: ctx.renderers.boundaries, fill: false, color: ctx.pal("--ink"), weight: 2.6, opacity: 1, interactive: false, lineJoin: "round" });
    } else { state.highlight.setLatLngs(rings); }
    if (!ctx.map.hasLayer(state.highlight)) { ctx.map.addLayer(state.highlight); }
    ctx.flush();
  }

  /* Opens this layer's county popup. state.popupEl is what is in the popup: when another layer shows its own popup in the shared one ("atlaspopup" with another element) or
   * the viewer closes it ("popupclose"), the selection and its outline end (see show()). */
  function openPopup(state, ctx, name) {
    state.popupEl = popupFor(state, name);
    state.opening = true;
    try { ctx.showPopup(state.popupEl, state.selectedAt); } finally { state.opening = false; }
  }

  function select(entry, state, ctx, name, latlng, zoom) {
    state.selected = name;
    state.selectedAt = latlng || centreOf(state, ctx, name);
    drawHighlight(state, ctx);
    if (zoom && state.polys[name]) { ctx.map.fitBounds(state.polys[name].getBounds(), { padding: [24, 24], maxZoom: 9 }); }
    openPopup(state, ctx, name);
    if (state.tableOpen) { state.ui.update(viewOf(entry, state, ctx)); }
  }

  function endSelection(entry, state, ctx) {
    if (!state.selected) { return; }
    state.selected = null;
    state.popupEl = null;
    drawHighlight(state, ctx);
    state.ui.update(viewOf(entry, state, ctx));
  }

  // ------------------------------------------------------------------ state changes
  function refresh(entry, state, ctx) {
    computeAggs(state);
    restyleAll(state, ctx);
    state.ui.update(viewOf(entry, state, ctx));
    if (state.shown) {
      ctx.flush();
      if (state.selected) { openPopup(state, ctx, state.selected); }     // the open popup states figures for the filters: rebuild it, where it was
    }
    ctx.refreshLegend(entry.id);
  }

  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) { throw new RangeError("unknown ATR colour mode " + mode + " (use mw or bands)"); }
    shared.mode = mode;
    instances.forEach(function (i) { i.state.mode = mode; refresh(i.entry, i.state, i.ctx); });
    return mode;
  }

  /* filters: {technology, status, operator}, a missing or null entry meaning all. A value that the filter list does not offer is refused (the merged placeholder is never offered). */
  function setFilters(entry, state, ctx, filters) {
    var next = noFilters(), given = filters && typeof filters === "object" ? filters : {};
    Object.keys(given).forEach(function (key) { if (FILTER_NAMES.indexOf(key) < 0) { throw new RangeError("unknown ATR filter " + key); } });
    FILTER_NAMES.forEach(function (name) {
      var value = given[name] === undefined || given[name] === "" ? null : given[name];
      if (value !== null && state.options[name].indexOf(value) < 0) { throw new RangeError("the " + name + " filter does not offer " + String(value)); }
      next[name] = value;
    });
    state.filters = next;
    refresh(entry, state, ctx);
    return Object.assign({}, next);
  }

  function installHooks(ctx) {
    ctx.hooks.setAtrMode = setMode;
    ctx.hooks.setAtrFilters = function (filters) {
      var target = instances.filter(function (i) { return i.ctx.isOn && i.ctx.isOn(i.entry.id); })[0] || instances[0];
      if (!target) { throw new Error("no ATR layer is loaded"); }
      return setFilters(target.entry, target.state, target.ctx, filters);
    };
  }

  function actionsFor(entry, state, ctx) {
    return {
      snapshots: function () { return ctx.entries("choropleth").map(function (e) { return { id: e.id, title: e.title }; }); },
      chooseSnapshot: function (id) {
        ctx.entries("choropleth").forEach(function (e) { if (e.id !== id && ctx.isOn(e.id)) { ctx.setOn(e.id, false); } });
        ctx.setOn(id, true);
      },
      setMode: setMode,
      setOpacity: function (value) {
        state.opacity = Math.max(MIN_OPACITY, Math.min(1, Number(value)));
        restyleAll(state, ctx);
        state.ui.update(viewOf(entry, state, ctx));
        if (state.shown) { ctx.flush(); }
      },
      setFilter: function (name, value) { var next = Object.assign({}, state.filters); next[name] = value; setFilters(entry, state, ctx, next); },
      resetFilters: function () { setFilters(entry, state, ctx, {}); },
      toggleTable: function () { state.tableOpen = !state.tableOpen; state.ui.update(viewOf(entry, state, ctx)); },
      sortBy: function (key) {
        state.sort = state.sort.key === key ? { key: key, dir: state.sort.dir === "asc" ? "desc" : "asc" } : { key: key, dir: key === "mw" ? "desc" : "asc" };
        state.ui.update(viewOf(entry, state, ctx));
      },
      selectCounty: function (name) { select(entry, state, ctx, name, null, true); }
    };
  }

  // ------------------------------------------------------------------ the renderer
  function create(entry, obj, fc, ctx) {
    var state = { obj: obj, mode: shared.mode, filters: noFilters(), options: Lib.atrFilterOptions(obj), polys: Object.create(null), rings: Object.create(null), aggs: Object.create(null),
      unknownAgg: null, patterns: {}, opacity: ctx.basemapOn ? FILL_OPACITY : 1, selected: null, hovered: null, highlight: null, shown: false, tableOpen: false, sort: { key: "name", dir: "asc" }, unmatched: null, ui: null };
    computeAggs(state);
    fc.features.forEach(function (feature) {
      var name = feature && feature.properties && feature.properties.name, rings = latlngsOf(feature);
      if (typeof name !== "string" || !rings || state.polys[name]) { return; }
      var poly = L.polygon(rings, Object.assign({ renderer: ctx.renderers.assets, interactive: true, bubblingMouseEvents: false, lineJoin: "round" }, styleFor(state, ctx, name)));
      poly.on("click", function (ev) { select(entry, state, ctx, name, ev && ev.latlng, false); });
      poly.on("mouseover", function () { state.hovered = name; drawHighlight(state, ctx); });
      poly.on("mouseout", function () { if (state.hovered === name) { state.hovered = null; } drawHighlight(state, ctx); });
      state.polys[name] = poly;
      state.rings[name] = rings;
    });
    state.unmatched = { in_data_only: Object.keys(obj.counties).filter(function (n) { return !state.polys[n]; }), in_outline_only: Object.keys(state.polys).filter(function (n) { return !own(obj.counties, n); }) };
    state.ui = Ui.buildPanel(entry, obj, state.options, actionsFor(entry, state, ctx), { notes: ctx.page && ctx.page.atr_notes ? ctx.page.atr_notes : {}, hosts: ctx.page && ctx.page.link_hosts ? ctx.page.link_hosts : [] });
    return state;
  }

  R.choropleth = {
    rank: function () { return -1; },                                  // drawn under every asset of the shared canvas
    load: function (entry, ctx) {
      return Promise.all([ctx.fetchJson(entry.files.data), ctx.loadLayer("counties")]).then(function (loaded) {
        var obj = Lib.checkAtr(loaded[0]), outlines = loaded[1] && loaded[1].fc;
        if (!outlines || !Array.isArray(outlines.features)) { throw new Error("the county outlines are not available"); }
        var state = create(entry, obj, outlines, ctx);
        instances.push({ entry: entry, state: state, ctx: ctx });
        installHooks(ctx);
        state.ui.update(viewOf(entry, state, ctx));
        return state;
      });
    },
    show: function (entry, state, ctx) {
      ctx.entries("choropleth").forEach(function (other) { if (other.id !== entry.id && ctx.isOn(other.id)) { ctx.setOn(other.id, false); } });         // one snapshot at a time
      state.mode = shared.mode;
      computeAggs(state);
      restyleAll(state, ctx);
      Object.keys(state.polys).forEach(function (name) { ctx.map.addLayer(state.polys[name]); state.polys[name].bringToFront(); });
      ctx.restack(-1);                                                  // the lines and points go back in front of the fills
      state.shown = true;
      if (ctx.map.on && !state.onPopupClose) {                          // closing the popup, or another layer using it, ends the selection (and its outline)
        state.onPopupClose = function () { if (!state.opening) { endSelection(entry, state, ctx); } };
        state.onPopupTaken = function (ev) { if (!state.opening && ev && ev.el !== state.popupEl) { endSelection(entry, state, ctx); } };
        ctx.map.on("popupclose", state.onPopupClose);
        ctx.map.on("atlaspopup", state.onPopupTaken);
      }
      state.ui.update(viewOf(entry, state, ctx));
      drawHighlight(state, ctx);
    },
    hide: function (entry, state, ctx) {
      Object.keys(state.polys).forEach(function (name) { ctx.map.removeLayer(state.polys[name]); });
      if (state.highlight && ctx.map.hasLayer(state.highlight)) { ctx.map.removeLayer(state.highlight); }
      if (state.selected) { state.selected = null; if (ctx.map.closePopup) { ctx.map.closePopup(); } }        // the open popup is this layer's: close it with the layer
      if (state.onPopupClose && ctx.map.off) { ctx.map.off("popupclose", state.onPopupClose); ctx.map.off("atlaspopup", state.onPopupTaken); state.onPopupClose = null; state.onPopupTaken = null; }
      state.shown = false;
    },
    restyle: function (entry, state, ctx) {
      restyleAll(state, ctx);
      if (state.highlight) { state.highlight.setStyle({ color: ctx.pal("--ink") }); }
      ctx.refreshLegend(entry.id);
    },
    counts: function (entry, state) { return Lib.atrBandCounts(state.obj); },
    info: function (entry, state, ctx) {
      var fills = {}, classes = {}, drawn = 0;
      Object.keys(state.polys).forEach(function (name) {
        var kind = kindOf(state, name);
        fills[name] = kind === "fill" ? state.polys[name].options.fillColor : kind;                 // "hatch", "dots" and "outline" cannot be serialised as colours (canvas patterns)
        if (ctx.map.hasLayer(state.polys[name])) { drawn += 1; }
      });
      Object.keys(state.obj.counties).forEach(function (name) { classes[name] = state.obj.counties[name].suppressed === true ? null : Lib.atrMwClass(state.aggs[name].mw); });
      return { mode: state.mode, filters: Object.assign({}, state.filters), opacity: state.opacity, drawn: drawn, counties: Object.keys(state.polys).length, fills: fills, mwClasses: classes,
        selected: state.selected, hovered: state.hovered, tableOpen: state.tableOpen, unmatched: state.unmatched };
    },
    legend: function (entry, state, ctx) {
      state.ui.update(viewOf(entry, state, ctx));
      return { rows: legendRows(state, ctx), extra: state.ui.extra, after: state.ui.after, note: state.mode === "bands" ? NOTE_BANDS : NOTE_MW };
    },
    describe: function (entry, state, index, ctx) {
      var name = Object.keys(state.obj.counties)[index];
      if (name === undefined) { throw new RangeError("there is no county at index " + index); }
      return { el: popupFor(state, name), latlng: centreOf(state, ctx, name) };
    }
  };
})();
