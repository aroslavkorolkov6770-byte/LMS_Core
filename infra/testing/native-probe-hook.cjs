// Test-only hook: record operation names/ports, never command arguments, environment, URLs or output.
globalThis.__coreProbeHookLoaded = { electron: Boolean(process.versions.electron), type: process.type || "unset" };
if (process.versions.electron && process.type === "browser") {
  const path = require("node:path"), cp = require("node:child_process"), net = require("node:net"), http = require("node:http"), util = require("node:util");
  const metrics = { phase: "startup", events: [] };
  globalThis.__coreProbeMetrics = metrics;
  function record(kind, label) {
    const item = { phase: metrics.phase, kind, label, started: performance.now(), durationMs: null };
    if (metrics.events.length < 4000) metrics.events.push(item);
    return () => { if (item.durationMs === null) item.durationMs = Math.round((performance.now() - item.started) * 10) / 10; };
  }
  function portOf(value) {
    try { const url = typeof value === "string" || value instanceof URL ? new URL(value) : null; return url && ["127.0.0.1", "localhost"].includes(url.hostname) ? String(url.port || 80) : "other"; } catch { return "other"; }
  }
  const { ipcMain } = require("electron");
  const originalHandle = ipcMain.handle;
  ipcMain.handle = function(channel, listener) {
    if (channel !== "launcher:get-statuses") return Reflect.apply(originalHandle, ipcMain, [channel, listener]);
    return Reflect.apply(originalHandle, ipcMain, [channel, function(...args) {
      const finish = record("ipc", args[1]?.fresh === true ? "statuses-fresh" : "statuses-normal");
      try { return Promise.resolve(Reflect.apply(listener, this, args)).then((result) => { finish(); return result; }, (error) => { finish(); throw error; }); } catch (error) { finish(); throw error; }
    }]);
  };
  const originalExec = cp.execFile;
  const wrappedExec = function(...args) {
    const file = path.basename(String(args[0])).toLowerCase();
    const finish = record("process", ["psql.exe", "powershell.exe", "cmd.exe", "node.exe", "netstat.exe"].includes(file) ? file : "other");
    try { const child = Reflect.apply(originalExec, cp, args); child.once("close", finish); child.once("error", finish); return child; } catch (error) { finish(); throw error; }
  };
  wrappedExec[util.promisify.custom] = (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => { child = wrappedExec(...args, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })); });
    promise.child = child; return promise;
  };
  cp.execFile = wrappedExec;
  const originalConnect = net.createConnection;
  net.createConnection = function(...args) {
    const value = args[0], port = value && typeof value === "object" && ["127.0.0.1", "localhost"].includes(value.host) ? String(value.port) : "other";
    const finish = record("tcp", port);
    try { const socket = Reflect.apply(originalConnect, net, args); socket.once("connect", finish); socket.once("error", finish); return socket; } catch (error) { finish(); throw error; }
  };
  const originalGet = http.get;
  http.get = function(...args) {
    const finish = record("http", portOf(args[0]));
    try { const request = Reflect.apply(originalGet, http, args); request.once("close", finish); request.once("error", finish); return request; } catch (error) { finish(); throw error; }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function(...args) {
    const finish = record("fetch", portOf(args[0]));
    return Reflect.apply(originalFetch, globalThis, args).then((response) => { finish(); return response; }, (error) => { finish(); throw error; });
  };
}
