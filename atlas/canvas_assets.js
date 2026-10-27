/* canvas_assets.js - the Leaflet side of the assets canvas (the arithmetic is in draw_core.js).
 *
 * Three things:
 *  - AtlasCanvas.renderer(options): Leaflet's canvas renderer, with one change. Leaflet redraws every path synchronously on each viewreset and again on each moveend, so a
 *    single zoom drew everything twice and re-clipped every polygon three times. This renderer notes that the paths are out of date and does ONE redraw in the next
 *    animation frame (a pending partial redraw can never shrink a pending full one).
 *  - AtlasCanvas.path(renderer, impl, options): a path that stands for a whole layer. It is an ordinary Leaflet path (draw order, bringToFront, redraw, click and hover
 *    picking all work), but it draws its thousands of features itself: impl = {box() -> [minx, miny, maxx, maxy] in world pixels or null, margin (px), paint(ctx, view),
 *    hit(view, x, y) -> boolean}. view says where the canvas is (see draw_core.js) and is limited to the area being redrawn.
 *  - AtlasCanvas.sprites(describe): a cache of small pre-drawn markers, one canvas per (variant, whole-pixel radius), drawn with one drawImage each. describe(variant, ring)
 *    -> {shape: "circle" | "square", fill, fillOpacity, color, weight, opacity, casing: {color, weight, opacity} | null, ring: true when the look uses the ring weight};
 *    ring is the hollow-ring weight of the zoom. */
