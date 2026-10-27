/* ui.js - DOM builders of the atlas page (layer cards, legends, popups, details drawer, notices).
 * Everything that comes from data (names, operators, metadata text) is inserted with textContent / createTextNode, never parsed as markup. */
(function () {
  "use strict";
  var Lib = window.AtlasLib;

  var EVIDENCE_TEXT = {
    OBSERVED: "As published or as mapped in the source. Sol Associates has not checked these values against another source.",
    DERIVED: "Computed from the source data by Sol Associates.",
    FORECAST: "A model forecast, not a measurement.",
    SCENARIO: "An assumption-based scenario, not an observation."
  };
  var VERIFICATION_TEXT = {
    UNVERIFIED: "No independent check of these values has been made.",
    SOURCE_CHECKED: "Checked against the source for the fields stated in the method.",
    CONFLICTED: "Sources disagree on these values."
  };
  var SCOPE_LABELS = [["geography", "Geography"], ["coverage", "Coverage"], ["population", "What is included"], ["denominator", "Denominator"],
    ["spatial_resolution", "Spatial resolution"], ["temporal_resolution", "Time resolution"], ["coordinate_order", "Coordinate order"]];
  var QUALITY_LABELS = [["missing_count", "Records with a missing value"], ["excluded_count", "Records excluded"], ["unmatched_count", "Records not matched"]];
  /* The word in front of the date of a layer whose source states only the day it was published (the manifest entry's date_word, a closed set); anything else reads "As of". */
  var DATE_WORDS = ["Published"];
  function dateWord(entry) { return entry && DATE_WORDS.indexOf(entry.date_word) >= 0 ? entry.date_word : "As of"; }
  /* A long-term climatology (the solar layers) is an average over a period, not "2510 days old". The period is read from the time-resolution text of the layer itself. */
  var CLIMATOLOGY = /^Long-term average over (\d{4})\s*-\s*(\d{4})/;
  function climatologyPeriod(meta) {
    var scope = meta && typeof meta === "object" ? meta.scope : null;
    var found = CLIMATOLOGY.exec(scope && typeof scope.temporal_resolution === "string" ? scope.temporal_resolution : "");
    return found ? found[1] + "-" + found[2] : null;
  }
  function ageLine(entry) {
    var period = climatologyPeriod(entry && entry.meta);
    return period ? "long-term average " + period : Lib.ageText(entry ? entry.age_days : null);
  }

  function el(tag, props, kids) {
    var node = document.createElement(tag);
    var key, value;
    for (key in (props || {})) {
      value = props[key];
      if (value === null || value === undefined || value === false) { continue; }
      if (key === "class") { node.className = value; }
      else if (key === "text") { node.textContent = value; }
      else if (key.slice(0, 2) === "on") {
        if (typeof value !== "function") { throw new Error("event handler attributes are not allowed: " + key); }
        node.addEventListener(key.slice(2), value);
      }
      else { node.setAttribute(key, value === true ? "" : String(value)); }
    }
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) { return; }
      node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  /* An SVG element (own namespace). Same rules as el(): text goes in with textContent, event handlers must be functions, nothing is parsed as markup. */
  var SVG_NS = "http://www.w3.org/2000/svg";
  function svg(tag, props, kids) {
    var node = document.createElementNS(SVG_NS, tag);
    var key, value;
    for (key in (props || {})) {
      value = props[key];
      if (value === null || value === undefined || value === false) { continue; }
      if (key === "text") { node.textContent = value; }
      else if (key.slice(0, 2) === "on") {
        if (typeof value !== "function") { throw new Error("event handler attributes are not allowed: " + key); }
        node.addEventListener(key.slice(2), value);
      }
      else { node.setAttribute(key, String(value)); }
    }
    (kids || []).forEach(function (kid) { if (kid !== null && kid !== undefined && kid !== false) { node.appendChild(kid); } });
    return node;
  }

  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } return node; }
  function fmtTime(iso) { return typeof iso === "string" && iso.length >= 16 ? iso.slice(0, 10) + " " + iso.slice(11, 16) + " UTC" : "not stated"; }
  function safeHref(url) { return typeof url === "string" && /^https:\/\//.test(url) ? url : null; }
  function extLink(url, text) { return el("a", { href: safeHref(url), target: "_blank", rel: "noopener noreferrer", text: text || url }); }

  /* Compliance text (manifest.page): a text is a list of segments, a plain string or {text, href}. A link is made only for an https address whose host is on the list that the
   * manifest carries (hosts); anything else is shown as plain text, so a damaged or hostile manifest cannot put a foreign link on the page. Nothing is parsed as markup. */
  function linkHost(url, hosts) {
    /* The authority of a plain https address is everything between "https://" and the first "/", "?" or "#". A user name written before the host (the browser then goes to
     * the host after the at sign), a port, a backslash (a browser reads it as a slash), a blank or a control character make it something else, so none of those is a link. */
    if (typeof url !== "string" || /[\s\u0000-\u001f\\]/.test(url)) { return null; }
    var m = /^https:\/\/([^\/?#]*)/.exec(url);
    if (!m || m[1].indexOf("@") >= 0 || m[1].indexOf(":") >= 0) { return null; }
    return (hosts || []).indexOf(m[1].toLowerCase()) >= 0 ? url : null;
  }
  function richNodes(segments, hosts) {
    return (Array.isArray(segments) ? segments : []).map(function (seg) {
      if (typeof seg === "string") { return document.createTextNode(seg); }
      if (seg && typeof seg.text === "string") {
        return linkHost(seg.href, hosts) ? el("a", { href: seg.href, target: "_blank", rel: "noopener noreferrer", text: seg.text }) : document.createTextNode(seg.text);
      }
      return null;
    }).filter(Boolean);
  }
  function rich(tag, segments, hosts, props) { return el(tag, props || {}, richNodes(segments, hosts)); }
  function esc(text) { return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  /* The same text as an HTML string for Leaflet's attribution control, which takes a string of HTML: every text is escaped and only an allowed https link becomes an anchor. */
  function attributionHtml(segments, hosts) {
    return (Array.isArray(segments) ? segments : []).map(function (seg) {
      if (typeof seg === "string") { return esc(seg); }
      if (!seg || typeof seg.text !== "string") { return ""; }
      return linkHost(seg.href, hosts) ? '<a href="' + esc(seg.href) + '" target="_blank" rel="noopener noreferrer">' + esc(seg.text) + "</a>" : esc(seg.text);
    }).join("");
  }
  function fmtSize(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(bytes / 1024)) + " KB"; }

  /* Calls to action (manifest.page.ctas, composed by the build with their campaign tags): a link is made only for an https address on the host list of the manifest, anything else is
   * dropped. rel is exactly "noopener": Sol's own pages see where the visit came from, and the privacy text says so. The addresses and labels are never written in this script. */
  function ctaLinks(entries, hosts) {
    return (Array.isArray(entries) ? entries : []).map(function (entry) {
      if (!entry || typeof entry.label !== "string" || !entry.label || !linkHost(entry.href, hosts)) { return null; }
      return el("a", { href: entry.href, target: "_blank", rel: "noopener", class: "cta", "data-cta": String(entry.id || ""), text: entry.label });
    }).filter(Boolean);
  }
  /* The footer line: the links labelled as coming from Sol Associates; null when there is nothing to show. */
  function ctaLine(entries, hosts) {
    var links = ctaLinks(entries, hosts), kids = [document.createTextNode("From Sol Associates: ")];
    if (!links.length) { return null; }
    links.forEach(function (link, i) { if (i) { kids.push(document.createTextNode(" | ")); } kids.push(link); });
    return el("p", { class: "cta-line" }, kids);
  }
  /* The compact link in a corner of the map (a Leaflet control takes this element); null when there is nothing to show. */
  function mapCta(entries, hosts) {
    var links = ctaLinks(entries, hosts);
    return links.length ? el("div", { class: "map-cta", role: "group", "aria-label": "From Sol Associates" }, [document.createTextNode("From Sol Associates: ")].concat(links)) : null;
  }
  /* ---- the edition: a labelled DEMO (manifest.page.edition) is said in the badge of the header, the strip under it, the edition line and the footer */
  function editionOf(manifest) {
    var e = manifest && manifest.page && manifest.page.edition;
    return e && typeof e === "object" && typeof e.label === "string" && e.label ? e : null;
  }
  /* The badge in the header: the label of the edition ("DEMO edition"), hidden for an edition without one. */
  function editionBadge(badge, manifest) {
    var e = editionOf(manifest);
    clear(badge);
    badge.hidden = !e;
    if (e) { badge.appendChild(document.createTextNode(e.label)); }
    return badge;
  }
  /* The sentence under the header ("Demo edition: ... not advice."), hidden for an edition without one. */
  function editionNote(strip, manifest) {
    var e = editionOf(manifest);
    clear(strip);
    strip.hidden = !(e && typeof e.note === "string" && e.note);
    if (!strip.hidden) { strip.appendChild(document.createTextNode(e.note)); }
    return strip;
  }
  /* True when the page runs inside another page (an iframe on the firm's own site). The parent may be on another origin and unreadable, but comparing the two window objects is
   * always allowed. Nothing in the page tries to leave a frame. */
  function isFramed(win) {
    try { return !!win && win.top !== win.self; } catch (e) { return true; }
  }
  /* The "Open full screen" link: visible only when the page is framed; it opens the page itself in a new tab. Only an http(s) address is used. */
  function frameLink(link, framed, href) {
    if (!link) { return false; }
    var ok = !!framed && typeof href === "string" && /^https?:\/\/[^\s]+$/.test(href);
    link.hidden = !ok;
    if (ok) { link.setAttribute("href", href); link.setAttribute("target", "_blank"); link.setAttribute("rel", "noopener"); }
    return ok;
  }

  /* The label of the demo beside its weather forecast, on the layer card and on the map: when the forecast was issued (Europe/Bucharest time and
   * UTC), until when it is valid, and that the demo is updated periodically and is not a live service. A forecast past its valid-until time reads as a
   * dated snapshot and says it is not current guidance. nowMs is the viewer's clock (Date.now() when it is not given). */
  var DEMO_UPDATED_TEXT = "This demo is updated periodically and is not a live service.";
  var LABEL_TZ = "Europe/Bucharest";
  function validUntil(issuedIso, validToIso) {
    var issued = typeof issuedIso === "string" ? Date.parse(issuedIso) : NaN, until = typeof validToIso === "string" ? Date.parse(validToIso) : NaN;
    return isFinite(issued) && isFinite(until) && until >= issued ? until : null;                       // a valid-until time before the issue is not a credible time
  }
  function isExpired(issuedIso, validToIso, nowMs) {
    var until = validUntil(issuedIso, validToIso);
    return until !== null && typeof nowMs === "number" && isFinite(nowMs) && nowMs > until;
  }
  function forecastLabel(issuedIso, validToIso, nowMs) {
    if (typeof issuedIso !== "string" || !isFinite(Date.parse(issuedIso))) { return "Forecast issue time is not stated. " + DEMO_UPDATED_TEXT; }
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var head = "Forecast issued " + Lib.formatLocal(issuedIso, LABEL_TZ) + " " + LABEL_TZ + " time (" + Lib.formatUtc(issuedIso) + ")";
    if (validUntil(issuedIso, validToIso) === null) { return head + "; the time it is valid until is not stated. " + DEMO_UPDATED_TEXT; }
    var until = ", valid until " + Lib.formatLocal(validToIso, LABEL_TZ) + " (" + Lib.formatUtc(validToIso) + ")";
    if (isExpired(issuedIso, validToIso, now)) { return "Dated snapshot. " + head + until + ", which has passed. It is not current guidance. " + DEMO_UPDATED_TEXT; }
    return head + until + ". " + DEMO_UPDATED_TEXT;
  }
  /* Keeps the label of a card true while the page stays open: the card was built at some moment, and the valid-until time may pass after it. card is what layerCard returned. */
  function refreshForecastLabel(card, entry, edition) {
    var node = card && card.labelNode;
    if (!node || edition !== "demo" || !entry || !entry.meta) { return; }
    var text = forecastLabel(entry.meta.issued_at, entry.meta.valid_to, Date.now());
    if (node.textContent !== text) { node.textContent = text; }
  }

  /* The page of the atlas that describes every layer (method.html, generated per build): a relative address, the atlas may be published under a sub-path. */
  function methodLink(text) { return el("a", { href: "method.html", class: "method-link", text: text || "Method and sources of this map" }); }

  /* A legend swatch: sw = {shape: circle|square|line|outline, c: colour or var(--x), o: outline colour, hollow, dash, w: line weight px, s: size px}. */
  function swatch(sw) {
    var node = el("span", { class: "sw", "data-shape": sw.shape, "aria-hidden": "true", "data-hollow": sw.hollow ? "1" : null, "data-dash": sw.dash ? "1" : null });
    if (sw.c) { node.style.setProperty("--c", sw.c); }
    if (sw.o) { node.style.setProperty("--o", sw.o); }
    if (sw.w) { node.style.setProperty("--w", sw.w + "px"); }
    if (sw.s) { node.style.setProperty("--s", sw.s + "px"); }
    return node;
  }

  /* The name of a class as the legend shows it: a voltage class for the substations and the lines, a fuel for the plants and the generators. */
  function categoryLabel(entry, category) {
    return (entry.kind === "lines" || entry.id === "assets_substations") && Lib.VOLTAGE_NAMES[category] ? Lib.VOLTAGE_NAMES[category] : Lib.fuelName(category);
  }
  /* The count cell of a row whose class reads "not mapped" (Lib.notMapped): the label instead of 0, reachable with the keyboard and by touch (tabindex), the explanation as a title for the mouse
   * and as a real element for focus and for assistive technology (aria-describedby; the style sheet shows it on hover and on focus). */
  var notMappedSerial = 0;
  function notMappedCells() {
    notMappedSerial += 1;
    var id = "nm-explain-" + notMappedSerial;
    return [el("span", { class: "count not-mapped", "data-role": "not-mapped", tabindex: "0", title: Lib.NOT_MAPPED_EXPLANATION, "aria-describedby": id, text: Lib.NOT_MAPPED_LABEL }),
      el("span", { class: "nm-explain", id: id, role: "tooltip", text: Lib.NOT_MAPPED_EXPLANATION })];
  }

  /* rows: [{key, label, sub, count, swatch, notMapped, toggle: {checked, onChange}}]; a zero count stays in the list (a dropped layer must be visible); a row with notMapped says "not mapped" for its number. */
  function legend(rows) {
    return el("ul", { class: "legend" }, rows.map(function (row) {
      var label = el("span", { class: "lbl" }, [row.label, row.sub ? el("small", { text: row.sub }) : null]);
      if (row.toggle) {
        var box = el("input", { type: "checkbox", checked: row.toggle.checked ? true : null, "aria-label": row.toggle.aria });
        box.checked = !!row.toggle.checked;
        box.addEventListener("change", function () { row.toggle.onChange(box.checked); });
        label = el("span", { class: "lbl" }, [el("label", {}, [box, row.label, row.sub ? el("small", { text: row.sub }) : null])]);
      }
      var count = row.notMapped ? notMappedCells() : [el("span", { class: "count", text: row.count === null || row.count === undefined ? "" : String(row.count) })];
      return el("li", { class: row.count === 0 ? "zero" : null, "data-key": row.key }, [swatch(row.swatch), label].concat(count));
    }));
  }

  function chips(meta) {
    var out = [el("span", { class: "chip ev-" + meta.evidence_label, title: EVIDENCE_TEXT[meta.evidence_label] || "", text: meta.evidence_label })];
    var verified = meta.verification_status === "SOURCE_CHECKED";
    out.push(el("span", { class: "chip " + (verified ? "checked" : "unverified"), title: VERIFICATION_TEXT[meta.verification_status] || "",
      text: verified ? "source checked" : meta.verification_status.toLowerCase().replace("_", " ") }));
    return out;
  }

  /* One layer card: checkbox, title, evidence badges, as-of line, stale banner, mismatch warning and the legend host. */
  function layerCard(entry, opts) {
    var meta = entry.meta, id = "chk-" + entry.id;
    var box = el("input", { type: "checkbox", id: id, disabled: opts.available ? null : true });
    box.addEventListener("change", function () { opts.onToggle(box.checked); });
    var asOf = meta.evidence_label === "FORECAST" ? "Issued " + fmtTime(meta.issued_at) : dateWord(entry) + " " + (meta.as_of || "date not stated");
    // A forecast also states its age on the viewer's own clock (the build only knew the day): hours, and "Out of date" past the limit of the edition (36 hours, 168 for the demo).
    var age = meta.evidence_label === "FORECAST" ? Lib.forecastAge(meta.issued_at, Date.now(), opts.edition) : null;
    var ageNote = age ? el("span", { class: "forecast-age" + (age.stale ? " is-stale" : ""), "data-role": "forecast-age",
      text: Lib.forecastCardText(age) }) : null;
    // The demo is updated periodically and is not a live service: its forecast card says when the forecast was issued and until when it is valid, always.
    var labelNote = age && opts.edition === "demo" ? el("p", { class: "forecast-label", "data-role": "forecast-label", text: forecastLabel(meta.issued_at, meta.valid_to, Date.now()) }) : null;
    var legendHost = el("div", { class: "legend-host" });
    var warnHost = el("div", { class: "warn-host" });
    /* the credit that a licensor asks to see with its data stays on the card (not only in a drawer): every source that is not OpenStreetMap */
    var credit = !/^ODbL/.test(meta.licence.identifier) && meta.licence.attribution ? el("p", { class: "card-credit", text: meta.licence.attribution }) : null;
    var details = el("button", { type: "button", class: "link-btn", text: "Details", "aria-label": "Details for " + entry.title, onclick: function () { opts.onDetails(details); } });
    var stale = entry.stale ? el("p", { class: "stale", role: "note",
      text: entry.age_days === null ? "Date unknown: treat this layer as stale." : "Stale: " + asOf.toLowerCase() + ", " + entry.age_days + " days old at build, limit " + meta.quality.stale_after_days + " days." }) : null;
    var root = el("section", { class: "card is-off" + (opts.available ? "" : " is-unavailable"), "data-layer": entry.id }, [
      el("div", { class: "card-head" }, [box, el("h3", { class: "card-title" }, [el("label", { for: id, text: entry.title })])]),
      el("div", { class: "chips" }, chips(meta)),
      el("div", { class: "card-meta" }, [el("span", { class: "num", text: asOf }), el("span", { text: ageLine(entry) }), ageNote, details]),
      labelNote,
      stale,
      opts.available ? null : el("p", { class: "unavailable", text: "Renderer not available yet." }),
      warnHost, legendHost, credit
    ]);
    return { root: root, box: box, legendHost: legendHost, warnHost: warnHost, labelNode: labelNote };
  }

  function withheldCard(item) {
    return el("section", { class: "card is-unavailable", "data-withheld": item.id }, [
      el("div", { class: "card-head" }, [el("input", { type: "checkbox", disabled: true, "aria-label": item.title + " is not in this edition" }),
        el("h3", { class: "card-title", text: item.title })]),
      el("p", { class: "withheld-note", text: item.reason })
    ]);
  }

  function groupBlock(name, cards) {
    return el("details", { class: "group", open: true }, [el("summary", { text: name })].concat(cards));
  }

  /* ---- popups */
  function popupBox(title, subtitle, rows, links) {
    var list = el("dl", {});
    rows.forEach(function (row) {
      if (row[1] === null || row[1] === undefined || row[1] === "") { return; }
      list.appendChild(el("dt", { text: row[0] }));
      list.appendChild(el("dd", { text: String(row[1]) }));
    });
    return el("div", { class: "popup" }, [el("h3", { class: "popup-title", "data-role": "title", text: title }),
      subtitle ? el("p", { class: "popup-sub", text: subtitle }) : null, list,
      el("p", { class: "popup-links" }, links.filter(function (l) { return l && safeHref(l.href); }).map(function (l) { return extLink(l.href, l.text); }))]);
  }

  /* ---- details drawer */
  function section(title, content) { return el("section", { class: "d-sec" }, [el("h3", { text: title }), content]); }
  function fields(pairs) {
    var dl = el("dl", {});
    pairs.forEach(function (p) {
      if (p[1] === null || p[1] === undefined || p[1] === "") { return; }
      dl.appendChild(el("dt", { text: p[0] }));
      dl.appendChild(el("dd", {}, [p[1]]));
    });
    return dl;
  }

  /* displayNote: how the layer is drawn (the renderer's legend note), or null. */
  function drawerBody(entry, manifest, displayNote) {
    var meta = entry.meta, q = meta.quality, lic = meta.licence;
    var dates = [[dateWord(entry), meta.as_of], ["Retrieved", fmtTime(meta.retrieved_at)], ["Built", fmtTime(meta.built_at)]];
    if (meta.evidence_label === "FORECAST") {
      dates = [["Model", meta.model], ["Issued", fmtTime(meta.issued_at)], ["Valid from", fmtTime(meta.valid_from)], ["Valid to", fmtTime(meta.valid_to)]].concat(dates.slice(1));
    }
    var period = climatologyPeriod(meta);
    if (period) { dates.push(["Averaging period", period]); }
    if (meta.evidence_label === "FORECAST") {
      // a forecast is judged by hours, with the limit of the edition (36, or 168 in the demo, which is updated periodically and is not a live service), not by the day limit of the other layers
      dates.push(["Age", Lib.ageText(entry.age_days) + " (the map shows a forecast up to " + Lib.forecastLimitHours(manifest.edition) + " hours after its issue" + (entry.stale ? "; stale at build" : "") + ")"]);
      if (manifest.edition === "demo") {
        dates.push(["Refresh", DEMO_UPDATED_TEXT]);
        if (isExpired(meta.issued_at, meta.valid_to, Date.now())) { dates.push(["Status", "Dated snapshot: the valid-until time has passed, so this is not current guidance."]); }
      }
    } else {
      dates.push([period ? "Age of the package version" : "Age", Lib.ageText(entry.age_days) + (entry.stale ? " (stale, limit " + q.stale_after_days + " days)" : " (limit " + q.stale_after_days + " days)")]);
    }
    var unmapped = Lib.notMappedClasses(entry);
    var parts = [
      section("What it shows", fields([["Measure", meta.metric], ["Unit", meta.unit]])),
      section("Evidence", fields([["Kind", meta.evidence_label + ". " + (EVIDENCE_TEXT[meta.evidence_label] || "")],
        ["Verification", meta.verification_status.toLowerCase().replace("_", " ") + ". " + (VERIFICATION_TEXT[meta.verification_status] || "")]])),
      section("Dates", fields(dates)),
      section("Source and licence", fields([["Source", safeHref(meta.source_ref) ? extLink(meta.source_ref) : meta.source_ref], ["Licence", lic.identifier],
        ["Terms", safeHref(lic.terms_ref) ? extLink(lic.terms_ref) : lic.terms_ref], ["Attribution", lic.attribution]])),
      section("Method", fields([["How it was made", meta.transform_note], ["Version", meta.transform_version]])),
      displayNote ? section("How it is drawn", el("p", { text: displayNote })) : null,
      window.AtlasUI.atrReadingSection ? window.AtlasUI.atrReadingSection(entry, manifest) : null,                         // ui_extra.js: the reading note of the date bands (ATR layers)
      section("Coverage", fields(SCOPE_LABELS.map(function (p) { return [p[1], meta.scope[p[0]]]; }))),
      unmapped.length ? el("section", { class: "d-sec", "data-role": "not-mapped-section" }, [el("h3", { text: "Not mapped in this snapshot" }), el("p", { text: Lib.NOT_MAPPED_EXPLANATION }),
        el("ul", {}, unmapped.map(function (cat) { return el("li", { text: categoryLabel(entry, cat) }); }))]) : null,
      section("Exclusions", fields(QUALITY_LABELS.map(function (p) { return [p[1], q[p[0]] === null ? "withheld, see the limitations" : String(q[p[0]])]; }))),
      section("Limitations", q.limitations.length ? el("ul", {}, q.limitations.map(function (t) { return el("li", { text: t }); })) : el("p", { text: "None stated." }))
    ];
    parts = parts.filter(Boolean);
    if (manifest.withheld.length) {
      parts.push(section("Not in this edition", el("ul", {}, manifest.withheld.map(function (w) { return el("li", { text: w.title + ": " + w.reason }); }))));
    }
    return parts;
  }

  /* "Data and licences": the paragraph of the page text plus the data files of this edition, each with its size, as links to the files themselves. */
  function dataFiles(manifest) {
    var names = Object.keys(manifest.data_hashes || {}).filter(function (n) { return /^data\/[A-Za-z0-9_]+\.(json|png)$/.test(n); });
    var items = names.map(function (n) { return el("li", {}, [el("a", { href: n, text: n.slice(5) }), " (" + fmtSize(manifest.data_hashes[n].bytes) + ")"]); });
    items.push(el("li", {}, [el("a", { href: "data/manifest.json", text: "manifest.json" })]));
    items.push(el("li", {}, [el("a", { href: "data/README-LICENCES.txt", text: "README-LICENCES.txt" }), " (the ODbL notice)"]));
    items.push(el("li", {}, [el("a", { href: "LICENSE-DATA.txt", text: "LICENSE-DATA.txt" }), " (all licences)"]));
    return el("div", { class: "files" }, [el("p", { class: "file-head", text: "Download the data, free of charge and machine-readable:" }), el("ul", { class: "file-list" }, items)]);
  }

  function aboutBody(manifest) {
    var page = manifest.page || {}, hosts = page.link_hosts || [], byId = {};
    (page.sections || []).forEach(function (s) { if (s && s.id) { byId[s.id] = s; } });
    var preview = manifest.preview ? "PREVIEW build: the OpenStreetMap standard tile layer is shown for local checks only. This build is not for publication." : null;
    var base = manifest.basemap ? null : "The base map is pending: this build shows only the country and county outlines on a neutral ground.";
    function fromPage(id, extra) {
      var s = byId[id];
      return s ? section(s.title, el("div", {}, s.paragraphs.map(function (p) { return rich("p", p, hosts); }).concat(extra ? [extra] : []))) : null;
    }
    var edition = editionOf(manifest);
    var cite = (page.cite || []).map(function (t) { return typeof t === "string" ? t.replace("{build_id}", manifest.build_id).replace("{build_date}", String(manifest.built_at).slice(0, 10)) : t; });
    var ctas = ctaLinks(page.ctas && page.ctas.about, hosts), ctaBlock = ctas.length ? el("p", { class: "cta-block" }, ctas) : null;
    var scopes = window.AtlasUI.demoScopeSections ? window.AtlasUI.demoScopeSections(manifest) : [];                            // ui_extra.js: what the demo holds and does not hold
    return [
      section("This edition", el("div", {}, [el("p", { text: edition && typeof edition.about === "string" && edition.about ? edition.about
        : "Public edition, version 0.1. Every layer states its source, date, licence and kind of evidence; open Details on a layer for the method, coverage and limitations." }),
        el("p", {}, [document.createTextNode("Sources, licences, dates and limits of every layer: "), methodLink(), document.createTextNode(".")]),
        preview ? el("p", { text: preview }) : null, base ? el("p", { text: base }) : null])),
      scopes[0], scopes[1], fromPage("general"), fromPage("guarantee"), fromPage("reading"),
      section("Reading the map", el("p", { text: Lib.PLANT_SIZE_NOTE })),
      fromPage("liability"), fromPage("interests", ctaBlock), fromPage("data", dataFiles(manifest)), fromPage("privacy"), fromPage("corrections"),
      section("Attribution", el("ul", {}, manifest.attribution.map(function (t) { return el("li", { text: t }); }))),
      fromPage("third_party"),
      cite.length ? section("Cite this map", el("p", { text: cite.join(" ") })) : null,
      section("Build", fields([["Build id", manifest.build_id], ["Built", fmtTime(manifest.built_at)]])),
      manifest.withheld.length ? section("Not in this edition", el("ul", {}, manifest.withheld.map(function (w) { return el("li", { text: w.title + ": " + w.reason }); }))) : null
    ].filter(Boolean);
  }

  /* The strip under the header while the publisher's details or a confirmed notice are missing: "Provider details pending" when a required provider field is empty,
   * "Notices pending" when only notices are missing, hidden (and empty) otherwise. The manifest lists names only; nothing from it is shown. */
  function pendingStrip(strip, manifest) {
    var pending = manifest && manifest.page && manifest.page.pending, list = function (v) { return Array.isArray(v) ? v : []; };
    var provider = pending ? list(pending.provider).length : 0, items = pending ? list(pending.items).length : 0;
    clear(strip);
    strip.hidden = !(provider || items);
    if (strip.hidden) { return strip; }
    strip.appendChild(el("strong", { text: provider ? "Provider details pending" : "Notices pending" }));
    /* the publisher's identification is part of the footer: it is named only while a provider detail is missing */
    strip.appendChild(document.createTextNode(provider ? ". This build is not for publication until the publisher's identification and the confirmed notices are in place." : ". This build is not for publication until the confirmed notices are in place."));
    return strip;
  }

  /* The footer. The legal block (the linked credit, the publisher, how to report an error, the calls to action, the legal links, the list of sources) sits in one native details: open on a wide
   * screen, closed on a phone, where this text is longer than the map. Every notice stays in the page either way (a closed details keeps its content in the DOM and one tap opens it) and
   * the build line stays outside. opts.label is the label of the edition, opts.narrow a media query list that says whether the screen is a phone. */
  function footer(foot, manifest, opts) {
    var page = manifest.page || {}, hosts = page.link_hosts || [], label = opts && opts.label, narrow = opts && opts.narrow;
    var body = el("div", { class: "foot-body" }), mark = manifest.preview ? "PREVIEW ONLY, not for publication | " : "";
    body.appendChild(page.credit && page.credit.length ? rich("p", [mark].concat(page.credit), hosts, { class: "credit" }) : el("p", { class: "credit", text: mark + (manifest.attribution[0] || "") }));
    if (page.provider) { body.appendChild(rich("p", page.provider, hosts, { class: "provider" + (page.pending && page.pending.provider && page.pending.provider.length ? " is-pending" : "") })); }
    if (page.corrections) { body.appendChild(rich("p", page.corrections, hosts, { class: "corrections" })); }
    var line = ctaLine(page.ctas && page.ctas.footer, hosts), row = el("div", { class: "foot-row" }), more = window.AtlasUI.interestsLink ? window.AtlasUI.interestsLink(manifest) : null;
    if (line && more) { line.appendChild(document.createTextNode(" | ")); line.appendChild(more); }
    if (line) { body.appendChild(line); }
    (page.links || []).forEach(function (link, i) { if (i) { row.appendChild(document.createTextNode(" | ")); } row.appendChild(rich("span", [link], hosts)); });
    if ((page.links || []).length) { row.appendChild(document.createTextNode(" | ")); }
    row.appendChild(methodLink());
    row.appendChild(el("details", { id: "sources" }, [el("summary", { text: "All sources and licences (" + manifest.attribution.length + ")" }),
      el("ul", { class: "attr-list" }, manifest.attribution.map(function (t) { return el("li", { text: t }); }))]));
    body.appendChild(row);
    var legal = el("details", { id: "foot-legal", class: "foot-legal" }, [el("summary", { text: "Licences, sources and provider details" }), body]);
    var sync = function () { legal.open = !(narrow && narrow.matches); };
    sync();
    if (narrow && typeof narrow.addEventListener === "function") { narrow.addEventListener("change", sync); }
    clear(foot).appendChild(legal);
    foot.appendChild(el("p", { class: "foot-stamp" }, [el("span", { class: "build", text: (manifest.preview ? "PREVIEW build " : (label ? label + " build " : "Build ")) + manifest.build_id + " | " + fmtTime(manifest.built_at) })]));
    return legal;
  }

  function notice(host, text, cls) {
    var node = el("div", { class: "notice " + (cls || ""), text: text });
    host.appendChild(node);
    return node;
  }

  window.AtlasUI = { el: el, svg: svg, clear: clear, swatch: swatch, legend: legend, layerCard: layerCard, withheldCard: withheldCard, groupBlock: groupBlock,
    popupBox: popupBox, drawerBody: drawerBody, aboutBody: aboutBody, notice: notice, fmtTime: fmtTime, extLink: extLink, rich: rich, richNodes: richNodes,
    attributionHtml: attributionHtml, linkHost: linkHost, fmtSize: fmtSize, pendingStrip: pendingStrip, footer: footer, ctaLinks: ctaLinks, ctaLine: ctaLine, mapCta: mapCta, methodLink: methodLink,
    section: section, categoryLabel: categoryLabel, editionBadge: editionBadge, editionNote: editionNote, forecastLabel: forecastLabel, refreshForecastLabel: refreshForecastLabel, DEMO_UPDATED_TEXT: DEMO_UPDATED_TEXT, isFramed: isFramed, frameLink: frameLink, ageLine: ageLine, climatologyPeriod: climatologyPeriod };
})();
