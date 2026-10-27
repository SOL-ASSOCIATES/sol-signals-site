/* render_production.js - renderers for the production layer. Both draw no map objects: the layer card shows its own panel.
 *
 * R.daily_totals (manifest kind "daily_totals", the only production shape of the PUBLIC editions): national DAILY TOTALS by fuel for the last seven complete local days.
 * An inline SVG of stacked columns (one per day, MWh), a day left empty and marked "no data" where there is no total (never drawn as zero), an asterisk over a day whose total
 * understates the energy because intervals had no value, a hover / arrow key readout of one day, and under the legend a table of the totals (the text alternative of the chart).
 * The legend rows are the fuels (stack order, top first) with the number of days that have a total.
 *
 * R.panel (manifest kind "panel"): national production by fuel for one local day.
 * The layer card shows its own panel: the day (its own label, never the weather time), an inline SVG stacked area by fuel with a gap
 * wherever a fuel has no value, a hover / arrow key readout, and under the legend a table of daily totals in MWh with the native interval of each fuel (15 min or
 * 60 min as published, never resampled: an hourly value is drawn as one hourly step). The legend rows are the fuels (stack order, top first) with their native
 * interval and the number of intervals that have a value. The SVG carries a title and a description and the totals table is its text alternative.
 * The interval panel is no layer of the PUBLIC bundle (per-interval series do not leave the machine); the renderer stays for other editions and is tested with a synthetic layer. */
