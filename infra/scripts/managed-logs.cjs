const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");

function assertLogPath(root, file) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (path.dirname(resolvedFile) !== resolvedRoot || !path.basename(resolvedFile).includes(".log")) {
    throw new Error("Log path is outside the managed log directory.");
  }
  if (fs.existsSync(resolvedRoot) && fs.lstatSync(resolvedRoot).isSymbolicLink()) {
    throw new Error("A symbolic link cannot be used as the managed log directory.");
  }
  if (fs.existsSync(resolvedFile) && fs.lstatSync(resolvedFile).isSymbolicLink()) {
    throw new Error("A symbolic link cannot be used as a managed log file.");
  }
  return resolvedFile;
}

function appendBoundedLog(root, file, value, maxBytes = 512 * 1024, archives = 2) {
  if (!Number.isInteger(maxBytes) || maxBytes < 64 || !Number.isInteger(archives) || archives < 1 || archives > 10) {
    throw new Error("Invalid managed log limits.");
  }
  const target = assertLogPath(root, file);
  fs.mkdirSync(root, { recursive: true });
  let buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (buffer.length > maxBytes) buffer = buffer.subarray(buffer.length - maxBytes);
  const size = fs.existsSync(target) ? fs.statSync(target).size : 0;
  if (size > 0 && size + buffer.length > maxBytes) {
    for (let index = archives; index >= 1; index--) {
      const archive = assertLogPath(root, `${target}.${index}`);
      if (!fs.existsSync(archive)) continue;
      if (index === archives) fs.unlinkSync(archive);
      else fs.renameSync(archive, assertLogPath(root, `${target}.${index + 1}`));
    }
    fs.renameSync(target, assertLogPath(root, `${target}.1`));
  }
  fs.appendFileSync(target, buffer);
}

function createLogWriter(root, file, maxBytes = 512 * 1024) {
  assertLogPath(root, file);
  appendBoundedLog(root, file, "", maxBytes);
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        appendBoundedLog(root, file, chunk, maxBytes);
        callback();
      } catch (error) {
        callback(error);
      }
    }
  });
}

function pruneServiceLogs(root, serviceId, protectedPaths = [], maxSessions = 5) {
  if (!/^[a-z0-9-]+$/i.test(serviceId) || !Number.isInteger(maxSessions) || maxSessions < 1) {
    throw new Error("Invalid service log retention settings.");
  }
  if (!fs.existsSync(root)) return;
  const safeRoot = path.resolve(root);
  const protectedFiles = new Set(protectedPaths.map((file) => assertLogPath(safeRoot, file)));
  const pattern = new RegExp(`^${serviceId}-(\\d{8}-\\d{6}-[a-f0-9]{8})\\.(?:out|err)\\.log(?:\\.[12])?$`);
  const sessions = new Map();
  for (const name of fs.readdirSync(safeRoot)) {
    const match = pattern.exec(name);
    if (!match) continue;
    const file = assertLogPath(safeRoot, path.join(safeRoot, name));
    if (!fs.lstatSync(file).isFile()) continue;
    const session = sessions.get(match[1]) || { files: [], changed: 0, protected: false };
    session.files.push(file);
    session.changed = Math.max(session.changed, fs.statSync(file).mtimeMs);
    session.protected ||= protectedFiles.has(file);
    sessions.set(match[1], session);
  }
  const ordered = [...sessions.values()].sort((a, b) => b.changed - a.changed);
  const retained = new Set(ordered.filter((session) => session.protected));
  for (const session of ordered) {
    if (retained.has(session)) continue;
    if (retained.size < maxSessions) retained.add(session);
    else for (const file of session.files) fs.unlinkSync(assertLogPath(safeRoot, file));
  }
}

module.exports = { appendBoundedLog, createLogWriter, pruneServiceLogs };