(function () {
  "use strict";
  var L = window.L, Draw = window.AtlasDraw;

  /* The key of a view as far as projected geometry is concerned: the same zoom and pixel origin give the same layer points. */
  function projectionKey(map) { var o = map.getPixelOrigin(); return map.getZoom() + ":" + o.x + ":" + o.y; }

  var AtlasRenderer = L.Canvas.extend({
    /* A map that is moved without animation fires zoomend (every path is projected) and then viewreset (every path is projected again, at the same zoom and origin). The
     * second pass is skipped; the canvas still follows the view. A zoom that is animated has no viewreset, so there the zoomend pass is the only one and runs. */
    _onZoomEnd: function () {
      var key = projectionKey(this._map);
      if (this._projectedFor === key) { return; }
      this._projectedFor = key;
      L.Canvas.prototype._onZoomEnd.call(this);
    },
    _reset: function () {
      var key = projectionKey(this._map);
      if (this._projectedFor !== key) {
        this._projectedFor = key;
        L.Canvas.prototype._reset.call(this);
        return;
      }
      this._update();
      this._updateTransform(this._center, this._zoom);
      if (this._postponeUpdatePaths) { this._postponeUpdatePaths = false; this._updatePaths(); }
    },
    _updatePaths: function () {
      if (this._postponeUpdatePaths) { return; }
      this._redrawBounds = null;
      this._pathsStale = true;                                   // every path re-reads its geometry once, in the redraw
      this._redrawRequest = this._redrawRequest || L.Util.requestAnimFrame(this._redraw, this);
    },
    _extendRedrawBounds: function (layer) {
      if (!this._pathsStale) { L.Canvas.prototype._extendRedrawBounds.call(this, layer); }     // a full redraw is pending: it already covers this layer
    },
    _redraw: function () {
      if (this._pathsStale) {
        this._pathsStale = false;
        this._redrawBounds = null;
        for (var id in this._layers) { this._layers[id]._update(); }
      }
      L.Canvas.prototype._redraw.call(this);
    }
  });

  /* Where the canvas is, for draw_core: the area being redrawn, the zoom, and the pixel origin the layer points are relative to. The area is clamped to the canvas: a layer that
   * is toggled asks for a redraw of its whole extent (a country at a street zoom), and only what lies on the canvas may be drawn or counted. full = the area covers everything of
   * the layer (its pixel extent, when given) that lies on the canvas, so the layer can count what this redraw painted. */
  function viewOf(renderer, map, extent) {
    var all = renderer._bounds, part = renderer._redrawBounds, origin = map.getPixelOrigin(), zoom = map.getZoom();
    var x0 = all.min.x, y0 = all.min.y, x1 = all.max.x, y1 = all.max.y, full = !part;
    if (part) {
      var nx0 = Math.max(x0, extent ? extent.min.x : x0), ny0 = Math.max(y0, extent ? extent.min.y : y0), nx1 = Math.min(x1, extent ? extent.max.x : x1), ny1 = Math.min(y1, extent ? extent.max.y : y1);
      full = part.min.x <= nx0 && part.min.y <= ny0 && part.max.x >= nx1 && part.max.y >= ny1;
      x0 = Math.max(x0, part.min.x); y0 = Math.max(y0, part.min.y); x1 = Math.min(x1, part.max.x); y1 = Math.min(y1, part.max.y);
    }
    return { s: Math.pow(2, zoom), z: zoom, ox: origin.x, oy: origin.y, minx: x0, miny: y0, maxx: x1, maxy: y1, full: full };
  }

  var AtlasPath = L.Path.extend({
    options: { stroke: false, fill: false, weight: 0, interactive: true, bubblingMouseEvents: false },
    initialize: function (impl, options) {
      L.setOptions(this, options);
      this._impl = impl;
      this._pxBounds = new L.Bounds([0, 0], [0, 0]);                  // never empty: the renderer reads it when the layer is added or removed
    },
    _project: function () {
      var box = this._impl.box(), map = this._map;
      if (!box || !map) { this._pxBounds = new L.Bounds([0, 0], [0, 0]); return; }
      var s = Math.pow(2, map.getZoom()), o = map.getPixelOrigin(), m = (this._impl.margin || 0) + 1;
      this._pxBounds = new L.Bounds([box[0] * s - o.x - m, box[1] * s - o.y - m], [box[2] * s - o.x + m, box[3] * s - o.y + m]);
    },
    _update: function () { /* nothing to clip or simplify: the draw loop skips what is outside the view */ },
    _updatePath: function () { this._impl.paint(this._renderer._ctx, viewOf(this._renderer, this._map, this._pxBounds)); },
    _containsPoint: function (point) { return !!this._map && this._impl.hit(viewOf(this._renderer, this._map), point.x, point.y); }
  });

  function sprites(describe) {
    var plain = [], ringed = {}, depends = [], ring = null, retina = !!L.Browser.retina;
    function make(variant, r) {
      var half = r + Draw.SPRITE_PAD, size = half * 2, scale = retina ? 2 : 1, spec = describe(variant, ring);
      var canvas = document.createElement("canvas");
      canvas.width = size * scale; canvas.height = size * scale;
      var g = canvas.getContext("2d");
      if (scale !== 1) { g.scale(scale, scale); }
      var outline = function () {
        g.beginPath();
        if (spec.shape === "square") { g.rect(half - r, half - r, 2 * r, 2 * r); } else { g.arc(half, half, r, 0, 2 * Math.PI, false); }
      };
      g.lineCap = "round"; g.lineJoin = "round";
      if (spec.casing) { outline(); g.globalAlpha = spec.casing.opacity; g.lineWidth = spec.casing.weight; g.strokeStyle = spec.casing.color; g.stroke(); }
      outline();
      if (spec.fill) { g.globalAlpha = spec.fillOpacity; g.fillStyle = spec.fill; g.fill("evenodd"); }
      g.globalAlpha = spec.opacity; g.lineWidth = spec.weight; g.strokeStyle = spec.color; g.stroke();
      return { canvas: canvas, half: half, size: size };
    }
    /* A sprite only depends on the zoom when its look uses the ring weight (describe marks it with ring: true): every other sprite is kept for good. The sprites of a ring
     * weight stay too, so going back to a zoom already seen draws nothing new. */
    function rowOf(variant) {
      if (depends[variant] === undefined) { depends[variant] = !!describe(variant, ring).ring; }
      if (!depends[variant]) { return plain[variant] || (plain[variant] = []); }
      var byVariant = ringed[ring] || (ringed[ring] = []);
      return byVariant[variant] || (byVariant[variant] = []);
    }
    return {
      /* The sprite of a variant at a whole-pixel radius, drawn on first use. */
      get: function (variant, r) {
        var row = rowOf(variant);
        return row[r] || (row[r] = make(variant, r));
      },
      /* Forget every sprite: the theme changed and the colours are new. */
      reset: function () { plain = []; ringed = {}; depends = []; },
      setRing: function (nextRing) { ring = nextRing; }
    };
  }

  window.AtlasCanvas = {
    renderer: function (options) { return new AtlasRenderer(options); },
    path: function (renderer, impl, options) { return new AtlasPath(impl, Object.assign({ renderer: renderer }, options || {})); },
    view: viewOf,
    sprites: sprites
  };
})();
