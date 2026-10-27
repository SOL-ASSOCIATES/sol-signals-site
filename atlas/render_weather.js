/* render_weather.js - renderer for the manifest kind "cells": the wind and cloud forecast.
 * Native 0.25 degree model cells drawn as discrete squares, no smoothing and no animation; a variable switch (100 m wind / total cloud), its own time slider
 * (valid times shown in Bucharest time and in UTC), the issue time, and the plain statement that this is a model forecast and not a measurement.
 * The bundle decides at build time (by day) whether a forecast is too old to ship; this renderer also checks the viewer's own clock: a forecast issued more than
 * Lib.forecastLimitHours(edition) ago (36 hours; 168 in the labelled demo edition, which also puts the issue time, the valid-until time and "This demo is updated periodically and is not a live service." on the map while the layer is on)
 * is not drawn at all and the layer is disabled with a visible notice (state.unavailable, see atlas.js). The weather time is never
 * shared with the production day. Test hooks (on window.__atlas): setWeatherStep(i), setWeatherVariable("wind" | "cloud"). */
(function () {
  "use strict";
  var L = window.L, Lib = window.AtlasLib, UI = window.AtlasUI;
  var R = (window.AtlasRenderers = window.AtlasRenderers || {});

  var TZ = "Europe/Bucharest";
  var VARIABLES = ["wind", "cloud"];
  var FILL_OPACITY = 0.78, EDGE_OPACITY = 0.5, EDGE_WEIGHT = 0.7;      // FILL_OPACITY only over a base map; on the neutral ground the cells are opaque, so they match the legend swatches
  var RECHECK_MS = 5 * 60 * 1000;                       // while the layer is on, look again at the clock this often
  var CELL_NOTE = "Each square is one 0.25 degree model cell (about 28 km by 19 km) holding the model value at its centre, at the model's own 3-hourly steps. " +
    "Nothing is smoothed or interpolated, and a cell is not a site measurement.";

  function boxOf(feature) {
    var s = 90, w = 180, n = -90, e = -180;
    feature.geometry.coordinates[0].forEach(function (c) { s = Math.min(s, c[1]); n = Math.max(n, c[1]); w = Math.min(w, c[0]); e = Math.max(e, c[0]); });
    return [[s, w], [n, e]];
  }
  function scaleOf(state) { return Lib.weatherScale(state.variable); }
  function valueAt(cell, name, step) { return cell[name][step]; }
  /* The forecast model as the metadata names it (text only), shown next to the issue time and the valid time. */
  function modelOf(entry) { return typeof entry.meta.model === "string" && entry.meta.model.trim() ? entry.meta.model.trim() : "not stated"; }
  function plain(value, unit) { return typeof value === "number" && isFinite(value) ? value + " " + unit : "no value"; }

  /* The text to show when the forecast is too old on the viewer's clock, or null when it may be drawn. The limit is the one of the edition of the manifest (ctx.edition): 36 hours,
   * 168 for the labelled demo. */
  function staleText(entry, ctx) {
    var issued = entry.meta.issued_at, age = Lib.forecastAge(issued, Date.now(), ctx.edition);
    if (!age.stale) { return null; }
    var when = age.hours === null ? "its issue time and your clock do not agree or could not be read"
      : "issued " + Lib.formatLocal(issued, TZ) + " local time, " + Lib.forecastAgeText(age) + ", limit " + Lib.forecastLimitHours(ctx.edition) + " hours";
    return "This forecast is out of date (" + when + "). The layer is switched off and no old cells are drawn. If that looks wrong, " + Lib.CLOCK_HINT + ".";
  }

  // ------------------------------------------------------------------ controls (a node the renderer keeps; atlas.js leaves it in place while the legend rows are rebuilt)
  function timeLines(entry, state) {
    var iso = state.fc.steps[state.step], hours = Lib.stepHours(state.fc.steps);
    return { local: "Valid " + Lib.formatLocal(iso, TZ) + " local time (" + TZ + ")", utc: Lib.formatUtc(iso),
      count: "Step " + (state.step + 1) + " of " + state.fc.steps.length + (hours ? ", every " + hours + (hours === 1 ? " hour" : " hours") + " (the model's own step)" : "") };
  }

  function buildControls(entry, state, ctx) {
    var radios = VARIABLES.map(function (name) {
      var input = UI.el("input", { type: "radio", name: "wx-variable", value: name, id: "wx-var-" + name, checked: name === state.variable ? true : null });
      input.checked = name === state.variable;
      input.addEventListener("change", function () { if (input.checked) { setVariable(entry, state, ctx, name); } });
      return UI.el("label", { class: "wx-radio", for: "wx-var-" + name }, [input, Lib.weatherScale(name).label]);
    });
    var slider = UI.el("input", { type: "range", id: "wx-step", min: "0", max: String(state.fc.steps.length - 1), step: "1", "aria-label": "Forecast time step", "aria-describedby": "wx-time" });
    slider.value = String(state.step);
    slider.addEventListener("input", function () { setStep(entry, state, ctx, Number(slider.value)); });
    var parts = {
      slider: slider, radios: radios,
      local: UI.el("strong", { "data-role": "wx-local" }), utc: UI.el("span", { "data-role": "wx-utc" }), count: UI.el("span", { class: "wx-count", "data-role": "wx-count" }),
      age: UI.el("span", { "data-role": "wx-age" })
    };
    var root = UI.el("div", { class: "layer-extra wx-controls" }, [
      UI.el("p", { class: "wx-claim", text: "Model forecast, not a measurement." }),
      UI.el("fieldset", { class: "wx-var" }, [UI.el("legend", { text: "Show" })].concat(radios)),
      UI.el("label", { class: "wx-slider-label", for: "wx-step", text: "Forecast time" }),
      slider,
      UI.el("p", { class: "wx-time", id: "wx-time", "aria-live": "polite" }, [parts.local, " | ", parts.utc, UI.el("br"), parts.count]),
      UI.el("p", { class: "wx-issued" }, [UI.el("strong", { text: "Model " }), UI.el("span", { "data-role": "wx-model", text: modelOf(entry) }), ". ",
        UI.el("strong", { text: "Forecast issued " }), Lib.formatLocal(entry.meta.issued_at, TZ) + " local (" + Lib.formatUtc(entry.meta.issued_at) + "). ", parts.age])
    ]);
    state.ui = { root: root, parts: parts };
    updateText(entry, state);
    return state.ui;
  }

  function updateText(entry, state) {
    var p = state.ui.parts, t = timeLines(entry, state);
    p.local.textContent = t.local;
    p.utc.textContent = t.utc;
    p.count.textContent = t.count;
    p.slider.value = String(state.step);
    p.slider.setAttribute("aria-valuetext", t.local + ", " + t.utc);
    p.radios.forEach(function (label) { var input = label.firstChild; input.checked = input.value === state.variable; });
    p.age.textContent = "Age: " + Lib.forecastAgeText(Lib.forecastAge(entry.meta.issued_at, Date.now(), state.edition)) + ".";
  }

  // ------------------------------------------------------------------ drawing
  function colourOf(state, ctx, cell) {
    return Lib.scaleColour(scaleOf(state), valueAt(cell, state.variable, state.step), ctx.dark());
  }
  function recolour(state, ctx) {
    if (!state.built) { return; }
    state.cells.forEach(function (cell) { cell.rect.setStyle({ fillColor: colourOf(state, ctx, cell) }); });
    ctx.flush();
  }
  function popup(entry, state, cell) {
    var iso = state.fc.steps[state.step];
    return UI.popupBox("Forecast cell", "Model forecast, not a measurement", [["Model", modelOf(entry)], ["Valid, local time", Lib.formatLocal(iso, TZ)], ["Valid, UTC", Lib.formatUtc(iso)],
      ["Wind at 100 m", plain(valueAt(cell, "wind", state.step), "m/s")], ["Total cloud cover", plain(valueAt(cell, "cloud", state.step), "%")],
      ["Cell", "0.25 degree model cell, value at its centre"]], []);
  }
  function centreOf(cell) { return L.latLng((cell.box[0][0] + cell.box[1][0]) / 2, (cell.box[0][1] + cell.box[1][1]) / 2); }

  function build(entry, state, ctx) {
    state.cells.forEach(function (cell) {
      cell.rect = L.rectangle(cell.box, { renderer: ctx.renderers.assets, stroke: true, color: ctx.pal("--outline-county"), weight: EDGE_WEIGHT, opacity: EDGE_OPACITY, fill: true,
        fillColor: colourOf(state, ctx, cell), fillOpacity: ctx.basemapOn ? FILL_OPACITY : 1, interactive: true, bubblingMouseEvents: false });
      cell.rect.on("click", function () { ctx.showPopup(popup(entry, state, cell), centreOf(cell)); });
    });
    state.built = true;
  }

  function refresh(entry, state, ctx) {
    updateText(entry, state);
    recolour(state, ctx);
    ctx.refreshLegend(entry.id);
  }
  function setStep(entry, state, ctx, index) {
    if (!Number.isInteger(index) || index < 0 || index >= state.fc.steps.length) { throw new RangeError("forecast step " + index + " is outside 0 to " + (state.fc.steps.length - 1)); }
    state.step = index;
    refresh(entry, state, ctx);
    return index;
  }
  function setVariable(entry, state, ctx, name) {
    if (VARIABLES.indexOf(name) < 0) { throw new RangeError("unknown weather variable " + name); }
    state.variable = name;
    refresh(entry, state, ctx);
    return name;
  }

  function attachHooks(entry, state, ctx) {
    var guard = function (work) {
      return function (value) {
        if (state.unavailable) { throw new Error("the weather layer is not available: " + state.unavailable); }
        return work(entry, state, ctx, value);
      };
    };
    ctx.hooks.setWeatherStep = guard(setStep);
    ctx.hooks.setWeatherVariable = guard(setVariable);
  }

  function stopTimer(state) { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  /* The demo is updated periodically and is not a live service: while its forecast is on the map, a notice on the map says when the forecast was issued, until when it is valid and that
   * One notice at a time; it leaves with the layer. A forecast past its valid-until time reads as a dated snapshot, so the text is looked at again every time the clock is
   * checked. Other editions print no notice. */
  function labelText(entry) { return UI.forecastLabel(entry.meta.issued_at, entry.meta.valid_to, Date.now()); }
  function showLabel(entry, state, ctx) {
    if (ctx.edition !== "demo" || state.notice) { return; }
    state.noticeText = labelText(entry);
    state.notice = ctx.addNotice(state.noticeText, "warn");
  }
  function hideLabel(state, ctx) {
    if (state.notice) { ctx.removeNotice(state.notice); state.notice = null; state.noticeText = null; }
  }
  /* The clock moved on: when the wording of the label changed (the valid-until time passed) the notice is replaced, and the page refreshes the label of the card. */
  function relabel(entry, state, ctx) {
    if (!state.notice || state.noticeText === labelText(entry)) { return; }
    hideLabel(state, ctx);
    showLabel(entry, state, ctx);
    ctx.refreshLegend(entry.id);
  }

  R.cells = {
    load: function (entry, ctx) {
      var state = { fc: null, cells: [], step: 0, variable: "wind", built: false, shown: false, unavailable: staleText(entry, ctx), ui: null, timer: null, edition: ctx.edition, notice: null, noticeText: null };
      attachHooks(entry, state, ctx);                                      // the hooks exist even when the layer is unavailable (they then throw a clear message)
      if (state.unavailable) { return Promise.resolve(state); }            // too old on this clock: not even fetched, nothing to draw
      return ctx.fetchJson(entry.files.data).then(function (fc) {
        Lib.checkWeather(fc);
        state.fc = fc;
        state.cells = fc.features.map(function (f) { return { id: f.properties.cell_id, box: boxOf(f), wind: f.properties.wind100_ms, cloud: f.properties.cloud_pct, rect: null }; });
        state.step = Lib.stepAt(fc.steps, Date.now());
        buildControls(entry, state, ctx);
        return state;
      });
    },
    show: function (entry, state, ctx) {
      state.unavailable = staleText(entry, ctx);
      if (state.unavailable) { return; }
      if (!state.built) { build(entry, state, ctx); } else { recolour(state, ctx); }
      state.cells.forEach(function (cell) { ctx.map.addLayer(cell.rect); cell.rect.bringToBack(); });           // behind the lines and points of the shared canvas
      state.shown = true;
      showLabel(entry, state, ctx);
      updateText(entry, state);
      stopTimer(state);
      state.timer = setInterval(function () {
        var text = staleText(entry, ctx);
        if (text && state.shown) { stopTimer(state); hideLabel(state, ctx); state.unavailable = text; ctx.setUnavailable(entry.id, text); }
        else { updateText(entry, state); relabel(entry, state, ctx); }
      }, RECHECK_MS);
    },
    hide: function (entry, state, ctx) {
      stopTimer(state);
      hideLabel(state, ctx);
      if (state.built) { state.cells.forEach(function (cell) { ctx.map.removeLayer(cell.rect); }); }
      state.shown = false;
    },
    restyle: function (entry, state, ctx) {
      if (state.unavailable || !state.built) { return; }
      state.cells.forEach(function (cell) { cell.rect.setStyle({ color: ctx.pal("--outline-county"), fillColor: colourOf(state, ctx, cell) }); });
      ctx.refreshLegend(entry.id);
    },
    complete: function (state) { return !state.unavailable; },
    counts: function (entry, state) { return state.unavailable ? {} : { cells: state.cells.length }; },
    info: function (entry, state, ctx) {
      if (state.unavailable) { return { unavailable: true }; }
      var drawn = 0;
      state.cells.forEach(function (cell) { if (cell.rect && ctx.map.hasLayer(cell.rect)) { drawn += 1; } });
      return { step: state.step, steps: state.fc.steps.length, variable: state.variable, validAt: state.fc.steps[state.step], drawn: drawn, cells: state.cells.length };
    },
    legend: function (entry, state, ctx) {
      if (state.unavailable) { return { rows: [], note: null }; }
      var scale = scaleOf(state), dark = ctx.dark();
      var counts = Lib.bucketCounts(scale, state.cells.map(function (cell) { return valueAt(cell, state.variable, state.step); }));
      var rows = scale.bucketLabels.map(function (label, i) {
        return { key: "class" + i, label: label, count: counts.buckets[i], swatch: { shape: "square", c: scale.ramp[dark ? "dark" : "light"][i], s: 14 } };
      });
      rows.push({ key: "none", label: "No value", count: counts.missing, swatch: { shape: "square", c: Lib.NULL_COLOUR, s: 14 } });
      return { rows: rows, extra: state.ui.root, note: "Numbers are the cells in each class at the time shown. " + CELL_NOTE };
    },
    describe: function (entry, state, index) {
      var cell = state.cells[index];
      return { el: popup(entry, state, cell), latlng: centreOf(cell) };
    }
  };
})();
