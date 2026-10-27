/* lib_page.js - pure helpers of the page that are neither ATR nor weather: the "not mapped" rule of the legends. No DOM, no Leaflet.
 * Loaded before lib.js, which merges these into AtlasLib (window.AtlasLibPage in the browser, require() under Node), so Lib.notMapped and friends exist on the one library object. */
(function (factory) {
  "use strict";
  var page = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = page; } else { window.AtlasLibPage = page; }
})(function () {
  "use strict";

  function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

  var VOLTAGE_NAMES = { "750": "750 kV", "400": "400 kV", "220": "220 kV", "110": "110 kV", other: "Other voltage", unknown: "Voltage not stated" };

  // ------------------------------------------------------------------ "not mapped": zero is not a claim
  /* A class of an OpenStreetMap layer that has no object in the snapshot reads "not mapped": the source holds nothing of that type, which says nothing about the grid. Only the asset layers (points,
   * lines) from OpenStreetMap (an ODbL licence) are meant, and only a real zero; the catch-all classes ("other", "unknown") are not a type, so they keep their number. A zero of any other source
   * (the daily production feed, the ATR bands) is a number the source reported and stays one. */
  var NOT_MAPPED_LABEL = "not mapped";
  var NOT_MAPPED_EXPLANATION = "OpenStreetMap holds no objects of this type in Romania; this does not mean there are none.";
  var CATCH_ALL = { other: 1, unknown: 1 };
  function isOsmAssetLayer(entry) {
    var licence = entry && entry.meta && entry.meta.licence;
    return !!entry && (entry.kind === "points" || entry.kind === "lines") && !!licence && typeof licence.identifier === "string" && /^ODbL/.test(licence.identifier);
  }
  function notMapped(entry, category, count) { return count === 0 && isOsmAssetLayer(entry) && !has(CATCH_ALL, category); }
  /* The classes of a layer that read "not mapped", in the order of its categories, from the counts of the manifest. */
  function notMappedClasses(entry) {
    var counts = entry && entry.counts ? entry.counts : {};
    return (entry && Array.isArray(entry.categories) ? entry.categories : []).filter(function (cat) { return has(counts, cat) && notMapped(entry, cat, counts[cat]); });
  }

  // ------------------------------------------------------------------ how many features: worded as what the number is
  /* "759 OpenStreetMap-mapped plant features in this snapshot": the number of features of an asset layer that the snapshot holds, from the data, worded as what it is, never as the national operating
   * fleet. null for a layer that is not an asset layer and for anything that is not a whole number. */
  var FEATURE_NOUNS = { assets_plants: "plant features", assets_generators_unassigned: "generator features outside a plant", assets_substations: "substation features", assets_lines: "power line features" };
  function featureCountText(layerId, total) {
    if (!has(FEATURE_NOUNS, layerId) || typeof total !== "number" || !isFinite(total) || total < 0 || Math.floor(total) !== total) { return null; }
    return total.toLocaleString("en-GB") + " OpenStreetMap-mapped " + FEATURE_NOUNS[layerId] + " in this snapshot";
  }

  // ------------------------------------------------------------------ base-map tiles
  /* The base map is OpenStreetMap standard tiles. When they do not load the page keeps the county outlines and every layer on a neutral ground and says so once, in plain words; the notice clears
   * when tiles load again. The rule is a pure function of the tile events, so it is tested without a browser: the tiles are DOWN after TILE_FAIL_LIMIT failures in a row with at most
   * TILE_FAIL_WINDOW_MS between two of them (a single slow or failed tile on a bad connection is not an outage; a tile that loads breaks the run), and UP again after TILE_RECOVER_LOADS loads in a
   * row. A state is {fails, loads, lastFailAt, down}; tileEvent never changes the state it is given. */
  var TILE_DOWN_TEXT = "The base map is temporarily unavailable; the data layers still work.";
  var TILE_FAIL_LIMIT = 4, TILE_FAIL_WINDOW_MS = 20000, TILE_RECOVER_LOADS = 2;
  function tileStart() { return { fails: 0, loads: 0, lastFailAt: null, down: false }; }
  function tileEvent(state, kind, at) {
    var s = state && typeof state === "object" ? state : tileStart();
    if ((kind !== "error" && kind !== "load") || typeof at !== "number" || !isFinite(at)) { return s; }
    var next = { fails: s.fails, loads: s.loads, lastFailAt: s.lastFailAt, down: s.down };
    if (kind === "error") {
      next.fails = s.fails > 0 && s.lastFailAt !== null && at - s.lastFailAt <= TILE_FAIL_WINDOW_MS ? s.fails + 1 : 1;
      next.lastFailAt = at;
      next.loads = 0;
      if (next.fails >= TILE_FAIL_LIMIT) { next.down = true; }
    } else {
      next.loads = s.loads + 1;
      next.fails = 0;
      if (next.down && next.loads >= TILE_RECOVER_LOADS) { next.down = false; }
    }
    return next;
  }
  /* What the page must do when the state changed from `before` to `after`: "show" the notice, "clear" it, or nothing. */
  function tileTransition(before, after) { return !before.down && after.down ? "show" : (before.down && !after.down ? "clear" : "none"); }

  // ------------------------------------------------------------------ the context line under the daily production table
  /* A fuel that ENTSO-E reports at 0 MWh on every day is a real value and stays one; the table carries ONE
   * dated, attributed line that says what the number is and what Sol has not verified. The words are the page text of the manifest (page.production_notes.nuclear: three templates tracked in
   * the commercial layer of the registry); only the state and the placeholders are worked out here, from the data:
   *   all_zero  every day with data is under ZERO_CONTEXT_LOW_MWH  (the dated statement of the operator is printed)
   *   restart   low days first, then days at or above it           (a restart inside the window: the shutdown sentence never stands next to positive numbers)
   *   mixed     any other mixture                                  (counted, not placed)
   * null (nothing is printed) when every day with data is at or above the limit, when no day has data, when the fuel is absent or when the manifest holds no template. */
  var ZERO_CONTEXT_FUEL = "nuclear", ZERO_CONTEXT_LOW_MWH = 100;
  var ZERO_REPORTED = "This is the value ENTSO-E reported: 0 MW in every interval of those days that has a value. It is not a gap and not a calculation error";
  var LOW_REPORTED = "These are the values ENTSO-E reported, each under 100 MWh a day. They are not gaps";
  function fillTemplate(template, values) { return template.replace(/\{([a-z_]+)\}/g, function (found, key) { return has(values, key) ? values[key] : found; }); }
  function dailyZeroContext(obj, notes) {
    var templates = notes && typeof notes === "object" ? notes[ZERO_CONTEXT_FUEL] : null;
    var totals = obj && obj.totals_mwh ? obj.totals_mwh[ZERO_CONTEXT_FUEL] : null;
    if (!templates || typeof templates !== "object" || !Array.isArray(totals) || !Array.isArray(obj.days)) { return null; }
    var withData = [], low = [], high = [];
    totals.forEach(function (v, i) {
      if (typeof v !== "number" || !isFinite(v)) { return; }
      withData.push(i);
      (v < ZERO_CONTEXT_LOW_MWH ? low : high).push(i);
    });
    if (!low.length) { return null; }
    var exact = low.every(function (i) { return totals[i] === 0; });
    var values = { zero: exact ? "0 MWh" : "under 100 MWh" }, key;
    if (!high.length) {
      key = "all_zero";
      values.reported = exact ? ZERO_REPORTED : LOW_REPORTED;
    } else if (Math.max.apply(null, low) < Math.min.apply(null, high)) {
      key = "restart";
      values.first_day = obj.days[Math.min.apply(null, high)];
    } else {
      key = "mixed";
      values.low = String(low.length); values.high = String(high.length); values.n = String(withData.length);
    }
    var template = templates[key];
    return typeof template === "string" && template.trim() ? fillTemplate(template, values) : null;
  }

  return {
    dailyZeroContext: dailyZeroContext, ZERO_CONTEXT_LOW_MWH: ZERO_CONTEXT_LOW_MWH,
    TILE_DOWN_TEXT: TILE_DOWN_TEXT, TILE_FAIL_LIMIT: TILE_FAIL_LIMIT, TILE_FAIL_WINDOW_MS: TILE_FAIL_WINDOW_MS, TILE_RECOVER_LOADS: TILE_RECOVER_LOADS,
    tileStart: tileStart, tileEvent: tileEvent, tileTransition: tileTransition,
    featureCountText: featureCountText, VOLTAGE_NAMES: VOLTAGE_NAMES, NOT_MAPPED_LABEL: NOT_MAPPED_LABEL, NOT_MAPPED_EXPLANATION: NOT_MAPPED_EXPLANATION, notMapped: notMapped, notMappedClasses: notMappedClasses
  };
});
