/* atr_ui.js - the DOM of the ATR layer card: the banner and source line, the snapshot / colour mode / filter controls, the side panel, the note on the date
 * bands, the table alternative, and the county popup. Nothing here knows Leaflet: render_atr.js owns the map and the state and calls update(view) with what to show.
 * All text that describes the data (banner, source, legend title, band note, band labels) comes from the data object; this file only holds interface wording.
 * Everything is inserted as text (UI.el / textContent); data values are never parsed as markup. */
(function () {
  "use strict";
  var Lib = window.AtlasLib, UI = window.AtlasUI, el = UI.el;
  var A = (window.AtlasAtrUi = {});

  var SUPPRESSED_TEXT = "Detail withheld in this edition";
  var MERGED_LABEL = "Detail withheld or merged";
  var NOT_ASSESSED = "not assessed";
  var NO_DATED_DETAIL = "No dated detail released";
  var NO_MATCH_TEXT = "No ATR matching the filters";
  var NO_ATR_TEXT = "No ATR matched to this county in this aggregation";            // a county of the list with n = 0: not "0 MW", which would read as a measured zero
  var NOT_COVERED = "not covered by the filters";
  var FILTERS = [["technology", "Technology"], ["status", "Status"], ["operator", "Grid operator (TSO or DSO)"]];
  var MODES = [["mw", "ATR MW per county"], ["bands", "Date band of the date recorded in the list"]];            // the date is the one the list records, which can be the latest amended one
  /* Readable names for the tokens of the data. The VALUE of a filter option stays the token of the data; only the text a reader sees changes. The tables are
   * closed: a token that is not in a table is shown as "Unrecognised" (status) and is never echoed, and a table is read with hasOwnProperty so that a name such as "constructor" finds nothing. */
  var STATUS_LABELS = { ATR_ISSUED: "ATR issued", CR_SIGNED: "Connection contract signed", WORKS_IN_EXECUTION: "Works in execution", COMMISSIONED: "Commissioned", OTHER: "Other",
    valid: "Valid", cancelled: "Cancelled", expired: "Expired", unknown: "Unknown", other: "Other", Unrecognised: "Unrecognised" };
  var OPERATOR_LABELS = { DEER: "DEER (Distributie Energie Electrica Romania)" };
  function own(table, key) { return typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null; }

  A.SUPPRESSED_TEXT = SUPPRESSED_TEXT;
  A.NOT_ASSESSED = NOT_ASSESSED;
  A.NO_DATED_DETAIL = NO_DATED_DETAIL;
  A.NO_MATCH_TEXT = NO_MATCH_TEXT;
  A.NO_ATR_TEXT = NO_ATR_TEXT;
  A.statusLabel = function (token) { return own(STATUS_LABELS, token) || "Unrecognised"; };
  A.operatorLabel = function (name) { return own(OPERATOR_LABELS, name) || name; };
  A.optionLabel = function (filter, value) { return filter === "status" ? A.statusLabel(value) : (filter === "operator" ? A.operatorLabel(value) : value); };
  A.modeLabel = function (mode) { return (MODES.filter(function (m) { return m[0] === mode; })[0] || [mode, mode])[1]; };
  /* "Technology PV, Status COMMISSIONED", or "none". */
  A.filterSummary = function (filters) {
    var parts = FILTERS.filter(function (f) { return filters[f[0]]; }).map(function (f) { return (f[0] === "operator" ? "Grid operator" : f[1]) + " " + A.optionLabel(f[0], filters[f[0]]); });
    return parts.length ? parts.join(", ") : "none";
  };

  /* The label of a date band for display: the data's own label, and a fixed interface label for the merged residual. */
  A.bandLabel = function (obj, id) { return id === Lib.ATR_MERGED ? MERGED_LABEL : obj.cohort_labels[id]; };
  /* The MW of one band; the conflicted band reads 'not assessed' when the build did not assess conflicts, so a zero is never presented as 'no conflicts'. The last date band starts at the last
   * date boundary: a list published before that date cannot hold a row in it, so its zero reads "empty by construction" and not as a measured nothing. */
  var EMPTY_BY_CONSTRUCTION = "empty by construction (list published before this date)";
  A.EMPTY_BY_CONSTRUCTION = EMPTY_BY_CONSTRUCTION;
  A.emptyByConstruction = function (obj, id) {
    var rules = Array.isArray(obj.rules) ? obj.rules : [], last = rules.length ? rules[rules.length - 1] : null;
    return id === Lib.ATR_COHORTS[2] && !!last && typeof last.date === "string" && typeof obj.as_of === "string" && obj.as_of < last.date;
  };
  A.bandValue = function (obj, id, mw) {
    if (id === "date_conflicted" && !obj.totals.conflict_assessed) { return NOT_ASSESSED; }
    return !mw && A.emptyByConstruction(obj, id) ? EMPTY_BY_CONSTRUCTION : Lib.atrMwText(mw);
  };
  A.dominantLabel = function (obj, id) { return id ? obj.cohort_labels[id] : NO_DATED_DETAIL; };

  // ------------------------------------------------------------------ popup
  /* name: the county; county: its object in the data or undefined (an outline with no ATR data); agg: aggregateCounty result; filtered: any filter set. Text only. */
  A.countyPopup = function (obj, name, county, agg, filtered) {
    var sub = typeof obj.source_label === "string" ? obj.source_label : null;
    var box = function (rows) {
      var b = UI.popupBox(name, sub, rows, []);
      b.className += " atr-popup";                                    // atr-popup: long labels from the data, short values
      Array.prototype.slice.call(b.childNodes).forEach(function (part) {
        if (part.tagName === "DL") { Array.prototype.slice.call(part.childNodes).forEach(function (dd) { if (dd.tagName === "DD" && dd.textContent === NOT_COVERED) { dd.className = "atr-note"; } }); }
      });
      return b;
    };
    if (!county) { return box([["Detail", "No ATR data for this county in this list."]]); }
    if (county.suppressed === true) { return box([["Detail", SUPPRESSED_TEXT]]); }
    /* a county of the list with no ATR matched to it (n = 0): the zero is not evidence that no ATR exists there, so the popup does not print "0 MW" */
    if (!filtered && county.n === 0) { return box([["ATR MW (all detail)", NO_ATR_TEXT]]); }
    /* the dotted county of a filtered view: nothing of its released detail matches, which is not "0 MW of capacity" */
    if (filtered && !agg.mw) { return box([["ATR MW (filters applied, released detail only)", NO_MATCH_TEXT], [A.bandLabel(obj, Lib.ATR_MERGED), NOT_COVERED]]); }
    var rows = [[filtered ? "ATR MW (filters applied, released detail only)" : "ATR MW (all detail)", Lib.atrMwText(agg.mw)], ["ATR records", agg.n.toLocaleString("en-GB")]];
    /* A filter only ever matches released detail, so the merged residual is outside it: its row says so instead of showing 0 MW, which would read as "nothing is withheld". */
    Lib.ATR_COHORTS.concat([Lib.ATR_MERGED]).forEach(function (id) {
      rows.push([A.bandLabel(obj, id), id === Lib.ATR_MERGED && filtered ? NOT_COVERED : A.bandValue(obj, id, agg.by_cohort[id])]);
    });
    return box(rows);
  };

  // ------------------------------------------------------------------ controls
  function radio(group, value, text, id, onChange, role) {
    var input = el("input", { type: "radio", name: group, value: value, id: id, "data-role": role });
    input.checked = false;
    input.addEventListener("change", function () { if (input.checked) { onChange(value); } });
    return { input: input, label: el("label", { class: "wx-radio", for: id }, [input, text]) };
  }

  function fieldset(title, kids, role) { return el("fieldset", { class: "wx-var atr-group", "data-role": role }, [el("legend", { text: title })].concat(kids)); }

  function snapshotGroup(entry, snapshots, actions) {
    var items = snapshots.map(function (s) { return radio("atr-snapshot-" + entry.id, s.id, s.title, "atr-snap-" + entry.id + "-" + s.id, actions.chooseSnapshot, "atr-snapshot"); });
    return { node: fieldset("List (one at a time, never summed)", items.map(function (i) { return i.label; }), "atr-snapshots"), radios: items.map(function (i) { return i.input; }) };
  }

  function filterRow(entry, name, label, values, actions) {
    var id = "atr-filter-" + entry.id + "-" + name;
    var select = el("select", { id: id, "data-role": "atr-filter-" + name }, [el("option", { value: "", text: "All" })].concat(values.map(function (v) { return el("option", { value: v, text: A.optionLabel(name, v) }); })));
    select.value = "";
    select.addEventListener("change", function () { actions.setFilter(name, select.value === "" ? null : select.value); });
    return { select: select, node: el("div", { class: "atr-filter" }, [el("label", { for: id, text: label }), select]) };
  }

  // ------------------------------------------------------------------ table
  function buildTable(entry, actions) {
    var wrapId = "atr-table-" + entry.id;
    var wrap = el("div", { id: wrapId, class: "atr-table-wrap", role: "region", "aria-label": "Counties as a table", "aria-describedby": wrapId + "-hint", tabindex: "0", "data-role": "atr-table-wrap" });
    wrap.hidden = true;
    var sortHead = function (key, text) {
      var button = el("button", { type: "button", class: "atr-sort", "data-role": "atr-sort-" + key, text: text, onclick: function () { actions.sortBy(key); } });
      return { th: el("th", { scope: "col", "aria-sort": "none" }, [button]), button: button };
    };
    var name = sortHead("name", "County"), mw = sortHead("mw", "ATR MW (current filters)");
    var body = el("tbody", {});
    var table = el("table", { class: "atr-table", "data-role": "atr-table" }, [el("caption", { text: "ATR MW by county, for the colour mode and filters set" }),
      el("thead", {}, [el("tr", {}, [name.th, mw.th, el("th", { scope: "col", text: "Dominant date band among released detail" })])]), body]);
    wrap.appendChild(table);
    var hint = el("p", { class: "atr-table-hint", "data-role": "atr-table-hint", id: wrapId + "-hint", text: "Select a county name to see that county on the map." });
    hint.hidden = true;
    var toggle = el("button", { type: "button", class: "btn atr-table-btn", "data-role": "atr-table-toggle", "aria-expanded": "false", "aria-controls": wrapId, text: "Show as table",
      onclick: function () { actions.toggleTable(); } });
    return { toggle: toggle, wrap: wrap, hint: hint, body: body, heads: { name: name.th, mw: mw.th } };
  }

  function fillRows(t, rows, actions, selected) {
    UI.clear(t.body);
    rows.forEach(function (r) {
      var button = el("button", { type: "button", class: "atr-county", "data-role": "atr-county-btn", "data-county": r.name, text: r.name, onclick: function () { actions.selectCounty(r.name); } });
      var tr = el("tr", { "data-role": "atr-row", "data-county": r.name, class: r.name === selected ? "is-selected" : null }, [
        el("th", { scope: "row" }, [button]), el("td", { class: "num", text: r.mwText }), el("td", { text: r.band })]);
      tr.addEventListener("click", function (ev) {
        var inside = ev && ev.target && (ev.target === button || (button.contains && button.contains(ev.target)));
        if (!inside) { actions.selectCounty(r.name); }
      });
      t.body.appendChild(tr);
    });
  }

  // ------------------------------------------------------------------ the whole card extension
  /* actions: {chooseSnapshot(id), setMode(mode), setFilter(name, value|null), resetFilters(), toggleTable(), sortBy(key), selectCounty(name), snapshots() -> [{id, title}]}.
   * Returns {extra, after, update(view)}: extra goes above the legend rows, after below them. view is built by render_atr.js. */
  A.buildPanel = function (entry, obj, options, actions, texts) {
    var banner = el("p", { class: "atr-banner", role: "note", "data-role": "atr-banner", text: obj.banner });
    var source = el("p", { class: "atr-source", "data-role": "atr-source", text: typeof obj.source_label === "string" ? obj.source_label : "" });         // the as-of date and the age are on the card header
    source.hidden = typeof obj.source_label !== "string" || !obj.source_label;
    var coverage = el("p", { class: "atr-caveat atr-coverage", "data-role": "atr-coverage" });                  // directly under the banner: the caveat is read with it
    var shownRow = el("p", { class: "atr-caveat atr-shown", "data-role": "atr-shown" });
    var notes0 = (texts && texts.notes) || {};
    var interests = notes0.interests ? UI.rich("p", notes0.interests, (texts && texts.hosts) || [], { class: "atr-caveat atr-interests", "data-role": "atr-interests" }) : null;          // interests, next to the explanation
    var remainder = el("p", { class: "atr-caveat atr-remainder", "data-role": "atr-remainder" });                 // what "Shown without filters" leaves out, in one sentence (hidden under filters)
    remainder.hidden = true;
    var live = el("p", { class: "sr-only", role: "status", "aria-live": "polite", "data-role": "atr-live" });
    var snapshots = actions.snapshots();
    var snap = snapshots.length > 1 ? snapshotGroup(entry, snapshots, actions) : null;
    var modeItems = MODES.map(function (m) { return radio("atr-mode-" + entry.id, m[0], m[1], "atr-mode-" + entry.id + "-" + m[0], actions.setMode, "atr-mode"); });
    var notes = (texts && texts.notes) || {};
    var bandsReading = typeof notes.date_bands === "string" && notes.date_bands ? el("p", { class: "atr-caveat atr-bands-reading", "data-role": "atr-bands-reading", text: notes.date_bands }) : null;          // next to the choice it explains
    var rows = FILTERS.map(function (f) { return filterRow(entry, f[0], f[1], options[f[0]], actions); });
    var reset = el("button", { type: "button", class: "btn", "data-role": "atr-reset", text: "Reset filters", onclick: function () { actions.resetFilters(); } });
    var sliderId = "atr-opacity-" + entry.id;
    var slider = el("input", { type: "range", id: sliderId, min: "20", max: "100", step: "5", "aria-label": "Fill opacity", "aria-describedby": sliderId + "-hint", "data-role": "atr-opacity" });
    var opacityValue = el("span", { class: "num", "data-role": "atr-opacity-value" });
    slider.addEventListener("input", function () { actions.setOpacity(Number(slider.value) / 100); });
    var opacityHint = el("p", { class: "atr-opacity-hint", id: sliderId + "-hint", "data-role": "atr-opacity-hint", text: "Fills cover the weather and solar layers; lower the opacity to see them." });
    var opacityRow = el("div", { class: "atr-opacity" }, [el("label", { class: "opacity-row", for: sliderId }, ["Fill opacity ", opacityValue]), slider, opacityHint]);
    var legendTitle = el("p", { class: "atr-legend-title", "data-role": "atr-legend-title" });
    var extra = el("div", { class: "layer-extra atr-controls" }, [banner, interests, coverage, shownRow, remainder, source, snap && snap.node, fieldset("Colour counties by", modeItems.map(function (i) { return i.label; }).concat([bandsReading]), "atr-modes"),
      fieldset("Filters", rows.map(function (r) { return r.node; }).concat([reset]), "atr-filters"), opacityRow, legendTitle, live]);

    var side = el("dl", { class: "atr-side", "data-role": "atr-side" });
    var unmatched = el("p", { class: "mismatch atr-unmatched", "data-role": "atr-unmatched", role: "status" });
    unmatched.hidden = true;
    var about = el("details", { class: "atr-about", "data-role": "atr-bands-about" }, [el("summary", { text: "About the date bands" }), el("p", { text: obj.band_note })]);
    var table = buildTable(entry, actions);
    var after = el("div", { class: "layer-extra atr-after" }, [el("h4", { class: "atr-side-title", text: "Not on the map" }), side, unmatched, about, table.toggle, table.hint, table.wrap]);

    function update(view) {
      legendTitle.textContent = view.legendTitle;
      slider.value = String(Math.round(view.opacity * 100));
      opacityValue.textContent = Math.round(view.opacity * 100) + " %";
      modeItems.forEach(function (i) { i.input.checked = i.input.value === view.mode; });
      if (snap) { snap.radios.forEach(function (r) { r.checked = r.value === view.snapshot; }); }
      FILTERS.forEach(function (f, i) { rows[i].select.value = view.filters[f[0]] === null ? "" : view.filters[f[0]]; });
      UI.clear(side);
      view.side.forEach(function (pair) { side.appendChild(el("dt", { text: pair[0] })); side.appendChild(el("dd", { text: pair[1] })); });
      coverage.textContent = view.coverageText || "";
      coverage.hidden = !view.coverageText;
      shownRow.textContent = view.shownText || "";
      shownRow.hidden = !view.shownText;
      remainder.textContent = view.remainderText || "";
      remainder.hidden = !view.remainderText;
      if (live.textContent !== view.announce) { live.textContent = view.announce; }                    // only a real change is announced
      unmatched.textContent = view.unmatchedText || "";
      unmatched.hidden = !view.unmatchedText;
      table.toggle.textContent = view.tableOpen ? "Hide table" : "Show as table";
      table.toggle.setAttribute("aria-expanded", view.tableOpen ? "true" : "false");
      table.wrap.hidden = !view.tableOpen;
      table.hint.hidden = !view.tableOpen;
      ["name", "mw"].forEach(function (key) { table.heads[key].setAttribute("aria-sort", view.sort.key === key ? (view.sort.dir === "asc" ? "ascending" : "descending") : "none"); });
      if (view.tableOpen) { fillRows(table, view.rows, actions, view.selected); }
    }
    return { extra: extra, after: after, update: update };
  };
})();
