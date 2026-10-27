/* lib.js - pure helpers of the Romanian Energy Grid Atlas page (no DOM, no Leaflet).
 * Sets module.exports when loaded by Node, else window.AtlasLib. Plain script, no build step. */
(function (factory) {
  "use strict";
  var lib = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = lib; } else { window.AtlasLib = lib; }
})(function () {
  "use strict";

  /* The ATR helpers (lib_atr.js) and the page helpers (lib_page.js: "not mapped", the health of the tiles) are own files to keep this one small; they are merged into the library object below. */
  var atrLib = typeof module !== "undefined" && module.exports ? Object.assign({}, require("./lib_atr.js"), require("./lib_page.js")) : Object.assign({}, typeof window !== "undefined" && window.AtlasLibAtr, typeof window !== "undefined" && window.AtlasLibPage);

  var GMAPS = "https://www.google.com/maps/search/?api=1&query=";
  var LATIN = /[A-Za-zÀ-ɏḀ-ỿ]/;
  var OSM_ID = /^osm:(node|way|relation)\/(\d{1,15})$/;
  var LINE_KINDS = { line: 1, minor_line: 1, cable: 1 };
  var NAMED_FUEL = { wind: 1, solar: 1, hydro: 1, gas: 1, coal: 1, nuclear: 1, biomass: 1, battery: 1, oil: 1 };
  var FUEL_NAMES = { wind: "Wind", solar: "Solar", hydro: "Hydro", gas: "Gas", coal: "Coal", nuclear: "Nuclear", biomass: "Biomass", battery: "Battery storage",
    oil: "Oil", other: "Other fuel", unknown: "Fuel not stated" };

  /* Own-property test: a key that comes from data ("constructor", "toString") must never find something on the prototype. */
  function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function trimmed(value) { return typeof value === "string" ? value.trim() : ""; }

  /* Reader name of a fuel key; an unlisted key is shown as its own text with a capital letter, never as something looked up on the prototype. */
  function fuelName(fuel) {
    if (has(FUEL_NAMES, fuel)) { return FUEL_NAMES[fuel]; }
    var text = String(fuel);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  /* CSS colour of a fuel: its token, falling back to the "unknown" grey when the page has no token for it (and for any key that could not be a token name). */
  function fuelColour(fuel) {
    return typeof fuel === "string" && /^[a-z]{1,20}$/.test(fuel) ? "var(--f-" + fuel + ", var(--f-unknown))" : "var(--f-unknown)";
  }

  /* True when the text holds a Latin letter (Romanian diacritics included). Names in other scripts or without letters fall back to generic labels. */
  function hasLatin(text) { return typeof text === "string" && LATIN.test(text); }

  function kvText(kv) { return String(Math.round(kv * 10) / 10); }

  /* "wind plant", "substation", "400 kV line": what an asset without a usable name is called. props: {fuel, kind, kv}. */
  function genericLabel(props) {
    var p = props || {};
    var kind = p.kind, fuel = p.fuel;
    if (kind === "substation") { return "substation"; }
    if (has(LINE_KINDS, kind)) {
      var noun = kind === "cable" ? "cable" : "line";
      return typeof p.kv === "number" && isFinite(p.kv) && p.kv > 0 ? kvText(p.kv) + " kV " + noun : "power " + noun;
    }
    if (kind === "generator") { return has(NAMED_FUEL, fuel) ? fuel + " generator" : "generator"; }
    if (fuel === "battery") { return "battery storage"; }
    return has(NAMED_FUEL, fuel) ? fuel + " plant" : "power plant";
  }

  /* The label shown for a feature: its name when it has Latin letters, else the generic label. Never null or undefined. */
  function placeName(props) {
    var name = trimmed((props || {}).name);
    return hasLatin(name) ? name : genericLabel(props);
  }

  /* Google Maps search link built from words, never from coordinates: "<name or generic>, <county>, Romania". */
  function gmapsLink(props) {
    var parts = [placeName(props)];
    var county = trimmed((props || {}).county);
    if (county) { parts.push(county); }
    parts.push("Romania");
    return GMAPS + encodeURIComponent(parts.join(", "));
  }

  var RADIUS_PER_ROOT_MW = 2.2, RADIUS_MIN = 3, RADIUS_MAX = 40;
  /* The output above which a plant circle stops growing: (RADIUS_MAX / RADIUS_PER_ROOT_MW) squared, about 330 MW. */
  var PLANT_RADIUS_CAP_MW = Math.pow(RADIUS_MAX / RADIUS_PER_ROOT_MW, 2);
  /* The sentence the page prints wherever plant circle sizes are explained (legend, details, about). It must say the cap. */
  var PLANT_SIZE_NOTE = "Circle area is proportional to output (MW) up to a cap of about " + Math.round(PLANT_RADIUS_CAP_MW / 10) * 10 +
    " MW; larger plants are drawn at the maximum size. A hollow ring means the output or the fuel is not stated.";

  /* Circle radius in px for a plant: area proportional to MW (r = 2.2 sqrt(MW), so 100 MW is 22 px) between 3 px (unknown or tiny output) and 40 px
   * (the cap, reached at PLANT_RADIUS_CAP_MW; every larger plant is drawn the same size). */
  function plantRadius(mw) {
    if (typeof mw !== "number" || !isFinite(mw) || mw <= 0) { return RADIUS_MIN; }
    return Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, RADIUS_PER_ROOT_MW * Math.sqrt(mw)));
  }

  /* Index of the highest break that is not above value, clamped to the last break; values below the first break (and NaN) give 0. */
  function breakIndex(value, breaks) {
    var index = 0;
    if (typeof value !== "number" || !isFinite(value)) { return 0; }
    for (var i = 0; i < breaks.length; i++) { if (value >= breaks[i]) { index = i; } }
    return index;
  }

  /* {key: count}; a missing key counts as "unknown". */
  function countBy(items, key) {
    var out = {};
    for (var i = 0; i < items.length; i++) {
      var k = key(items[i]);
      k = k === null || k === undefined ? "unknown" : String(k);
      out[k] = (out[k] || 0) + 1;
    }
    return out;
  }

  /* Like countBy, but every listed category appears (zero included) in the given order, and values not listed are appended. */
  function categoryCounts(items, key, categories) {
    var out = {};
    for (var c = 0; c < categories.length; c++) { out[categories[c]] = 0; }
    var seen = countBy(items, key);
    for (var k in seen) { if (Object.prototype.hasOwnProperty.call(seen, k)) { out[k] = seen[k]; } }
    return out;
  }

  /* "https://www.openstreetmap.org/way/123" for "osm:way/123", else null. */
  function osmUrl(id) {
    var m = typeof id === "string" ? OSM_ID.exec(id) : null;
    return m ? "https://www.openstreetmap.org/" + m[1] + "/" + m[2] : null;
  }

  function formatMw(mw) {
    if (typeof mw !== "number" || !isFinite(mw)) { return "not stated"; }
    var rounded = mw >= 10 ? Math.round(mw * 10) / 10 : Math.round(mw * 100) / 100;
    return rounded + " MW";
  }

  function maxKv(kvs) {
    if (!Array.isArray(kvs) || !kvs.length) { return null; }
    return Math.max.apply(null, kvs);
  }

  function voltageText(kvs) {
    if (!Array.isArray(kvs) || !kvs.length) { return "not stated"; }
    return kvs.map(kvText).join(" / ") + " kV";
  }

  /* Waits for every promise (or plain value) and reports each outcome: [{ok: true, value} | {ok: false, error}]; never rejects, so one failed layer cannot
   * stop the others from being drawn. */
  function settleAll(items) {
    return Promise.all(items.map(function (item) {
      return Promise.resolve(item).then(function (value) { return { ok: true, value: value }; }, function (error) { return { ok: false, error: error }; });
    }));
  }

  /* Starts a load so that a synchronous throw (a malformed layer entry, a missing field) becomes a rejected promise: the layer fails, the page does not. */
  function startLoad(load) { return Promise.resolve().then(load); }

  function ageText(days) {
    if (typeof days !== "number" || !isFinite(days)) { return "age unknown"; }
    if (days === 0) { return "built on the as-of day"; }
    return days + (days === 1 ? " day" : " days") + " old at build";
  }

  // ------------------------------------------------------------------ weather scales
  var NULL_COLOUR = "#B0B0B0";                           // no value: the same neutral grey in both themes
  var WIND_BREAKS = [0, 3, 6, 9, 12, 15];                // m/s, fixed for every step and every run
  var CLOUD_BREAKS = [0, 20, 40, 60, 80];                // percent, 20 percent steps
  /* One-hue sequential ramps, more = more visual weight. Each theme has its own steps (the dark steps are not the light ones reversed by hand): both were run
   * through the dataviz ordinal check against the map ground of that theme (#F3F5F7 light, #151A21 dark): lightness monotone, steps at least 0.06 apart in OKLCH L,
   * the end nearest the ground at least 2:1 against it, one hue. The value is read from lightness, so the ramps survive colour-vision deficiency. */
  var WIND_RAMP = { light: ["#6BB6BA", "#4D9FA3", "#2A888C", "#007176", "#005B61", "#00464C"], dark: ["#0C6468", "#277E82", "#3E989D", "#54B3B8", "#6ACFD4", "#80ECF1"] };
  var CLOUD_RAMP = { light: ["#A5A5BD", "#8888A4", "#6D6D8B", "#535273", "#3A385B"], dark: ["#555571", "#73738E", "#9292AC", "#B3B3CB", "#D5D5EB"] };
  var SCALES = {
    wind: { name: "wind", key: "wind100_ms", label: "Wind at 100 m", unit: "m/s", breaks: WIND_BREAKS, top: Infinity, ramp: WIND_RAMP,
      bucketLabels: ["0 to under 3 m/s", "3 to under 6 m/s", "6 to under 9 m/s", "9 to under 12 m/s", "12 to under 15 m/s", "15 m/s and above"] },
    cloud: { name: "cloud", key: "cloud_pct", label: "Total cloud cover", unit: "%", breaks: CLOUD_BREAKS, top: 100, ramp: CLOUD_RAMP,
      bucketLabels: ["0 to under 20 %", "20 to under 40 %", "40 to under 60 %", "60 to under 80 %", "80 to 100 %"] }
  };

  function weatherScale(name) { return SCALES[name] || null; }
  /* Bucket of a value, or -1 when there is no usable value (null, not a number, negative, or above the physical top of the scale). */
  function scaleIndex(scale, value) {
    if (typeof value !== "number" || !isFinite(value) || value < 0 || value > scale.top) { return -1; }
    return breakIndex(value, scale.breaks);
  }
  function scaleColour(scale, value, dark) {
    var i = scaleIndex(scale, value);
    return i < 0 ? NULL_COLOUR : scale.ramp[dark ? "dark" : "light"][i];
  }
  /* 7-char hex for a 100 m wind speed in m/s (fixed breaks 0, 3, 6, 9, 12, 15); null or invalid gives the neutral grey. dark picks the dark-theme steps. */
  function windColour(ms, dark) { return scaleColour(SCALES.wind, ms, dark); }
  /* 7-char hex for total cloud cover in percent (a new step every 20 percent). */
  function cloudColour(pct, dark) { return scaleColour(SCALES.cloud, pct, dark); }
  /* {buckets: [n per bucket], missing: n}: every value lands in exactly one of them, so the numbers always add up to values.length. */
  function bucketCounts(scale, values) {
    var buckets = scale.bucketLabels.map(function () { return 0; }), missing = 0;
    for (var i = 0; i < values.length; i++) {
      var b = scaleIndex(scale, values[i]);
      if (b < 0) { missing += 1; } else { buckets[b] += 1; }
    }
    return { buckets: buckets, missing: missing };
  }

  // ------------------------------------------------------------------ time
  var FORECAST_MAX_AGE_HOURS = 36;                // hours after its issue at which the page hides a forecast
  var FORECAST_MAX_AGE_HOURS_DEMO = 168;          // the labelled DEMO edition, which is updated periodically and is not a live service, shows it for 7 days (ui.js prints the label beside it)
  function forecastLimitHours(edition) { return edition === "demo" ? FORECAST_MAX_AGE_HOURS_DEMO : FORECAST_MAX_AGE_HOURS; }          // only the exact word "demo": an unknown edition is the short limit
  var formatters = {};
  function formatter(tz, options) {
    var key = tz + "|" + options.id;
    if (!formatters[key]) { formatters[key] = new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: tz }, options.opts)); }
    return formatters[key];
  }
  var LOCAL_FULL = { id: "full", opts: { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } };
  var LOCAL_CLOCK = { id: "clock", opts: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } };
  var LOCAL_DAY = { id: "day", opts: { weekday: "short", day: "numeric", month: "short", year: "numeric" } };
  var LOCAL_DAY_SHORT = { id: "dayshort", opts: { day: "numeric", month: "short" } };

  /* "Thu 15 Oct 2026, 15:00" in the given IANA zone (en-GB, 24 hour clock). */
  function formatLocal(iso, tz) {
    var t = typeof iso === "string" ? Date.parse(iso) : NaN;
    return isFinite(t) ? formatter(tz, LOCAL_FULL).format(new Date(t)) : "time not stated";
  }
  /* "15:00": the clock time only. */
  function formatClock(iso, tz) {
    var t = typeof iso === "string" ? Date.parse(iso) : NaN;
    return isFinite(t) ? formatter(tz, LOCAL_CLOCK).format(new Date(t)) : "";
  }
  /* "2026-10-14 12:00 UTC". */
  function formatUtc(iso) {
    var t = typeof iso === "string" ? Date.parse(iso) : NaN;
    return isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "time not stated";
  }
  /* "Wed 14 Oct 2026" for a calendar day "2026-10-14" (a day label, not an instant: it is the same in every zone). */
  function formatDay(day) {
    var t = typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day + "T12:00:00Z") : NaN;
    return isFinite(t) ? formatter("UTC", LOCAL_DAY).format(new Date(t)) : "day not stated";
  }
  /* Age of a forecast on the browser clock. hours is null when the issue time or the clock is unusable, and then the forecast counts as stale (fail closed). A clock set EARLIER than the issue
   * time by more than CLOCK_SKEW_HOURS (a wrong date, years behind) is unusable too: a negative age must not pass as fresh. Stale means strictly older than the limit of the edition. */
  var CLOCK_SKEW_HOURS = 2;
  var CLOCK_HINT = "check the date and time on your device";
  function forecastAge(issuedIso, nowMs, edition) {
    var t = typeof issuedIso === "string" ? Date.parse(issuedIso) : NaN;
    if (!isFinite(t) || typeof nowMs !== "number" || !isFinite(nowMs)) { return { hours: null, stale: true }; }
    var hours = (nowMs - t) / 3600000;
    if (hours < -CLOCK_SKEW_HOURS) { return { hours: null, stale: true }; }
    return { hours: hours, stale: hours > forecastLimitHours(edition) };
  }
  /* "22 hours old on your clock". Whole hours: rounded down while fresh, rounded up once stale (a forecast 36.4 hours old must not read "36 hours" next to a limit of 36). */
  function forecastAgeText(age) {
    if (age.hours === null) { return "age unknown, " + CLOCK_HINT; }
    var h = Math.max(0, age.stale ? Math.ceil(age.hours) : Math.floor(age.hours));
    return String(h).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (h === 1 ? " hour" : " hours") + " old on your clock";       // 26,304 as en-GB writes it, without loading the locale data on the first paint
  }
  /* The age line of a forecast card: "Forecast 22 hours old on your clock", or "Out of date: 42 hours old on your clock, check the date and time on your device". */
  function forecastCardText(age) {
    if (!age.stale) { return "Forecast " + forecastAgeText(age); }
    return "Out of date: " + forecastAgeText(age) + (age.hours === null ? "" : ", " + CLOCK_HINT);
  }
  /* Index of the last forecast step that is not after nowMs; 0 before the first step, the last index after the last one. */
  function stepAt(steps, nowMs) {
    var index = 0;
    for (var i = 0; i < steps.length; i++) { if (Date.parse(steps[i]) <= nowMs) { index = i; } }
    return index;
  }
  /* Whole hours between the first two steps ("3"), or null when it cannot be told. */
  function stepHours(steps) {
    if (!Array.isArray(steps) || steps.length < 2) { return null; }
    var h = (Date.parse(steps[1]) - Date.parse(steps[0])) / 3600000;
    return isFinite(h) && h > 0 ? h : null;
  }

  // ------------------------------------------------------------------ production stack
  /* A stacked series. series: {fuel: [[iso_start, mw | null], ...]} (each fuel at its own native interval), order: fuels bottom to top.
   * x is the sorted union of all start times. A fuel's value is held across the later x of a finer fuel for as long as its own interval lasts (an hourly value
   * covers its four quarter-hours; nothing is interpolated). A null (or a time the fuel has no interval for) gives null y0 and y1 and the fuels above stack on the
   * non-null ones only. opts.intervalMinutes {fuel: minutes} states the intervals; without it the smallest spacing of the fuel's own times is used. v is the raw value. */
  function stackSeries(series, order, opts) {
    var stated = (opts && opts.intervalMinutes) || {};
    var fuels = order.filter(function (f) { return Array.isArray(series[f]) && series[f].length; });
    var seen = {};
    fuels.forEach(function (f) { series[f].forEach(function (row) { seen[row[0]] = true; }); });
    var x = Object.keys(seen).sort();
    var values = {};
    fuels.forEach(function (f) {
      var rows = series[f].slice().sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
      var span = stated[f] > 0 ? stated[f] * 60000 : smallestSpacing(rows), at = 0, out = [];
      for (var i = 0; i < x.length; i++) {
        while (at + 1 < rows.length && rows[at + 1][0] <= x[i]) { at += 1; }
        var v = rows[0][0] > x[i] ? null : rows[at][1];
        if (v !== null && span !== null) {
          var started = Date.parse(rows[at][0]), here = Date.parse(x[i]);
          if (isFinite(started) && isFinite(here) && here >= started + span) { v = null; }      // beyond the interval this value stands for
        }
        out.push(typeof v === "number" && isFinite(v) ? v : null);
      }
      values[f] = out;
    });
    var layers = fuels.map(function (f) { return { fuel: f, y0: [], y1: [], v: values[f] }; });
    for (var k = 0; k < x.length; k++) {
      var running = 0;
      layers.forEach(function (layer) {
        var v = values[layer.fuel][k];
        if (v === null) { layer.y0.push(null); layer.y1.push(null); return; }
        layer.y0.push(running);
        running += v;
        layer.y1.push(running);
      });
    }
    return { x: x, layers: layers };
  }
  function smallestSpacing(rows) {
    var best = null;
    for (var i = 1; i < rows.length; i++) {
      var d = Date.parse(rows[i][0]) - Date.parse(rows[i - 1][0]);
      if (isFinite(d) && d > 0 && (best === null || d < best)) { best = d; }
    }
    return best;
  }

  /* SVG path data for one layer of a stack drawn as steps: point i covers [t[i], t[i+1]) and the last covers [t[n-1], tEnd). Each run of non-null points is its
   * own closed shape, so a gap in the data is a gap in the drawing. sx and sy map time (ms) and value to pixels. */
  function stepAreaPath(t, tEnd, y0, y1, sx, sy) {
    var parts = [], i = 0, n = t.length;
    var f = function (v) { return String(Math.round(v * 100) / 100); };
    while (i < n) {
      if (y1[i] === null) { i += 1; continue; }
      var j = i;
      while (j + 1 < n && y1[j + 1] !== null) { j += 1; }
      var pts = [], k;
      for (k = i; k <= j; k++) { var right = k + 1 < n ? t[k + 1] : tEnd; pts.push(f(sx(t[k])) + " " + f(sy(y1[k])), f(sx(right)) + " " + f(sy(y1[k]))); }
      for (k = j; k >= i; k--) { var r2 = k + 1 < n ? t[k + 1] : tEnd; pts.push(f(sx(r2)) + " " + f(sy(y0[k])), f(sx(t[k])) + " " + f(sy(y0[k]))); }
      parts.push("M" + pts.join("L") + "Z");
      i = j + 1;
    }
    return parts.join("");
  }

  /* A round upper limit and tick values for an axis that starts at 0: {max, ticks}. */
  function niceScale(maxValue) {
    if (typeof maxValue !== "number" || !isFinite(maxValue) || maxValue <= 0) { return { max: 1, ticks: [0, 1] }; }
    var mag = Math.pow(10, Math.floor(Math.log10(maxValue / 6))), step = mag;
    [1, 2, 2.5, 5, 10].some(function (m) { step = m * mag; return Math.ceil(maxValue / step - 1e-9) <= 6; });        // the smallest round step that needs at most six intervals
    var top = Math.ceil(maxValue / step - 1e-9) * step, ticks = [];
    for (var v = 0; v <= top + step / 2; v += step) { ticks.push(Math.round(v * 1000) / 1000); }
    return { max: top, ticks: ticks };
  }
  /* Times (ms) every `hours` of elapsed time from t0 up to but not including tEnd: the labels show local clock time, so on a 25 hour day they shift by one
   * hour after the clocks change instead of repeating a label. */
  function timeTicks(t0, tEnd, hours) {
    var out = [];
    for (var t = t0; t < tEnd - 1; t += hours * 3600000) { out.push(t); }
    return out;
  }

  /* Non-null intervals per fuel: the numbers the production legend must show (equal to bundle.panel_counts). */
  function panelCounts(obj) {
    var out = {};
    Object.keys(obj.series).forEach(function (fuel) {
      out[fuel] = obj.series[fuel].filter(function (row) { return row[1] !== null && row[1] !== undefined; }).length;
    });
    return out;
  }

  // ------------------------------------------------------------------ production: daily totals (the only production shape of the PUBLIC edition)
  /* The number of days with a total, per fuel: the numbers the legend of the daily-totals card must show (equal to bundle.daily_counts). */
  function dailyCounts(obj) {
    var out = {};
    Object.keys(obj.totals_mwh).forEach(function (fuel) { out[fuel] = obj.totals_mwh[fuel].filter(function (v) { return v !== null && v !== undefined; }).length; });
    return out;
  }
  /* "16 Oct": a calendar day "2026-10-16" without the year or the weekday (a column label), the same in every zone. */
  function formatDayShort(day) {
    var t = typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(day + "T12:00:00Z") : NaN;
    return isFinite(t) ? formatter("UTC", LOCAL_DAY_SHORT).format(new Date(t)) : "day not stated";
  }

  // ------------------------------------------------------------------ shape checks of the three data kinds (a damaged file fails its own layer, never the page)
  function fail(what, why) { throw new Error(what + " is malformed: " + why); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function isIso(v) { return typeof v === "string" && isFinite(Date.parse(v)); }

  function checkWeather(fc) {
    var what = "weather data";
    if (!fc || !Array.isArray(fc.steps) || !fc.steps.length || !fc.steps.every(isIso)) { fail(what, "no valid step times"); }
    if (!Array.isArray(fc.features) || !fc.features.length) { fail(what, "no cells"); }
    var n = fc.steps.length;
    fc.features.forEach(function (f) {
      var ring = f && f.geometry && f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : null, p = f && f.properties;
      if (!Array.isArray(ring) || ring.length < 4 || !ring.every(function (c) { return Array.isArray(c) && isNum(c[0]) && isNum(c[1]); })) { fail(what, "a cell has no polygon"); }
      if (!p || !Array.isArray(p.wind100_ms) || p.wind100_ms.length !== n || !Array.isArray(p.cloud_pct) || p.cloud_pct.length !== n) { fail(what, "a cell does not have one value per step"); }
    });
    return fc;
  }
  function checkRaster(desc, pngPath) {
    var what = "climatology image description";
    if (!desc || typeof desc !== "object") { fail(what, "not an object"); }
    var b = desc.bounds;
    if (typeof desc.png !== "string" || typeof pngPath !== "string" || pngPath.split("/").pop() !== desc.png) { fail(what, "the image name does not match the manifest"); }
    if (!Array.isArray(b) || b.length !== 2 || !b.every(function (c) { return Array.isArray(c) && c.length === 2 && isNum(c[0]) && isNum(c[1]); })) { fail(what, "no bounds"); }
    if (!(b[0][0] < b[1][0] && b[0][1] < b[1][1]) || b[0][0] < 30 || b[1][0] > 60 || b[0][1] < 10 || b[1][1] > 40) { fail(what, "bounds are not a box over Europe"); }
    if (!isNum(desc.vmin) || !isNum(desc.vmax) || !(desc.vmin < desc.vmax)) { fail(what, "vmin and vmax"); }
    if (typeof desc.unit !== "string" || !desc.unit || typeof desc.period_note !== "string") { fail(what, "unit or period note"); }
    return desc;
  }
  function checkPanel(obj) {
    var what = "production data";
    if (!obj || typeof obj.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(obj.day) || typeof obj.tz !== "string") { fail(what, "day or zone"); }
    try { formatter(obj.tz, LOCAL_CLOCK); } catch (e) { fail(what, "unknown time zone"); }
    if (!obj.series || typeof obj.series !== "object" || !Object.keys(obj.series).length) { fail(what, "no series"); }
    if (!obj.interval_minutes || !obj.totals_mwh || !Array.isArray(obj.excluded_columns)) { fail(what, "missing interval, totals or excluded columns"); }
    Object.keys(obj.series).forEach(function (fuel) {
      var rows = obj.series[fuel];
      if (!Array.isArray(rows) || !rows.length || !isNum(obj.interval_minutes[fuel]) || obj.interval_minutes[fuel] <= 0) { fail(what, "series or interval of " + fuel); }
      if (!rows.every(function (r) { return Array.isArray(r) && isIso(r[0]) && (r[1] === null || isNum(r[1])); })) { fail(what, "a value of " + fuel); }
      if (!isNum(obj.totals_mwh[fuel])) { fail(what, "total of " + fuel); }
    });
    return obj;
  }

  /* The daily-totals object (bundle.check_shape, kind daily_totals): zone and unit, one to seven increasing days, and for every fuel one total (a number, or null for a day without data)
   * and one count of missing intervals (a whole number exactly where there is a total) per day. A damaged file fails its own layer. */
  function checkDaily(obj) {
    var what = "production data";
    if (!obj || typeof obj.tz !== "string" || typeof obj.unit !== "string" || !obj.unit) { fail(what, "zone or unit"); }
    try { formatter(obj.tz, LOCAL_CLOCK); } catch (e) { fail(what, "unknown time zone"); }
    var days = obj.days, totals = obj.totals_mwh, gaps = obj.missing_intervals;
    if (!Array.isArray(days) || !days.length || days.length > 7 || !days.every(function (d, k) { return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && isFinite(Date.parse(d + "T12:00:00Z")) && (!k || d > days[k - 1]); })) { fail(what, "days"); }
    if (!totals || typeof totals !== "object" || !gaps || typeof gaps !== "object" || !Object.keys(totals).length) { fail(what, "no totals"); }
    Object.keys(totals).forEach(function (fuel) {
      var values = totals[fuel], counts = gaps[fuel];
      if (!Array.isArray(values) || values.length !== days.length || !Array.isArray(counts) || counts.length !== days.length) { fail(what, "totals of " + fuel); }
      values.forEach(function (v, k) {
        var ok = (v === null && counts[k] === null) || (isNum(v) && Number.isInteger(counts[k]) && counts[k] >= 0);
        if (!ok) { fail(what, "a total or a gap count of " + fuel); }
      });
    });
    if (Object.keys(gaps).length !== Object.keys(totals).length) { fail(what, "gap counts"); }
    return obj;
  }

  // ------------------------------------------------------------------ solar climatology colour bar
  /* The ramp the PNG was coloured with (climatology.PALETTE, viridis sampled at ten even steps, interpolated linearly in sRGB). */
  var SOLAR_RAMP = ["#440154", "#482878", "#3e4a89", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6dcd59", "#b4de2c", "#fde725"];
  function gradientCss(ramp) {
    return "linear-gradient(to right, " + ramp.map(function (c, i) { return c + " " + Math.round(i * 10000 / (ramp.length - 1)) / 100 + "%"; }).join(", ") + ")";
  }

  return Object.assign({
    hasLatin: hasLatin, genericLabel: genericLabel, placeName: placeName, gmapsLink: gmapsLink, plantRadius: plantRadius,
    breakIndex: breakIndex, countBy: countBy, categoryCounts: categoryCounts, osmUrl: osmUrl, formatMw: formatMw,
    maxKv: maxKv, voltageText: voltageText, ageText: ageText, settleAll: settleAll, startLoad: startLoad,
    PLANT_RADIUS_CAP_MW: PLANT_RADIUS_CAP_MW, PLANT_SIZE_NOTE: PLANT_SIZE_NOTE, FUEL_NAMES: FUEL_NAMES, fuelName: fuelName, fuelColour: fuelColour, CLOCK_HINT: CLOCK_HINT,
    CLOCK_SKEW_HOURS: CLOCK_SKEW_HOURS,
    windColour: windColour, cloudColour: cloudColour, weatherScale: weatherScale, scaleColour: scaleColour, bucketCounts: bucketCounts,
    WIND_BREAKS: WIND_BREAKS, CLOUD_BREAKS: CLOUD_BREAKS, WIND_RAMP: WIND_RAMP, CLOUD_RAMP: CLOUD_RAMP, NULL_COLOUR: NULL_COLOUR,
    formatLocal: formatLocal, formatClock: formatClock, formatUtc: formatUtc, formatDay: formatDay, forecastAge: forecastAge, forecastAgeText: forecastAgeText, forecastCardText: forecastCardText,
    FORECAST_MAX_AGE_HOURS: FORECAST_MAX_AGE_HOURS, FORECAST_MAX_AGE_HOURS_DEMO: FORECAST_MAX_AGE_HOURS_DEMO, forecastLimitHours: forecastLimitHours, stepAt: stepAt, stepHours: stepHours,
    stackSeries: stackSeries, stepAreaPath: stepAreaPath, niceScale: niceScale, timeTicks: timeTicks, panelCounts: panelCounts, dailyCounts: dailyCounts, formatDayShort: formatDayShort,
    checkWeather: checkWeather, checkRaster: checkRaster, checkPanel: checkPanel, checkDaily: checkDaily, SOLAR_RAMP: SOLAR_RAMP, gradientCss: gradientCss
  }, atrLib);
});
