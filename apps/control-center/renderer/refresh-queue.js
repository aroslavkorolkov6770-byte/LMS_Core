(function (root, factory) {
  const queue = factory();
  if (typeof module === "object" && module.exports) module.exports = queue;
  else root.coreRefreshQueue = queue;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createRefreshQueue(load) {
    let active = null;
    let queuedFresh = null;

    function start(fresh) {
      const operation = { fresh, promise: null };
      operation.promise = Promise.resolve().then(() => load(fresh)).finally(() => {
        if (active === operation) active = null;
      });
      active = operation;
      return operation.promise;
    }

    function request(fresh = false) {
      // Reserve the follow-up until completion: callers cannot slip another normal load into the gap.
      if (queuedFresh) return queuedFresh;
      if (!active) return start(fresh === true);
      if (!fresh || active.fresh) return active.promise;
      const previous = active.promise;
      const queued = previous.then(() => start(true), () => start(true)).finally(() => {
        if (queuedFresh === queued) queuedFresh = null;
      });
      queuedFresh = queued;
      return queued;
    }

    return { request };
  }

  return { createRefreshQueue };
});
