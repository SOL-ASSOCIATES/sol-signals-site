/* scheduler.js - background work in small slices, so a big job never becomes one long task.
 * Sets module.exports when loaded by Node, else window.AtlasScheduler. Plain script, no build step.
 *
 * A job is {name, step(deadline, now) -> done, onDone(), onError(error), priority}. step() does some work, stops by the deadline (a time on now()'s clock) and says
 * whether the whole job is finished; it keeps its own progress, so a job that is cancelled can be resumed where it stopped. The scheduler runs one slice per callback:
 * a slice is at most SLICE_MS and never more than the idle time the browser offers. Where the browser has requestIdleCallback it is used (with a timeout, so a busy page
 * still makes progress); otherwise a message channel (no timer clamping), otherwise a zero-delay timer. Jobs run one after the other, lower priority numbers first. */
(function (factory) {
  "use strict";
  var scheduler = factory();
  if (typeof module !== "undefined" && module.exports) { module.exports = scheduler; } else { window.AtlasScheduler = scheduler; }
})(function () {
  "use strict";

  var SLICE_MS = 8, IDLE_TIMEOUT_MS = 300;

  /* The pieces the scheduler needs from its surroundings: now(), request(callback(budgetMs)) -> handle, cancel(handle). Passing a window-like object makes it testable. */
  function browserEnv(win) {
    var w = win || (typeof window !== "undefined" ? window : {});
    var clock = w.performance && typeof w.performance.now === "function" ? w.performance : Date;
    var env = { now: function () { return clock.now(); } };
    if (typeof w.requestIdleCallback === "function") {
      env.request = function (callback) {
        return w.requestIdleCallback(function (idle) { callback(idle && typeof idle.timeRemaining === "function" ? idle.timeRemaining() : SLICE_MS); }, { timeout: IDLE_TIMEOUT_MS });
      };
      env.cancel = function (handle) { if (typeof w.cancelIdleCallback === "function") { w.cancelIdleCallback(handle); } };
    } else if (typeof w.MessageChannel === "function") {
      var channel = new w.MessageChannel(), waiting = [];
      channel.port1.onmessage = function () { var item = waiting.shift(); if (item && !item.cancelled) { item.callback(SLICE_MS); } };       // one message per request, so a cancelled one is swallowed here
      env.request = function (callback) { var item = { callback: callback, cancelled: false }; waiting.push(item); channel.port2.postMessage(0); return item; };
      env.cancel = function (item) { if (item) { item.cancelled = true; } };
    } else {
      env.request = function (callback) { return (w.setTimeout || setTimeout).call(w, function () { callback(SLICE_MS); }, 0); };
      env.cancel = function (handle) { (w.clearTimeout || clearTimeout).call(w, handle); };
    }
    return env;
  }

  function create(env) {
    var queue = [], handle = null, sequence = 0;

    function schedule() {
      if (handle === null && queue.length) { handle = env.request(slice); }
    }
    function unschedule() {
      if (handle !== null && !queue.length) { env.cancel(handle); handle = null; }
    }
    function remove(job) {
      var at = queue.indexOf(job);
      if (at >= 0) { queue.splice(at, 1); }
    }
    function enqueue(job) {
      job.state = "queued";
      job.order = sequence += 1;
      queue.push(job);
      queue.sort(function (a, b) { return a.priority - b.priority || a.order - b.order; });
      schedule();
    }

    function slice(budget) {
      handle = null;
      var job = queue[0];
      if (!job) { return; }
      var start = env.now(), deadline = start + Math.max(1, Math.min(SLICE_MS, typeof budget === "number" && isFinite(budget) ? budget : SLICE_MS));
      job.state = "running";
      var finished = false;
      try {
        finished = job.spec.step(deadline, env.now) === true;
      } catch (error) {
        job.state = "failed";
        remove(job);
        if (job.spec.onError) { job.spec.onError(error); }
        schedule();
        return;
      }
      if (finished) {
        job.state = "done";
        remove(job);
        if (job.spec.onDone) { job.spec.onDone(); }
      } else if (job.state === "running") {
        job.state = "queued";
      }
      schedule();
    }

    return {
      run: function (spec) {
        var job = {
          spec: spec, name: spec.name, state: "queued", priority: typeof spec.priority === "number" ? spec.priority : 0, order: 0,
          cancel: function () { if (job.state === "queued" || job.state === "running") { job.state = "cancelled"; remove(job); unschedule(); } },
          resume: function () { if (job.state === "cancelled") { enqueue(job); } }
        };
        enqueue(job);
        return job;
      },
      pending: function () { return queue.length; }
    };
  }

  var shared = null;
  function instance() { return shared || (shared = create(browserEnv())); }

  return {
    SLICE_MS: SLICE_MS, IDLE_TIMEOUT_MS: IDLE_TIMEOUT_MS, browserEnv: browserEnv, create: create,
    run: function (spec) { return instance().run(spec); },
    pending: function () { return instance().pending(); }
  };
});
