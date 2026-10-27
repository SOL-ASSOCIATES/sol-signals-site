/* render_solar.js - renderer for the manifest kind "raster": the Global Solar Atlas long-term climatology (GHI and PVOUT) as a map image.
 * The data file is a small description {png, bounds, vmin, vmax, unit, period_note}; the PNG is already registered to Web Mercator, so it is laid on the map
 * as it is (L.imageOverlay at the stated bounds), nothing is reprojected in the browser. The image is DERIVED long-term climatology (not a forecast, not a
 * measurement of one year); the legend says so, shows the colour bar with its two end values, the unit and the period note.
 * A PNG that cannot be loaded fails this layer only (the load promise rejects, atlas.js reports it on the card). */
(function () {
  "use strict";
  var L = window.L, Lib = window.AtlasLib, UI = window.AtlasUI;
  var R = (window.AtlasRenderers = window.AtlasRenderers || {});

  var DEFAULT_OPACITY = 0.6, MIN_OPACITY = 0.2;
  var NOTE = "Long-term average (a climatology), not a forecast and not a measurement of any one year. Colours are clipped at both ends of the bar, so values beyond it " +
    "look like the end colour. Transparent where the source has no data.";

  /* Resolves when the browser has decoded the image, rejects when it cannot be loaded: a missing or damaged PNG fails the layer, not the page. */
  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("the climatology image could not be loaded")); };
      img.src = url;
    });
  }

  function round(value) { return String(Math.round(value)); }

  function buildExtra(entry, state) {
    var d = state.desc, percent = function () { return Math.round(state.opacity * 100) + " %"; };
    var slider = UI.el("input", { type: "range", id: "solar-opacity-" + entry.id, min: String(MIN_OPACITY * 100), max: "100", step: "5", "aria-label": "Image opacity" });
    slider.value = String(Math.round(state.opacity * 100));
    var shown = UI.el("span", { class: "num", text: percent() });
    slider.addEventListener("input", function () {
      state.opacity = Math.max(MIN_OPACITY, Math.min(1, Number(slider.value) / 100));
      shown.textContent = percent();
      if (state.overlay) { state.overlay.setOpacity(state.opacity); }
    });
    var bar = UI.el("div", { class: "colourbar-bar", role: "img", "aria-label": "Colour bar from " + round(d.vmin) + " to " + round(d.vmax) + " " + d.unit + ", dark purple to yellow" });
    bar.style.setProperty("background", Lib.gradientCss(Lib.SOLAR_RAMP));
    return UI.el("div", { class: "layer-extra colourbar" }, [
      UI.el("p", { class: "colourbar-title" }, [UI.el("span", { class: "chip ev-DERIVED", text: "DERIVED" }), " Long-term climatology, " + d.unit]),
      bar,
      UI.el("div", { class: "colourbar-ends" }, [UI.el("span", { class: "num", "data-role": "vmin", text: round(d.vmin) }), UI.el("span", { text: d.unit }), UI.el("span", { class: "num", "data-role": "vmax", text: round(d.vmax) })]),
      UI.el("p", { class: "colourbar-period", "data-role": "period", text: d.period_note }),
      UI.el("label", { class: "opacity-row", for: slider.id }, ["Opacity ", shown]),
      slider
    ]);
  }

  R.raster = {
    load: function (entry, ctx) {
      return ctx.fetchJson(entry.files.data).then(function (desc) {
        Lib.checkRaster(desc, entry.files.png);
        var url = ctx.assetUrl(entry.files.png);
        return loadImage(url).then(function () {
          var state = { desc: desc, url: url, overlay: null, opacity: DEFAULT_OPACITY, shown: false, extra: null };
          state.extra = buildExtra(entry, state);
          return state;
        });
      });
    },
    show: function (entry, state, ctx) {
      if (!state.overlay) {
        state.overlay = L.imageOverlay(state.url, state.desc.bounds, { pane: "raster", opacity: state.opacity, interactive: false, alt: "" });
      }
      ctx.map.addLayer(state.overlay);
      state.shown = true;
    },
    hide: function (entry, state, ctx) {
      if (state.overlay) { ctx.map.removeLayer(state.overlay); }
      state.shown = false;
    },
    info: function (entry, state, ctx) {
      return { opacity: state.opacity, bounds: state.desc.bounds, vmin: state.desc.vmin, vmax: state.desc.vmax, unit: state.desc.unit, drawn: !!(state.overlay && ctx.map.hasLayer(state.overlay)) };
    },
    counts: function () { return { image: 1 }; },
    legend: function (entry, state) {
      return { rows: [{ key: "image", label: "Climatology image", sub: "Image overlay, long-term average", count: 1, swatch: { shape: "square", c: Lib.SOLAR_RAMP[5], s: 14 } }],
        extra: state.extra, note: NOTE };
    }
  };
})();
