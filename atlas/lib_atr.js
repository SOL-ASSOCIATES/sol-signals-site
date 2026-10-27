/* lib_atr.js - pure helpers of the ATR choropleth layer: aggregation of a county's cells under the filters, the dominant date band, the fixed MW classes,
 * the colours, the county counts that the bundler also computes, the filter lists and the shape check of the layer object. No DOM, no Leaflet.
 * Loaded before lib.js, which merges these into AtlasLib (window.AtlasLibAtr in the browser, require() under Node), so lib.aggregateCounty and friends exist on the one
 * library object. The ids of the date bands are the public ones (a test pins them against the bundler's list); their texts always come from the data. */
(function (factory) {
  "use strict";
  var atr = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = atr; } else { window.AtlasLibAtr = atr; }
})(function () {
  "use strict";

  /* The five date bands in their fixed order (ties between bands go to the earlier one) and the sixth bucket, the residual of detail that is withheld or merged. */
  var ATR_COHORTS = ["before_2024_08_02", "from_2024_08_02_to_2026_05_24", "from_2026_05_25", "date_unknown", "date_conflicted"];
  var ATR_MERGED = "merged";
  var ATR_BREAKS = [0, 250, 1000, 2500, 5000, 10000];             // MW per county, the same for every snapshot and every run

  /* Sequential one-hue ramp for the MW classes (blue). Light: darker = more MW; dark: lighter = more MW. Both were run through the dataviz ordinal check against the map
   * ground of their theme (#F3F5F7 light, #151A21 dark): lightness monotone, steps at least 0.06 apart in OKLCH L, the end nearest the ground at least 2:1 (2.12 / 2.44). */
  var MW_RAMP = { light: ["#70adfb", "#5b97e3", "#4682cc", "#316cb5", "#1b589e", "#004388"], dark: ["#1b589e", "#346fb8", "#4c88d3", "#64a1ee", "#7dbaff", "#96d4ff"] };
  /* The five date-band colours: the three dated bands are an ordinal violet ramp (newer = more visual weight), "unknown" is amber and "disagrees" is rose, "merged" is a
   * neutral grey (it is never a county fill). Validated with the dataviz script, all pairs: normal vision >= 15.9, colour-vision deficiency >= 10 in both themes; the pale
   * violet and the amber sit below 3:1 on the light ground, so every band also has a text label, a count and a table (the relief the validator asks for). */
  var BAND_COLOURS = {
    light: { before_2024_08_02: "#b7a1f5", from_2024_08_02_to_2026_05_24: "#8670c0", from_2026_05_25: "#58428d", date_unknown: "#c38300", date_conflicted: "#ce4a72", merged: "#7c8794" },
    dark: { before_2024_08_02: "#5a3d96", from_2024_08_02_to_2026_05_24: "#876cca", from_2026_05_25: "#b89eff", date_unknown: "#b88000", date_conflicted: "#ce4a72", merged: "#8d9aab" }
  };
  var NEUTRAL = { light: "#c9d0d8", dark: "#3a4452" };             // a county with no dated detail released (and the colour of an unknown id)

  function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function r1(v) { return Math.round(v * 10) / 10; }
  function isCohort(id) { return ATR_COHORTS.indexOf(id) >= 0; }

  /* Index of the highest break that is not above mw (0 for zero and for anything below the first break); -1 when there is no number: a missing value is not a class. */
  function atrMwClass(mw) {
    if (!isNum(mw)) { return -1; }
    var index = 0;
    for (var i = 0; i < ATR_BREAKS.length; i++) { if (mw >= ATR_BREAKS[i]) { index = i; } }
    return index;
  }
  /* "0 to under 250 MW" ... "10,000 MW and above": the labels of the six fixed classes. */
  function atrClassLabels() {
    var fmt = function (v) { return v.toLocaleString("en-GB"); };
    return ATR_BREAKS.map(function (low, i) { return i === ATR_BREAKS.length - 1 ? fmt(low) + " MW and above" : fmt(low) + " to under " + fmt(ATR_BREAKS[i + 1]) + " MW"; });
  }
  /* "7,006.4 MW", "4,127 MW", "0 MW": MW with a thousands separator and at most one decimal; "not stated" when there is no number. */
  function atrMwText(mw) { return isNum(mw) ? mw.toLocaleString("en-GB", { maximumFractionDigits: 1 }) + " MW" : "not stated"; }
  function atrMwColour(mw, dark) {
    var i = atrMwClass(mw);
    return i < 0 ? null : MW_RAMP[dark ? "dark" : "light"][i];
  }
  function cohortColour(id, dark) {
    var set = BAND_COLOURS[dark ? "dark" : "light"];
    return typeof id === "string" && has(set, id) ? set[id] : NEUTRAL[dark ? "dark" : "light"];
  }
  function atrNeutral(dark) { return NEUTRAL[dark ? "dark" : "light"]; }

  /* A county's MW, ATR rows and MW per band for the filters {technology, status, operator} (null or missing = all). A cell is [technology, status, operator, band, MW, n].
   * With any filter set only released detail can match: a merged cell has placeholder values and is left out. A suppressed county has no figures: nulls, never zeros.
   * A row that cannot be placed (unknown band id, no usable MW) is skipped, so the bands always add up to mw. Sums are rounded to 0.1, as the cells are. */
  function aggregateCounty(county, filters) {
    if (!county || typeof county !== "object" || county.suppressed === true) { return { mw: null, n: null, by_cohort: null }; }
    var f = filters || {}, filtered = !!(f.technology || f.status || f.operator);
    var by = {}, mw = 0, n = 0;
    ATR_COHORTS.concat([ATR_MERGED]).forEach(function (id) { by[id] = 0; });
    (Array.isArray(county.cells) ? county.cells : []).forEach(function (row) {
      if (!Array.isArray(row) || row.length < 6 || !(isCohort(row[3]) || row[3] === ATR_MERGED) || !isNum(row[4]) || row[4] < 0) { return; }
      if (row[3] === ATR_MERGED ? filtered : ((f.technology && row[0] !== f.technology) || (f.status && row[1] !== f.status) || (f.operator && row[2] !== f.operator))) { return; }
      by[row[3]] += row[4];
      mw += row[4];
      n += isNum(row[5]) ? row[5] : 0;
    });
    Object.keys(by).forEach(function (id) { by[id] = r1(by[id]); });
    return { mw: r1(mw), n: n, by_cohort: by };
  }

  /* The band with the most MW among the five (ties go to the earlier one in the fixed order); the merged bucket never dominates; null when every band is zero. */
  function dominantCohort(byCohort) {
    var best = null;
    if (!byCohort || typeof byCohort !== "object") { return null; }
    ATR_COHORTS.forEach(function (id) {
      var v = has(byCohort, id) ? byCohort[id] : 0;
      if (isNum(v) && v > 0 && (best === null || v > byCohort[best])) { best = id; }
    });
    return best;
  }

  /* Counties per dominant band, plus the suppressed counties: the numbers the bundler writes to the manifest (bundle.choropleth_counts) and the page's legendCounts. */
  function atrBandCounts(obj) {
    var counts = {};
    ATR_COHORTS.forEach(function (id) { counts[id] = 0; });
    counts.suppressed = 0;
    Object.keys(obj.counties).forEach(function (name) {
      var county = obj.counties[name];
      if (county.suppressed === true) { counts.suppressed += 1; return; }
      var best = dominantCohort(aggregateCounty(county, null).by_cohort);
      if (best !== null) { counts[best] += 1; }
    });
    return counts;
  }

  /* The values the three filter lists offer: the union over the released cells, sorted. The placeholder values of a merged cell are never offered. */
  function atrFilterOptions(obj) {
    var seen = { technology: {}, status: {}, operator: {} };
    var visit = function (county) {
      (county && Array.isArray(county.cells) ? county.cells : []).forEach(function (row) {
        if (!Array.isArray(row) || row[3] === ATR_MERGED) { return; }
        ["technology", "status", "operator"].forEach(function (name, i) { if (typeof row[i] === "string" && row[i]) { seen[name][row[i]] = true; } });
      });
    };
    Object.keys(obj.counties).forEach(function (name) { visit(obj.counties[name]); });
    visit(obj.unknown_county);
    return { technology: Object.keys(seen.technology).sort(), status: Object.keys(seen.status).sort(), operator: Object.keys(seen.operator).sort() };
  }

  /* Share of the MW in the list whose detail is withheld or merged, from the published coverage figures: (merged + suppressed) / total, one decimal. null when it cannot be told. */
  function atrCoverage(totals) {
    var c = totals && totals.coverage;
    if (!totals || !isNum(totals.mw) || totals.mw <= 0 || !c || !isNum(c.detail_merged_mw) || !isNum(c.suppressed_mw)) { return null; }
    var percent = Math.round((c.detail_merged_mw + c.suppressed_mw) / totals.mw * 1000) / 10;
    return { percent: percent, text: "Detail is withheld or merged for " + percent + " percent of the MW in the list, so filters cover only the released detail." };
  }

  /* "Shown under these filters: 808.9 MW of the 80,227.7 MW aggregated from the list (1 percent)": the MW of the published detail that matches the filters against the MW of the list
   * (totals.mw). Computed from published cells and totals only. null when the list total is unusable. */
  function atrShownText(shownMw, totals, filtered) {
    if (!isNum(shownMw) || !totals || !isNum(totals.mw) || totals.mw <= 0) { return null; }
    var percent = Math.round(shownMw / totals.mw * 1000) / 10;
    return (filtered ? "Shown under these filters" : "Shown without filters") + ": " + atrMwText(shownMw) + " of the " + atrMwText(totals.mw) + " aggregated from the list (" + percent + " percent)";
  }

  /* The one sentence that reconciles the part of the list that "Shown without filters" leaves out: the MW and the entries that are in the counties, and in the group with no county, whose detail is
   * withheld under the disclosure thresholds. It states what is done and promises no outcome. Every number is worked out from the data object (the list total, the MW shown, the withheld pool,
   * the withheld counties); nothing is typed. If the withheld pool does not explain the difference the sentence says only what is true: that the rest is not shown. null when nothing is left
   * (a difference under 0.1 MW is rounding). */
  function atrRemainder(obj, shownMw) {
    var t = obj && obj.totals;
    if (!t || !isNum(t.mw) || !isNum(shownMw)) { return null; }
    var rest = r1(t.mw - shownMw);
    if (!(rest >= 0.1)) { return null; }
    var counties = Object.keys(obj.counties || {}).filter(function (name) { return obj.counties[name] && obj.counties[name].suppressed === true; }).length;
    var where = (counties ? [counties + (counties === 1 ? " county" : " counties")] : []).concat(obj.unknown_county && obj.unknown_county.suppressed === true ? ["the group with no county"] : []);
    var exact = where.length > 0 && isNum(t.suppressed_mw) && Math.abs(t.suppressed_mw - rest) <= 0.2 && isNum(t.suppressed_n) && t.suppressed_n >= 0;
    if (!exact) { return "The remaining " + atrMwText(rest) + " are not shown on the map."; }
    return "The remaining " + atrMwText(rest) + " (" + t.suppressed_n.toLocaleString("en-GB") + (t.suppressed_n === 1 ? " entry" : " entries") + ") are in " + where.join(" and ") +
      ", where the detail is withheld under the disclosure thresholds.";
  }

  // ------------------------------------------------------------------ shape check (a damaged object fails its own layer, never the page)
  function fail(why) { throw new Error("ATR data is malformed: " + why); }
  function text(v) { return typeof v === "string" && v.trim() !== ""; }
  function checkBucket(bucket, where) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) { fail(where + " is not an object"); }
    if (!Array.isArray(bucket.cells)) { fail(where + ": cells is not a list"); }
    if (bucket.suppressed === true) {
      if (bucket.mw !== null || bucket.n !== null || bucket.cells.length) { fail(where + ": a suppressed entry holds figures"); }
      return;
    }
    if (!isNum(bucket.mw) || bucket.mw < 0) { fail(where + ": MW is not a number"); }
    if (!isNum(bucket.n) || bucket.n < 0) { fail(where + ": the row count is not a number"); }
    bucket.cells.forEach(function (row) {
      if (!Array.isArray(row) || row.length !== 6) { fail(where + ": a cell is not [technology, status, operator, band, MW, n]"); }
      if (!isCohort(row[3]) && row[3] !== ATR_MERGED) { fail(where + ": unknown band id in a cell"); }
      if (!isNum(row[4]) || row[4] < 0) { fail(where + ": cell MW is not a number"); }
      if (!isNum(row[5]) || row[5] < 0) { fail(where + ": cell row count is not a number"); }
    });
  }
  function checkAtr(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) { fail("not an object"); }
    if (!text(obj.banner)) { fail("banner is missing"); }
    if (!text(obj.cohort_legend_title)) { fail("cohort legend title is missing"); }
    if (!text(obj.band_note)) { fail("band note is missing"); }
    if (typeof obj.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(obj.as_of)) { fail("as_of is not a date"); }
    if (!obj.cohort_labels || typeof obj.cohort_labels !== "object") { fail("cohort_labels is missing"); }
    ATR_COHORTS.forEach(function (id) { if (!has(obj.cohort_labels, id) || !text(obj.cohort_labels[id])) { fail("cohort_labels has no label for " + id); } });
    if (!obj.counties || typeof obj.counties !== "object" || Array.isArray(obj.counties)) { fail("counties is not an object"); }
    var names = Object.keys(obj.counties);
    if (!names.length) { fail("counties is empty"); }
    names.forEach(function (name) { checkBucket(obj.counties[name], "county " + name); });
    if (!has(obj, "unknown_county")) { fail("unknown_county is missing"); }
    checkBucket(obj.unknown_county, "unknown_county");
    var t = obj.totals;
    if (!t || typeof t !== "object" || !isNum(t.mw)) { fail("totals.mw is not a number"); }
    if (!t.by_cohort || typeof t.by_cohort !== "object") { fail("totals.by_cohort is missing"); }
    if (!t.coverage || !isNum(t.coverage.detail_released_mw) || !isNum(t.coverage.detail_merged_mw) || !isNum(t.coverage.suppressed_mw)) { fail("totals.coverage is missing or not numbers"); }
    if (!isNum(t.suppressed_mw)) { fail("totals.suppressed_mw is not a number"); }
    if (typeof t.conflict_assessed !== "boolean") { fail("totals.conflict_assessed is not true or false"); }
    return obj;
  }

  return {
    ATR_COHORTS: ATR_COHORTS, ATR_MERGED: ATR_MERGED, ATR_BREAKS: ATR_BREAKS, ATR_MW_RAMP: MW_RAMP,
    aggregateCounty: aggregateCounty, dominantCohort: dominantCohort, cohortColour: cohortColour, atrNeutral: atrNeutral, atrMwClass: atrMwClass, atrClassLabels: atrClassLabels,
    atrMwColour: atrMwColour, atrMwText: atrMwText, atrShownText: atrShownText, atrRemainder: atrRemainder, atrBandCounts: atrBandCounts, atrFilterOptions: atrFilterOptions, atrCoverage: atrCoverage, checkAtr: checkAtr
  };
});
