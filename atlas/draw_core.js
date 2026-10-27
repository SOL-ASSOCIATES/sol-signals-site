/* draw_core.js - the drawing arithmetic of the assets canvas: pure functions on typed arrays, no DOM and no Leaflet.
 * Sets module.exports when loaded by Node, else window.AtlasDraw. Plain script, no build step.
 *
 * Why it exists: a Leaflet path object per marker or line (about 9,000 objects) made every zoom re-project, clip, simplify and draw all of them. Here a layer is a few typed
 * arrays in "world pixels" (a 256 pixel world at zoom 0, exactly Leaflet's spherical Mercator), a view says where the canvas is, and a draw loop projects with one
 * multiplication per coordinate, skips what is outside the view and paints the rest in a single pass.
 *
 * A view is {s, z, ox, oy, minx, miny, maxx, maxy}: s = 2^zoom, (ox, oy) = the pixel origin of the map (Leaflet's layer points are world pixels minus it), and the bounds
 * of the canvas area to draw in layer pixels. Drawing code only reads it. */
(function (factory) {
  "use strict";
  var core = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = core; } else { window.AtlasDraw = core; }
})(function () {
  "use strict";

  var WORLD = 256, MAX_LAT = 85.0511287798, LOD_ZOOM = 8;
  var SPRITE_PAD = 4;                                   // a marker sprite reaches this far beyond its radius (the ring and its casing)
  var MIN_SEGMENT2 = 1.44;                              // vertices closer than 1.2 px to the last kept one are dropped (Leaflet's smoothFactor)
  var CHECK_EVERY = 8;                                  // the line builder looks at the clock once per this many features
  var DEG = Math.PI / 180;
  /* The order the voltage classes are painted in, whatever the order of the data: 110, 220, 400, 750 kV (so the higher voltages are on top), then the lines of unknown voltage, then the
   * other voltages. A class that is not listed is painted after these, in the order it first appears. */
  var CLASS_ORDER = ["110", "220", "400", "750", "unknown", "other"];

  // ------------------------------------------------------------------ projection and marker arithmetic
  function worldX(lng) { return (lng + 180) / 360 * WORLD; }
  function worldY(lat) {
    var sin = Math.sin(Math.max(Math.min(lat, MAX_LAT), -MAX_LAT) * DEG);
    return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * WORLD;
  }
  function zoomScale(z) { return Math.min(1.15, Math.max(0.3, 0.3 + (z - 5) * 0.17)); }          // markers grow with the zoom: 0.3 at z5, about 1.0 at z9
  function ringWeight(scale) { return scale < 0.55 ? 1.3 : scale < 0.8 ? 1.8 : 2.2; }              // hollow rings get thinner at national zoom
  function markerRadius(r0, zs) { return Math.max(Math.round(Math.max(2.2, r0 * zs)), 1); }       // the canvas draws whole pixel radii
  function lodFor(zoom, highReady) { return zoom >= LOD_ZOOM && highReady ? "high" : "low"; }

  // ------------------------------------------------------------------ point sets (plants, generators, substations)
  /* spec: {variantOf(props) -> small integer, radiusOf(props) -> base radius in px}. The draw order is big markers first so small ones stay visible over them. */
  function buildPoints(features, spec) {
    var n = features.length, wx = new Float64Array(n), wy = new Float64Array(n), r0 = new Float32Array(n), variant = new Uint8Array(n), order = new Uint32Array(n);
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var i = 0; i < n; i++) {
      var f = features[i], c = f.geometry.coordinates, x = worldX(c[0]), y = worldY(c[1]);
      wx[i] = x; wy[i] = y; r0[i] = spec.radiusOf(f.properties); variant[i] = spec.variantOf(f.properties); order[i] = i;
      if (x < minx) { minx = x; } if (x > maxx) { maxx = x; } if (y < miny) { miny = y; } if (y > maxy) { maxy = y; }
    }
    var sorted = Array.prototype.slice.call(order).sort(function (a, b) { return r0[b] - r0[a] || a - b; });
    for (var k = 0; k < n; k++) { order[k] = sorted[k]; }
    return { n: n, wx: wx, wy: wy, r0: r0, variant: variant, order: order, box: n ? [minx, miny, maxx, maxy] : null };
  }

  /* Draws every marker whose sprite reaches into the view. spriteOf(variant, radius) -> {canvas, half, size}. Returns how many were drawn. */
  function paintPoints(ctx, set, view, zs, spriteOf) {
    var s = view.s, ox = view.ox, oy = view.oy, minx = view.minx - SPRITE_PAD, miny = view.miny - SPRITE_PAD, maxx = view.maxx + SPRITE_PAD, maxy = view.maxy + SPRITE_PAD;
    var wx = set.wx, wy = set.wy, r0 = set.r0, variant = set.variant, order = set.order, painted = 0;
    for (var k = 0; k < set.n; k++) {
      var i = order[k], x = Math.round(wx[i] * s) - ox, y = Math.round(wy[i] * s) - oy, r = markerRadius(r0[i], zs);
      if (x + r < minx || x - r > maxx || y + r < miny || y - r > maxy) { continue; }
      var sprite = spriteOf(variant[i], r);
      ctx.drawImage(sprite.canvas, x - sprite.half, y - sprite.half, sprite.size, sprite.size);
      painted += 1;
    }
    return painted;
  }

  /* The index of the marker under (x, y) in layer pixels, the one drawn last when several are, or -1. extra = the click tolerance in px beyond the radius: one number, or an
   * array indexed by the marker's variant (a hollow ring is a thicker stroke than a filled marker's outline, and a stroke adds half its weight to the target). */
  function hitPoints(set, view, x, y, extra, zs) {
    var s = view.s, ox = view.ox, oy = view.oy, perVariant = typeof extra !== "number";
    for (var k = set.n - 1; k >= 0; k--) {
      var i = set.order[k], reach = Math.max(2.2, set.r0[i] * zs) + (perVariant ? extra[set.variant[i]] : extra);
      var dx = Math.round(set.wx[i] * s) - ox - x;
      if (dx > reach || dx < -reach) { continue; }
      var dy = Math.round(set.wy[i] * s) - oy - y;
      if (dx * dx + dy * dy <= reach * reach) { return i; }
    }
    return -1;
  }

  // ------------------------------------------------------------------ line sets (power lines by voltage class)
  /* A resumable builder: step(deadline, now) converts features until now() reaches the deadline (it looks at the clock once per CHECK_EVERY features and always does at
   * least one batch), so the caller can spread a big file over idle time. result() is the finished set: classes in CLASS_ORDER (the draw order), each with
   * parts (count), offs (vertex offsets, parts + 1), xy (world pixels, interleaved), box (4 per part) and feat (index of the part's feature in the feature list). */
  function lineBuilder(features, classOf) {
    var n = features.length, order = [], byClass = Object.create(null), of = new Array(n), i, g;
    for (i = 0; i < n; i++) {
      var key = String(classOf(features[i].properties));
      g = byClass[key];
      if (!g) { g = byClass[key] = { cls: key, parts: 0, verts: 0 }; order.push(g); }
      g.parts += 1; g.verts += features[i].geometry.coordinates.length; of[i] = g;
    }
    var rank = function (c) { var at = CLASS_ORDER.indexOf(c.cls); return at < 0 ? CLASS_ORDER.length + order.indexOf(c) : at; };
    order.sort(function (a, b) { return rank(a) - rank(b); });
    order.forEach(function (c) {
      c.offs = new Int32Array(c.parts + 1); c.xy = new Float64Array(c.verts * 2); c.box = new Float64Array(c.parts * 4); c.feat = new Int32Array(c.parts); c.p = 0; c.v = 0;
    });
    var next = 0;
    function add(index) {
      var c = of[index], coords = features[index].geometry.coordinates, p = c.p, v = c.v;
      var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (var j = 0; j < coords.length; j++) {
        var x = worldX(coords[j][0]), y = worldY(coords[j][1]);
        c.xy[2 * (v + j)] = x; c.xy[2 * (v + j) + 1] = y;
        if (x < minx) { minx = x; } if (x > maxx) { maxx = x; } if (y < miny) { miny = y; } if (y > maxy) { maxy = y; }
      }
      c.box[4 * p] = minx; c.box[4 * p + 1] = miny; c.box[4 * p + 2] = maxx; c.box[4 * p + 3] = maxy;
      c.feat[p] = index; c.v = v + coords.length; c.p = p + 1; c.offs[p + 1] = c.v;
    }
    return {
      done: function () { return next >= n; },
      processed: function () { return next; },
      total: n,
      step: function (deadline, now) {
        do {
          for (var k = 0; k < CHECK_EVERY && next < n; k++) { add(next); next += 1; }
        } while (next < n && now() < deadline);
        return next >= n;
      },
      result: function () {
        var parts = 0, minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        order.forEach(function (c) {
          parts += c.parts;
          for (var q = 0; q < c.parts; q++) {
            minx = Math.min(minx, c.box[4 * q]); miny = Math.min(miny, c.box[4 * q + 1]); maxx = Math.max(maxx, c.box[4 * q + 2]); maxy = Math.max(maxy, c.box[4 * q + 3]);
          }
        });
        return { classes: order, parts: parts, box: parts ? [minx, miny, maxx, maxy] : null };
      }
    };
  }

  function buildLines(features, classOf) {
    var builder = lineBuilder(features, classOf);
    builder.step(Infinity, function () { return 0; });
    return builder.result();
  }

  /* One path and one stroke per class. styleOf(cls) -> {color, width, alpha, dash} or a falsy value for a class that is not shown. Returns {parts, classes}: how many
   * parts were drawn and which classes drew anything. A part is skipped when its box is outside the view; a vertex within MIN_SEGMENT2 of the last kept one is
   * dropped, except the last vertex of a part. */
  function paintLines(ctx, set, view, styleOf) {
    var s = view.s, ox = view.ox, oy = view.oy, m = 6 / s;
    var x0 = (view.minx + ox) / s - m, y0 = (view.miny + oy) / s - m, x1 = (view.maxx + ox) / s + m, y1 = (view.maxy + oy) / s + m;
    var parts = 0, drawn = [];
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (var ci = 0; ci < set.classes.length; ci++) {
      var c = set.classes[ci], style = styleOf(c.cls);
      if (!style) { continue; }
      var xy = c.xy, box = c.box, offs = c.offs, any = false;
      ctx.beginPath();
      for (var p = 0; p < c.parts; p++) {
        if (box[4 * p + 2] < x0 || box[4 * p] > x1 || box[4 * p + 3] < y0 || box[4 * p + 1] > y1) { continue; }
        var j = offs[p], end = offs[p + 1];
        if (end <= j) { continue; }
        var lx = Math.round(xy[2 * j] * s) - ox, ly = Math.round(xy[2 * j + 1] * s) - oy;
        ctx.moveTo(lx, ly);
        for (j += 1; j < end; j++) {
          var x = Math.round(xy[2 * j] * s) - ox, y = Math.round(xy[2 * j + 1] * s) - oy, dx = x - lx, dy = y - ly;
          if (dx * dx + dy * dy < MIN_SEGMENT2 && j < end - 1) { continue; }
          ctx.lineTo(x, y); lx = x; ly = y;
        }
        any = true; parts += 1;
      }
      if (any) {
        ctx.setLineDash(style.dash || []);
        ctx.globalAlpha = style.alpha; ctx.lineWidth = style.width; ctx.strokeStyle = style.color;
        ctx.stroke();
        drawn.push(c.cls);
      }
    }
    ctx.restore();                                       // also resets the dash and the alpha for the layers drawn after this one
    return { parts: parts, classes: drawn };
  }

  function segmentDistance2(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    var qx = ax + t * dx - px, qy = ay + t * dy - py;
    return qx * qx + qy * qy;
  }

  /* The nearest part to (x, y) in layer pixels among the classes that tolOf(cls) allows (tolOf returns the click tolerance in px, or null for a hidden class), as
   * {feature, cls, dist}, or null when none is within its tolerance. When two are equally near the class drawn later (on top) wins. */
  function hitLines(set, view, x, y, tolOf) {
    var s = view.s, ox = view.ox, oy = view.oy, wxp = (x + ox) / s, wyp = (y + oy) / s, best = null;
    for (var ci = set.classes.length - 1; ci >= 0; ci--) {
      var c = set.classes[ci], tol = tolOf(c.cls);
      if (tol === null || tol === undefined) { continue; }
      var tw = (tol + 1) / s, xy = c.xy, box = c.box, offs = c.offs;
      for (var p = 0; p < c.parts; p++) {
        if (wxp < box[4 * p] - tw || wxp > box[4 * p + 2] + tw || wyp < box[4 * p + 1] - tw || wyp > box[4 * p + 3] + tw) { continue; }
        var j = offs[p], end = offs[p + 1], d2 = Infinity;
        var ax = Math.round(xy[2 * j] * s) - ox, ay = Math.round(xy[2 * j + 1] * s) - oy;
        if (end - j === 1) { d2 = (ax - x) * (ax - x) + (ay - y) * (ay - y); }
        for (j += 1; j < end; j++) {
          var bx = Math.round(xy[2 * j] * s) - ox, by = Math.round(xy[2 * j + 1] * s) - oy;
          d2 = Math.min(d2, segmentDistance2(x, y, ax, ay, bx, by));
          ax = bx; ay = by;
        }
        var dist = Math.sqrt(d2);
        if (dist <= tol && (!best || dist < best.dist)) { best = { feature: c.feat[p], cls: c.cls, dist: dist }; }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ ring sets (county and country outlines)
  /* The rings of every Polygon and MultiPolygon feature in one flat set: offs (vertex offsets, rings + 1), xy (world pixels, interleaved), box (4 per ring). A feature with
   * another geometry type is ignored. */
  function buildRings(features) {
    var rings = [], verts = 0, i, k, j, g, polygons;
    for (i = 0; i < features.length; i++) {
      g = features[i].geometry;
      polygons = g && g.type === "Polygon" ? [g.coordinates] : g && g.type === "MultiPolygon" ? g.coordinates : [];
      for (k = 0; k < polygons.length; k++) {
        for (j = 0; j < polygons[k].length; j++) { rings.push(polygons[k][j]); verts += polygons[k][j].length; }
      }
    }
    var n = rings.length, offs = new Int32Array(n + 1), xy = new Float64Array(verts * 2), box = new Float64Array(n * 4), v = 0;
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (i = 0; i < n; i++) {
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (j = 0; j < rings[i].length; j++) {
        var x = worldX(rings[i][j][0]), y = worldY(rings[i][j][1]);
        xy[2 * v] = x; xy[2 * v + 1] = y; v += 1;
        if (x < x0) { x0 = x; } if (x > x1) { x1 = x; } if (y < y0) { y0 = y; } if (y > y1) { y1 = y; }
      }
      box[4 * i] = x0; box[4 * i + 1] = y0; box[4 * i + 2] = x1; box[4 * i + 3] = y1; offs[i + 1] = v;
      if (x0 < minx) { minx = x0; } if (x1 > maxx) { maxx = x1; } if (y0 < miny) { miny = y0; } if (y1 > maxy) { maxy = y1; }
    }
    return { n: n, offs: offs, xy: xy, box: box, bounds: n ? [minx, miny, maxx, maxy] : null };
  }

  /* All rings in one path, filled (even-odd, so holes stay open) and stroked once. style = {fill: {color, alpha} | null, stroke: {color, width, alpha} | null}. Rings outside the
   * view are skipped; crowded vertices are dropped as in paintLines. Returns how many rings were drawn. */
  function paintRings(ctx, set, view, style) {
    var s = view.s, ox = view.ox, oy = view.oy, m = 6 / s, drawn = 0;
    var x0 = (view.minx + ox) / s - m, y0 = (view.miny + oy) / s - m, x1 = (view.maxx + ox) / s + m, y1 = (view.maxy + oy) / s + m;
    ctx.save();
    ctx.beginPath();
    for (var r = 0; r < set.n; r++) {
      if (set.box[4 * r + 2] < x0 || set.box[4 * r] > x1 || set.box[4 * r + 3] < y0 || set.box[4 * r + 1] > y1) { continue; }
      var j = set.offs[r], end = set.offs[r + 1];
      if (end <= j) { continue; }
      var lx = Math.round(set.xy[2 * j] * s) - ox, ly = Math.round(set.xy[2 * j + 1] * s) - oy;
      ctx.moveTo(lx, ly);
      for (j += 1; j < end; j++) {
        var x = Math.round(set.xy[2 * j] * s) - ox, y = Math.round(set.xy[2 * j + 1] * s) - oy, dx = x - lx, dy = y - ly;
        if (dx * dx + dy * dy < MIN_SEGMENT2) { continue; }
        ctx.lineTo(x, y); lx = x; ly = y;
      }
      ctx.closePath();
      drawn += 1;
    }
    if (drawn && style.fill) { ctx.globalAlpha = style.fill.alpha; ctx.fillStyle = style.fill.color; ctx.fill("evenodd"); }
    if (drawn && style.stroke) {
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.globalAlpha = style.stroke.alpha; ctx.lineWidth = style.stroke.width; ctx.strokeStyle = style.stroke.color; ctx.stroke();
    }
    ctx.restore();
    return drawn;
  }

  return {
    WORLD: WORLD, LOD_ZOOM: LOD_ZOOM, SPRITE_PAD: SPRITE_PAD, MIN_SEGMENT2: MIN_SEGMENT2, CLASS_ORDER: CLASS_ORDER,
    worldX: worldX, worldY: worldY, zoomScale: zoomScale, ringWeight: ringWeight, markerRadius: markerRadius, lodFor: lodFor,
    buildPoints: buildPoints, paintPoints: paintPoints, hitPoints: hitPoints,
    lineBuilder: lineBuilder, buildLines: buildLines, paintLines: paintLines, hitLines: hitLines,
    buildRings: buildRings, paintRings: paintRings
  };
});
