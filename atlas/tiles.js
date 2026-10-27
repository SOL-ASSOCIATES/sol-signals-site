/* tiles.js - what the page does when the base-map tiles do not load. The base map is OpenStreetMap standard tiles; Leaflet reports every tile that fails ("tileerror") and every tile that arrives
 * ("tileload"). Lib.tileEvent decides from those events when "the tiles are down" (several failures in a row, close together) and when they are back (two loads in a row); this file only carries
 * out the decision through the three functions the page gives it: show the one notice, take it away, and tell the page that the ground changed (the tile pane is hidden through the data-tiles
 * attribute of the page, the country is filled as it is when there is no base map, and every layer keeps drawing). Nothing here writes to the console. */
(function () {
  "use strict";
  var Lib = window.AtlasLib;

  /* watch(layer, host): `layer` is the Leaflet tile layer; host.show() adds the notice and answers its node, host.hide(node) takes it away, host.changed(down) is called when the state changes.
   * Answers a reader of the state ({down, fails, loads, notice}) for the test hooks. */
  function watch(layer, host) {
    var health = Lib.tileStart(), notice = null;
    function apply(next) {
      var change = Lib.tileTransition(health, next);
      health = next;
      if (change === "show" && !notice) { notice = host.show(); }
      if (change === "clear" && notice) { host.hide(notice); notice = null; }
      if (change !== "none") { host.changed(health.down); }
    }
    layer.on("tileerror", function () { apply(Lib.tileEvent(health, "error", Date.now())); });
    layer.on("tileload", function () { apply(Lib.tileEvent(health, "load", Date.now())); });
    return function () { return { down: health.down, fails: health.fails, loads: health.loads, notice: !!notice }; };
  }

  window.AtlasTiles = { watch: watch };
})();