(function () {
  "use strict";
  var Lib = window.AtlasLib, UI = window.AtlasUI;
  var R = (window.AtlasRenderers = window.AtlasRenderers || {});

  /* Bottom to top. The order is searched, not physical: with the fuel colours of the page (the validated set of the map markers) some neighbours would be hard to tell
   * apart, in particular oil next to biomass (normal-vision difference 13, red-green colour blindness 3). This order was found by trying every order of the ten
   * coloured fuels against the 32 usual days (any mix of no oil, no battery, no biomass, no other, no solar) in both themes: every pair of neighbours clears the
   * dataviz validator (protan and deutan at least 11, normal vision at least 18). The two grey buckets "other" and "unknown" share one colour on purpose (as in the
   * map legend) and sit together; the legend, the readout and the table name them apart. */
  var STACK_ORDER = ["nuclear", "coal", "solar", "wind", "other", "unknown", "gas", "biomass", "battery", "hydro", "oil"];
  var W = 340, H = 232, ML = 46, MR = 8, MT = 24, MB = 26, PW = W - ML - MR, PH = H - MT - MB;
  var TICK_HOURS = 3;

  var fuelName = Lib.fuelName;
  function fmtMw(n) { return Math.round(n).toLocaleString("en-GB") + " MW"; }
  function fmtMwh(n) { return n.toLocaleString("en-GB", { maximumFractionDigits: n >= 100 ? 0 : 1 }); }
  function fuelOrder(obj) {
    var known = STACK_ORDER.filter(function (f) { return obj.series[f]; });
    return known.concat(Object.keys(obj.series).filter(function (f) { return STACK_ORDER.indexOf(f) < 0; }).sort());
  }

  /* Everything the chart and the readout need, computed once from the loaded object. */
  function model(obj) {
    var order = fuelOrder(obj), stack = Lib.stackSeries(obj.series, order, { intervalMinutes: obj.interval_minutes });
    var times = stack.x.map(function (iso) { return Date.parse(iso); });
    var tEnd = 0;
    order.forEach(function (f) {
      var rows = obj.series[f];
      tEnd = Math.max(tEnd, Date.parse(rows[rows.length - 1][0]) + obj.interval_minutes[f] * 60000);
    });
    var top = times.map(function (_, i) {
      var best = null;
      stack.layers.forEach(function (layer) { if (layer.y1[i] !== null && (best === null || layer.y1[i] > best)) { best = layer.y1[i]; } });
      return best;
    });
    var peak = -1, peakIndex = -1;
    top.forEach(function (v, i) { if (v !== null && v > peak) { peak = v; peakIndex = i; } });
    var partial = times.map(function (_, i) { return stack.layers.some(function (layer) { return layer.v[i] === null; }); });     // at least one fuel has no value at that interval
    return { order: order, stack: stack, times: times, t0: times[0], tEnd: tEnd, top: top, partial: partial, peak: Math.max(peak, 0), peakIndex: peakIndex, hours: (tEnd - times[0]) / 3600000 };
  }

  /* Index of the interval that holds the time t (ms), or -1 outside the day. */
  function indexAt(times, tEnd, t) {
    if (!(t >= times[0] && t < tEnd)) { return -1; }
    var lo = 0, hi = times.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (times[mid] <= t) { lo = mid; } else { hi = mid - 1; } }
    return lo;
  }

  /* A sum over fewer fuels than the chart has is not "Total": it says so. */
  function totalWord(m, index) { return m.partial[index] ? "Total of the fuels with a value" : "Total"; }

  function readout(m, tz, index) {
    var iso = m.stack.x[index], parts = [];
    m.stack.layers.slice().reverse().forEach(function (layer) { parts.push(fuelName(layer.fuel) + " " + (layer.v[index] === null ? "no value" : fmtMw(layer.v[index]))); });
    return "Interval starting " + Lib.formatLocal(iso, tz) + " local (" + Lib.formatUtc(iso) + "). " + (m.top[index] === null ? "No fuel has a value. " : totalWord(m, index) + " " + fmtMw(m.top[index]) + ". ") + parts.join("; ") + ".";
  }

  // ------------------------------------------------------------------ the chart
  function buildChart(obj, m) {
    var tz = obj.tz, span = m.tEnd - m.t0, svgId = "prod-chart";
    var sx = function (t) { return ML + (t - m.t0) / span * PW; };
    var scale = Lib.niceScale(m.peak), sy = function (v) { return MT + PH - v / scale.max * PH; };
    var dayText = Lib.formatDay(obj.day);
    var title = "Stacked area chart: national electricity production by fuel, " + dayText;
    var desc = "Mean power in MW for each fuel over the " + tz + " calendar day " + dayText + " (" + (Math.round(m.hours * 100) / 100) + " hours). " +
      (m.peakIndex >= 0 ? "The highest " + totalWord(m, m.peakIndex).toLowerCase() + " is " + fmtMw(m.peak) + " in the interval starting " + Lib.formatClock(m.stack.x[m.peakIndex], tz) + " local. " : "No interval has a value. ") +
      "A gap in an area means that fuel has no published value in that interval. The table of daily totals below gives the same data as numbers.";
    var kids = [UI.svg("title", { id: svgId + "-title", text: title }), UI.svg("desc", { id: svgId + "-desc", text: desc })];

    // intervals where at least one fuel has no value: a shaded band behind the areas
    var bandStart = -1;
    m.partial.concat([false]).forEach(function (isGap, i) {
      if (isGap && bandStart < 0) { bandStart = i; }
      if (!isGap && bandStart >= 0) {
        var x0 = sx(m.times[bandStart]), x1 = sx(i < m.times.length ? m.times[i] : m.tEnd);
        kids.push(UI.svg("rect", { class: "prod-gap", x: x0.toFixed(1), y: MT, width: Math.max(1.5, x1 - x0).toFixed(1), height: PH, "data-role": "gap" }));
        bandStart = -1;
      }
    });
    scale.ticks.forEach(function (v) {
      kids.push(UI.svg("line", { class: v === 0 ? "prod-axis" : "prod-grid", x1: ML, x2: W - MR, y1: sy(v).toFixed(1), y2: sy(v).toFixed(1) }));
      kids.push(UI.svg("text", { class: "prod-label", x: ML - 5, y: (sy(v) + 3.5).toFixed(1), "text-anchor": "end", text: v.toLocaleString("en-GB") }));
    });
    kids.push(UI.svg("text", { class: "prod-label prod-unit", x: ML - 5, y: MT - 14, "text-anchor": "end", text: "MW" }));
    m.stack.layers.forEach(function (layer) {
      kids.push(UI.svg("path", { class: "prod-area", "data-fuel": layer.fuel, d: Lib.stepAreaPath(m.times, m.tEnd, layer.y0, layer.y1, sx, sy) }));
    });
    Lib.timeTicks(m.t0, m.tEnd, TICK_HOURS).forEach(function (t, k) {
      kids.push(UI.svg("line", { class: "prod-axis", x1: sx(t).toFixed(1), x2: sx(t).toFixed(1), y1: MT + PH, y2: MT + PH + 3 }));
      if (k % 2 === 0) {                                  // a mark every 3 hours, a label every 6 (the chart is narrow)
        kids.push(UI.svg("text", { class: "prod-label", x: sx(t).toFixed(1), y: MT + PH + 14, "text-anchor": k === 0 ? "start" : "middle", text: Lib.formatClock(new Date(t).toISOString(), tz) }));
      }
    });
    var sel = UI.svg("rect", { class: "prod-sel", x: 0, y: MT, width: 1.5, height: PH, visibility: "hidden" });
    var hit = UI.svg("rect", { class: "prod-hit", x: ML, y: MT, width: PW, height: PH, fill: "transparent" });
    kids.push(sel, hit);
    var svg = UI.svg("svg", { class: "prod-chart", viewBox: "0 0 " + W + " " + H, role: "img", tabindex: "0", "aria-labelledby": svgId + "-title " + svgId + "-desc", focusable: "true" }, kids);
    return { svg: svg, sel: sel, hit: hit, sx: sx };
  }

  function buildPanel(entry, obj, m) {
    var chart = buildChart(obj, m), tz = obj.tz, current = -1;
    var out = UI.el("p", { class: "prod-readout", "aria-live": "polite", "data-role": "readout", text: "Move over the chart, or focus it and use the arrow keys, to read the values of one interval." });
    function select(index) {
      current = index;
      if (index < 0) {
        chart.sel.setAttribute("visibility", "hidden");
        out.textContent = "Move over the chart, or focus it and use the arrow keys, to read the values of one interval.";
        return -1;
      }
      var x0 = chart.sx(m.times[index]), x1 = chart.sx(index + 1 < m.times.length ? m.times[index + 1] : m.tEnd);
      chart.sel.setAttribute("x", x0.toFixed(1));
      chart.sel.setAttribute("width", Math.max(1.5, x1 - x0).toFixed(1));
      chart.sel.setAttribute("visibility", "visible");
      out.textContent = readout(m, tz, index);
      return index;
    }
    var follow = function (ev) {                                       // a pointer over the plot, or a tap on it, reads the interval under it
      var box = chart.svg.getBoundingClientRect(), x = (ev.clientX - box.left) / box.width * W;
      select(indexAt(m.times, m.tEnd, m.t0 + (x - ML) / PW * (m.tEnd - m.t0)));
    };
    chart.hit.addEventListener("pointermove", follow);
    chart.hit.addEventListener("pointerdown", follow);
    chart.hit.addEventListener("pointerleave", function (ev) { if (ev.pointerType !== "touch") { select(-1); } });         // a finger lifted after a tap keeps its reading
    chart.svg.addEventListener("keydown", function (ev) {
      var last = m.times.length - 1, next = current;
      if (ev.key === "ArrowRight") { next = current < 0 ? 0 : Math.min(last, current + 1); }
      else if (ev.key === "ArrowLeft") { next = current < 0 ? last : Math.max(0, current - 1); }
      else if (ev.key === "Home") { next = 0; }
      else if (ev.key === "End") { next = last; }
      else if (ev.key === "Escape") { next = -1; }
      else { return; }
      ev.preventDefault();
      select(next);
    });
    var hoursText = Math.round(m.hours * 100) / 100;
    var odd = hoursText === 24 ? null : UI.el("p", { class: "prod-note", text: "This local day has " + hoursText + " hours because the clocks changed; the axis counts real elapsed hours." });
    var head = UI.el("div", { class: "layer-extra prod-head" }, [
      UI.el("p", { class: "prod-day", "data-role": "day" }, [UI.el("strong", { text: "Day: " }), Lib.formatDay(obj.day) + " (" + obj.tz + " calendar day) ",
        UI.el("span", { class: "chip ev-" + entry.meta.evidence_label, text: entry.meta.evidence_label })]),
      UI.el("p", { class: "prod-note", text: "This is the production day, with its own label. It is not the weather forecast time." }),
      odd,
      UI.el("p", { class: "prod-note", text: "Mean power per interval in MW, stacked by fuel. A shaded band marks intervals in which at least one fuel has no value: that area is left empty, not drawn as zero." }),
      chart.svg, out
    ]);
    return { head: head, select: select, current: function () { return current; } };
  }

  // ------------------------------------------------------------------ totals table (also the text alternative of the chart)
  function buildTable(obj, m) {
    var fuels = m.order.slice().reverse(), sum = 0, missingAll = 0;
    var rows = fuels.map(function (fuel) {
      var rowsOf = obj.series[fuel], present = rowsOf.filter(function (r) { return r[1] !== null; }).length, missing = rowsOf.length - present;
      sum += obj.totals_mwh[fuel];
      missingAll += missing;
      return UI.el("tr", { "data-fuel": fuel }, [UI.el("th", { scope: "row", text: fuelName(fuel) }), UI.el("td", { text: obj.interval_minutes[fuel] + " min" }),
        UI.el("td", { class: "num", text: fmtMwh(obj.totals_mwh[fuel]) }), UI.el("td", { class: "num", text: String(missing) })]);
    });
    rows.push(UI.el("tr", { class: "prod-total", "data-fuel": "total" }, [UI.el("th", { scope: "row", text: "Total" }), UI.el("td", { text: "" }), UI.el("td", { class: "num", text: fmtMwh(sum) }),
      UI.el("td", { class: "num", text: String(missingAll) })]));
    var table = UI.el("table", { class: "prod-table" }, [UI.el("caption", { text: "Daily totals in MWh, " + Lib.formatDay(obj.day) }),
      UI.el("thead", {}, [UI.el("tr", {}, ["Fuel", "Native interval", "Energy (MWh)", "Intervals with no value"].map(function (t) { return UI.el("th", { scope: "col", text: t }); }))]),
      UI.el("tbody", {}, rows)]);
    var excluded = obj.excluded_columns.length ? obj.excluded_columns.join("; ") : "none in this day's data";
    return UI.el("div", { class: "layer-extra prod-foot" }, [table,
      UI.el("p", { class: "prod-note", text: "Energy is the mean power times the interval length, added up over the intervals that have a value; each fuel keeps the interval it was published at." +
        (missingAll ? " Intervals with no value are left out, so the totals of a day with gaps understate the energy." : "") }),
      UI.el("p", { class: "prod-note", "data-role": "excluded", text: "Excluded: consumption and pumping columns (" + excluded + "). Hydro and battery figures are generation only, not net of charging." })]);
  }

  R.panel = {
    load: function (entry, ctx) {
      return ctx.fetchJson(entry.files.data).then(function (obj) {
        Lib.checkPanel(obj);
        var m = model(obj), panel = buildPanel(entry, obj, m);
        return { obj: obj, m: m, head: panel.head, foot: buildTable(obj, m), select: panel.select, shown: false };
      });
    },
    show: function (entry, state) { state.shown = true; },
    hide: function (entry, state) { state.shown = false; },
    counts: function (entry, state) { return Lib.panelCounts(state.obj); },
    info: function (entry, state) {
      return { day: state.obj.day, tz: state.obj.tz, fuels: state.m.order.slice().reverse(), intervals: state.m.times.length, hours: state.m.hours, peakMw: state.m.peak };
    },
    legend: function (entry, state) {
      var counts = Lib.panelCounts(state.obj);
      var rows = state.m.order.slice().reverse().map(function (fuel) {
        return { key: fuel, label: fuelName(fuel), sub: state.obj.interval_minutes[fuel] + " min", count: counts[fuel], swatch: { shape: "square", c: Lib.fuelColour(fuel), s: 13 } };
      });
      return { rows: rows, extra: state.head, after: state.foot, note: "Stack order is fixed for readability, not ranked by size." };
    }
  };

  // ================================================================== daily totals (kind "daily_totals")
  var DW = 340, DH = 232, DML = 50, DMR = 8, DMT = 24, DMB = 30, DPW = DW - DML - DMR, DPH = DH - DMT - DMB;

  /* The fuels bottom to top (STACK_ORDER first, then any other key by name), and per day: the stacked pieces, the total of the fuels that have a value, and whether the total understates
   * the energy (an interval of a fuel had no value). A negative total is read out as it is but stacks as zero. */
  function dailyModel(obj) {
    var known = STACK_ORDER.filter(function (f) { return obj.totals_mwh[f]; });
    var order = known.concat(Object.keys(obj.totals_mwh).filter(function (f) { return STACK_ORDER.indexOf(f) < 0; }).sort());
    var columns = obj.days.map(function (day, i) {
      var level = 0, parts = [], total = 0, any = false, understated = false;
      order.forEach(function (fuel) {
        var v = obj.totals_mwh[fuel][i];
        if (v === null) { parts.push({ fuel: fuel, v: null, y0: null, y1: null }); return; }
        any = true;
        total += v;
        if (obj.missing_intervals[fuel][i] > 0) { understated = true; }
        var y0 = level;
        level += Math.max(v, 0);
        parts.push({ fuel: fuel, v: v, y0: y0, y1: level });
      });
      return { day: day, parts: parts, total: total, any: any, understated: understated, top: level };
    });
    var peak = 0, peakIndex = -1;
    columns.forEach(function (c, i) { if (c.any && c.top > peak) { peak = c.top; peakIndex = i; } });
    return { order: order, columns: columns, peak: peak, peakIndex: peakIndex, withData: columns.filter(function (c) { return c.any; }).length };
  }

  function dailyReadout(m, obj, index) {
    var c = m.columns[index], label = Lib.formatDay(c.day);
    if (!c.any) { return label + " (" + obj.tz + " calendar day): no data for this day. It is left empty; it is not zero."; }
    var parts = c.parts.slice().reverse().map(function (p) { return fuelName(p.fuel) + " " + (p.v === null ? "no value" : fmtMwh(p.v) + " MWh"); });
    var sentences = [label + " (" + obj.tz + " calendar day).", (c.parts.some(function (p) { return p.v === null; }) ? "Total of the fuels with a value " : "Total ") + fmtMwh(c.total) + " MWh.", parts.join("; ") + "."];
    if (c.understated) { sentences.push("Some intervals have no value, so this total understates the energy of the day."); }
    return sentences.join(" ");
  }

  function dailyChart(entry, obj, m) {
    var n = obj.days.length, band = DPW / n, barW = Math.max(6, Math.min(band * 0.7, 34)), svgId = "prod-daily-chart";
    var sx = function (i) { return DML + band * i + (band - barW) / 2; };
    var scale = Lib.niceScale(m.peak), sy = function (v) { return DMT + DPH - v / scale.max * DPH; };
    var first = Lib.formatDay(obj.days[0]), last = Lib.formatDay(obj.days[n - 1]);
    var title = "Stacked column chart: national electricity production by fuel, daily totals in MWh, " + first + " to " + last;
    var desc = "One column for each of the last " + n + " complete " + obj.tz + " calendar days, stacked by fuel. " + m.withData + " of the " + n + " days have data. " +
      (m.peakIndex >= 0 ? "The highest day is " + Lib.formatDay(obj.days[m.peakIndex]) + " with " + fmtMwh(m.columns[m.peakIndex].total) + " MWh. " : "No day has data. ") +
      "A day without data is left empty and marked no data; it is not zero. The table of daily totals below gives the same numbers.";
    var kids = [UI.svg("title", { id: svgId + "-title", text: title }), UI.svg("desc", { id: svgId + "-desc", text: desc })];
    scale.ticks.forEach(function (v) {
      kids.push(UI.svg("line", { class: v === 0 ? "prod-axis" : "prod-grid", x1: DML, x2: DW - DMR, y1: sy(v).toFixed(1), y2: sy(v).toFixed(1) }));
      kids.push(UI.svg("text", { class: "prod-label", x: DML - 5, y: (sy(v) + 3.5).toFixed(1), "text-anchor": "end", text: v.toLocaleString("en-GB") }));
    });
    kids.push(UI.svg("text", { class: "prod-label prod-unit", x: DML - 5, y: DMT - 14, "text-anchor": "end", text: "MWh per day" }));
    m.columns.forEach(function (c, i) {
      var x = sx(i);
      if (!c.any) {                                         // a day without data: an empty dashed column marked "no data", never a bar of zero height
        kids.push(UI.svg("rect", { class: "prod-gap", "data-role": "nodata", "data-day": c.day, x: x.toFixed(1), y: DMT, width: barW.toFixed(1), height: DPH }));
        kids.push(UI.svg("text", { class: "prod-label prod-nodata", x: (x + barW / 2).toFixed(1), y: (DMT + DPH / 2).toFixed(1), "text-anchor": "middle", text: "no data" }));
        return;
      }
      c.parts.forEach(function (p) {
        if (p.v === null || p.y1 <= p.y0) { return; }
        kids.push(UI.svg("rect", { class: "prod-bar", "data-fuel": p.fuel, "data-day": c.day, x: x.toFixed(1), y: sy(p.y1).toFixed(1), width: barW.toFixed(1), height: Math.max(0.5, sy(p.y0) - sy(p.y1)).toFixed(1) }));
      });
      if (c.understated) { kids.push(UI.svg("text", { class: "prod-label prod-flag", "data-role": "understated", x: (x + barW / 2).toFixed(1), y: (sy(c.top) - 3).toFixed(1), "text-anchor": "middle", text: "*" })); }
    });
    m.columns.forEach(function (c, i) {
      kids.push(UI.svg("line", { class: "prod-axis", x1: (sx(i) + barW / 2).toFixed(1), x2: (sx(i) + barW / 2).toFixed(1), y1: DMT + DPH, y2: DMT + DPH + 3 }));
      kids.push(UI.svg("text", { class: "prod-label", "data-role": "daylabel", x: (sx(i) + barW / 2).toFixed(1), y: DMT + DPH + 15, "text-anchor": "middle", text: Lib.formatDayShort(c.day) }));
    });
    var sel = UI.svg("rect", { class: "prod-sel", x: 0, y: DMT, width: band.toFixed(1), height: DPH, visibility: "hidden" });
    var hit = UI.svg("rect", { class: "prod-hit", x: DML, y: DMT, width: DPW, height: DPH, fill: "transparent" });
    kids.push(sel, hit);
    var svg = UI.svg("svg", { class: "prod-chart", viewBox: "0 0 " + DW + " " + DH, role: "img", tabindex: "0", "aria-labelledby": svgId + "-title " + svgId + "-desc", focusable: "true" }, kids);
    return { svg: svg, sel: sel, hit: hit, band: band };
  }

  var DAILY_HINT = "Move over the chart, or focus it and use the arrow keys, to read the values of one day.";

  function dailyHead(entry, obj, m) {
    var chart = dailyChart(entry, obj, m), n = obj.days.length, current = -1;
    var out = UI.el("p", { class: "prod-readout", "aria-live": "polite", "data-role": "readout", text: DAILY_HINT });
    function select(index) {
      current = index;
      if (index < 0) {
        chart.sel.setAttribute("visibility", "hidden");
        out.textContent = DAILY_HINT;
        return -1;
      }
      chart.sel.setAttribute("x", (DML + chart.band * index).toFixed(1));
      chart.sel.setAttribute("visibility", "visible");
      out.textContent = dailyReadout(m, obj, index);
      return index;
    }
    var follow = function (ev) {                                       // a pointer over the plot, or a tap on it, reads the day under it
      var box = chart.svg.getBoundingClientRect(), x = (ev.clientX - box.left) / box.width * DW;
      var index = Math.floor((x - DML) / chart.band);
      select(index >= 0 && index < n ? index : -1);
    };
    chart.hit.addEventListener("pointermove", follow);
    chart.hit.addEventListener("pointerdown", follow);
    chart.hit.addEventListener("pointerleave", function (ev) { if (ev.pointerType !== "touch") { select(-1); } });
    chart.svg.addEventListener("keydown", function (ev) {
      var next = current;
      if (ev.key === "ArrowRight") { next = current < 0 ? 0 : Math.min(n - 1, current + 1); }
      else if (ev.key === "ArrowLeft") { next = current < 0 ? n - 1 : Math.max(0, current - 1); }
      else if (ev.key === "Home") { next = 0; }
      else if (ev.key === "End") { next = n - 1; }
      else if (ev.key === "Escape") { next = -1; }
      else { return; }
      ev.preventDefault();
      select(next);
    });
    var head = UI.el("div", { class: "layer-extra prod-head" }, [
      UI.el("p", { class: "prod-day", "data-role": "day" }, [UI.el("strong", { text: "Days: " }), Lib.formatDay(obj.days[0]) + " to " + Lib.formatDay(obj.days[n - 1]) + " (" + obj.tz + " calendar days) ",
        UI.el("span", { class: "chip ev-" + entry.meta.evidence_label, text: entry.meta.evidence_label })]),
      UI.el("p", { class: "prod-note", text: "Totals of the last " + n + " complete local days, in MWh per day, stacked by fuel. This is not the weather forecast time." }),
      UI.el("p", { class: "prod-note", text: "A day with no data is left empty and marked no data: it is not zero. An asterisk marks a day whose total understates the energy because some intervals had no value." }),
      chart.svg, out
    ]);
    return { head: head, select: select, current: function () { return current; } };
  }

  /* The table is the text alternative of the chart: a row per fuel (top of the stack first), a column per day, the total of the fuels with a value, in a box that scrolls on a narrow screen. */
  function dailyTable(obj, m, notes) {
    var fuels = m.order.slice().reverse(), n = obj.days.length;
    var cell = function (fuel, i) {
      var v = obj.totals_mwh[fuel][i];
      if (v === null) { return UI.el("td", { class: "num is-empty", text: "no data" }); }
      return UI.el("td", { class: "num", text: fmtMwh(v) + (obj.missing_intervals[fuel][i] > 0 ? " *" : "") });
    };
    var rows = fuels.map(function (fuel) {
      var kids = [UI.el("th", { scope: "row", text: fuelName(fuel) })];
      for (var i = 0; i < n; i++) { kids.push(cell(fuel, i)); }
      return UI.el("tr", { "data-fuel": fuel }, kids);
    });
    var totalCells = [UI.el("th", { scope: "row", text: "Total" })];
    m.columns.forEach(function (c) { totalCells.push(UI.el("td", { class: "num" + (c.any ? "" : " is-empty"), text: c.any ? fmtMwh(c.total) + (c.understated ? " *" : "") : "no data" })); });
    rows.push(UI.el("tr", { class: "prod-total", "data-fuel": "total" }, totalCells));
    var head = [UI.el("th", { scope: "col", text: "Fuel (MWh)" })].concat(obj.days.map(function (d) { return UI.el("th", { scope: "col", text: Lib.formatDayShort(d) }); }));
    var caption = "Daily totals in MWh, " + Lib.formatDay(obj.days[0]) + " to " + Lib.formatDay(obj.days[n - 1]);          // read once (the table's own caption); a copy above the box shows it whole
    var table = UI.el("table", { class: "prod-table prod-daily-table" }, [UI.el("caption", { class: "sr-only", text: caption }), UI.el("thead", {}, [UI.el("tr", {}, head)]), UI.el("tbody", {}, rows)]);
    var anyStar = m.columns.some(function (c) { return c.understated; });
    return UI.el("div", { class: "layer-extra prod-foot" }, [UI.el("p", { class: "prod-caption", "aria-hidden": "true", text: caption }),
      UI.el("div", { class: "prod-scroll", tabindex: "0", role: "region", "aria-label": "Table of daily production totals" }, [table]),
      UI.el("p", { class: "prod-note", text: "Each total is the mean power times the interval length, added up over the intervals that have a value; Sol Associates computes it from the values ENTSO-E published." +
        (anyStar ? " A total marked * leaves out intervals that had no value, so it understates the energy of that day." : "") }),
      UI.el("p", { class: "prod-note", text: "Hydro and battery figures are generation only, not net of charging." }),
      zeroLine(obj, notes)]);
  }

  /* The context line of a fuel that ENTSO-E reports at 0 on every day with data: built by Lib.dailyZeroContext from the data and the page text of the manifest; nothing when the
   * data do not call for it or the manifest holds no text. */
  function zeroLine(obj, notes) {
    var line = Lib.dailyZeroContext(obj, notes);
    return line ? UI.el("p", { class: "prod-note", "data-role": "zero-context", text: line }) : null;
  }

  /* A fuel with a total on at least one day and a total of exactly 0 on every day that has one: the legend says so, so that a bar of no height does not look like a drawing fault. */
  function zeroOnly(obj, fuel) {
    var values = (obj.totals_mwh[fuel] || []).filter(function (v) { return v !== null; });
    return values.length > 0 && values.every(function (v) { return v === 0; });
  }

  R.daily_totals = {
    load: function (entry, ctx) {
      return ctx.fetchJson(entry.files.data).then(function (obj) {
        Lib.checkDaily(obj);
        var m = dailyModel(obj), panel = dailyHead(entry, obj, m);
        return { obj: obj, m: m, head: panel.head, foot: dailyTable(obj, m, ctx.page && ctx.page.production_notes ? ctx.page.production_notes : null), select: panel.select, shown: false };
      });
    },
    show: function (entry, state) { state.shown = true; },
    hide: function (entry, state) { state.shown = false; },
    counts: function (entry, state) { return Lib.dailyCounts(state.obj); },
    info: function (entry, state) {
      return { days: state.obj.days.slice(), tz: state.obj.tz, fuels: state.m.order.slice().reverse(), daysWithData: state.m.withData, peakMwh: state.m.peak };
    },
    legend: function (entry, state) {
      var counts = Lib.dailyCounts(state.obj), n = state.obj.days.length;
      var rows = state.m.order.slice().reverse().map(function (fuel) {
        return { key: fuel, label: fuelName(fuel), sub: (zeroOnly(state.obj, fuel) ? "0 reported on " : "") + counts[fuel] + " of " + n + " days", count: counts[fuel], swatch: { shape: "square", c: Lib.fuelColour(fuel), s: 13 } };
      });
      return { rows: rows, extra: state.head, after: state.foot, note: "Stack order is fixed for readability, not ranked by size. The count is the number of days with a total. "
        + "A value of 0 means ENTSO-E reported 0 MW for that fuel in every interval of that day that has a value; it is not a gap, and it does not by itself say why." };
    }
  };
})();
