/* ui_extra.js - launch-readiness additions to the DOM builders of ui.js. Loaded right after ui.js, whose object (window.AtlasUI) it extends: the reading note of the date bands in the details of the
 * ATR layer, and further builders of the same kind. All text comes from the manifest (manifest.page); everything is inserted as text or as an allowed link, never parsed as markup. */
(function () {
  "use strict";
  var UI = window.AtlasUI, el = UI.el;

  /* The details of an ATR layer carry the reading note of the date bands (manifest.page.atr_notes.date_bands); null for any other layer, and for a manifest without the note. */
  UI.atrReadingSection = function (entry, manifest) {
    var notes = manifest && manifest.page && manifest.page.atr_notes;
    return entry && entry.kind === "choropleth" && notes && typeof notes.date_bands === "string" && notes.date_bands ? UI.section("Reading the date bands", el("p", { text: notes.date_bands })) : null;
  };

  /* The two short lists of the About drawer: what the demo holds (the layers of this build, from manifest.page.demo_scope.in: derived by the build, never typed here) and what it does not hold
   * (demo_scope.not_in). A plain statement of fact: no promise, no date. Nothing without the lists in the manifest. */
  UI.demoScopeSections = function (manifest) {
    var scope = manifest && manifest.page && manifest.page.demo_scope;
    if (!scope || !Array.isArray(scope.in) || !scope.in.length) { return []; }
    var list = function (items, role) { return el("ul", { class: "scope-list", "data-role": role }, (Array.isArray(items) ? items : []).map(function (text) { return el("li", { text: String(text) }); })); };
    return [UI.section("In this demo", list(scope.in, "demo-scope-in")), UI.section("Not in this demo", list(scope.not_in, "demo-scope-out"))];
  };

  /* The link to the disclosure of interests that stands next to the calls to action (manifest.page.interests_link: a link to the Disclaimer page on the allowed host); null without it. */
  UI.interestsLink = function (manifest) {
    var page = manifest && manifest.page, segments = page && page.interests_link;
    return Array.isArray(segments) && segments.length ? UI.rich("span", segments, page.link_hosts || [], { class: "interests-link", "data-role": "interests-link" }) : null;
  };
})();
