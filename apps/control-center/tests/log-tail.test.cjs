const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { readLogTail, decodeLogBytes, LogTailReader } = require("../dist/log-tail.js");

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "core-log-tail-test-"));
  try { await run(root); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("core-log-tail-test-"));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("log tail: missing and empty logs are safe and nonblocking", async () => fixture(async (root) => {
  assert.equal(await readLogTail(path.join(root, "missing.log")), "");
  const file = path.join(root, "empty.log");
  await fs.writeFile(file, "");
  assert.equal(await readLogTail(file), "");
}));

test("log tail: the full UTF-8 log is unchanged below its byte limit", async () => fixture(async (root) => {
  const file = path.join(root, "utf8.log");
  const content = "Первая строка\nВторая строка · 日本語\n";
  await fs.writeFile(file, content, "utf8");
  assert.equal(await readLogTail(file), content);
}));

test("log tail: each clipped boundary preserves valid UTF-8 without replacement characters", async () => fixture(async (root) => {
  const file = path.join(root, "clipped.log");
  await fs.writeFile(file, "0123456789 · русский 日本語 · конец\n", "utf8");
  for (let bytes = 1; bytes <= 50; bytes++) {
    const result = await readLogTail(file, bytes);
    assert.equal(result.includes("\ufffd"), false, `limit=${bytes}`);
    assert.ok(result.startsWith("Показана последняя часть журнала.\n\n"));
  }
}));

test("log tail: an unfinished last character appears only after the writer finishes it", async () => fixture(async (root) => {
  const file = path.join(root, "partial.log");
  const bytes = Buffer.from("ABC · Я", "utf8");
  await fs.writeFile(file, bytes.subarray(0, bytes.length - 1));
  assert.equal((await readLogTail(file)).includes("\ufffd"), false);
  await fs.appendFile(file, bytes.subarray(bytes.length - 1));
  assert.equal(await readLogTail(file), "ABC · Я");
}));

test("log tail: a large log returns only its bounded suffix and releases the file", async () => fixture(async (root) => {
  const file = path.join(root, "large.log");
  const content = "prefix-line\n".repeat(100000) + "Последняя запись\n";
  await fs.writeFile(file, content, "utf8");
  const tail = await readLogTail(file);
  assert.ok(Buffer.byteLength(tail, "utf8") < 256 * 1024 + 100);
  assert.ok(tail.endsWith("Последняя запись\n"));
  await fs.rename(file, path.join(root, "rotated.log"));
  await fs.writeFile(file, "New log\n");
  assert.equal(await readLogTail(file), "New log\n");
}));

test("log tail: truncation between refreshes starts from the new file contents", async () => fixture(async (root) => {
  const file = path.join(root, "truncate.log");
  await fs.writeFile(file, "Old\n".repeat(1000));
  await readLogTail(file, 100);
  await fs.writeFile(file, "Fresh\n");
  assert.equal(await readLogTail(file), "Fresh\n");
}));

test("log tail: invalid limits and directory errors never expose a private path", async () => fixture(async (root) => {
  for (const limit of [0, -1, NaN, 1.5, 1024 * 1024]) await assert.rejects(readLogTail(path.join(root, "file"), limit), /Некорректные параметры/);
  await assert.rejects(readLogTail(root), (error) => !error.message.includes(root));
  assert.equal(decodeLogBytes(Buffer.from("", "utf8"), true), "");
}));

function countedReader(maximumEntries = 4, hooks = {}) {
  const counts = { opens: 0, reads: 0, bytes: 0, stats: 0 };
  const reader = new LogTailReader(maximumEntries, async (...arguments_) => {
    counts.opens++;
    if (hooks.beforeOpen) await hooks.beforeOpen();
    const file = await fs.open(...arguments_);
    return new Proxy(file, { get(target, property) {
      if (property === "read") return async (...args) => {
        const result = await target.read(...args); counts.reads++; counts.bytes += result.bytesRead;
        if (hooks.afterRead) await hooks.afterRead();
        return result;
      };
      if (property === "stat") return async (...args) => { counts.stats++; return target.stat(...args); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  });
  return { reader, counts };
}

test("cached log: thirty unchanged polls read payload once but inspect the file every time", async () => fixture(async (root) => {
  const file = path.join(root, "stable.log"), content = "Log line\n".repeat(40000);
  await fs.writeFile(file, content);
  const { reader, counts } = countedReader();
  const first = await reader.read(file);
  for (let poll = 0; poll < 29; poll++) assert.equal(await reader.read(file), first);
  assert.equal(counts.opens, 30);
  assert.equal(counts.stats, 31);
  assert.equal(counts.reads, 1);
  assert.equal(counts.bytes, 256 * 1024);
}));

test("cached log: manual refresh bypasses a matching entry", async () => fixture(async (root) => {
  const file = path.join(root, "manual.log"); await fs.writeFile(file, "Content\n");
  const { reader, counts } = countedReader();
  await reader.read(file); await reader.read(file); await reader.read(file, undefined, true);
  assert.equal(counts.reads, 2);
}));

test("cached log: append, same-size rewrite and truncation are visible", async () => fixture(async (root) => {
  const file = path.join(root, "changing.log"); await fs.writeFile(file, "First\n");
  await fs.utimes(file, new Date("2020-01-01"), new Date("2020-01-01"));
  const { reader } = countedReader();
  assert.equal(await reader.read(file), "First\n");
  await fs.appendFile(file, "More\n"); assert.equal(await reader.read(file), "First\nMore\n");
  await fs.writeFile(file, "Other\nLine\n");
  await fs.utimes(file, new Date("2021-01-01"), new Date("2021-01-01"));
  assert.equal(await reader.read(file), "Other\nLine\n");
  await fs.writeFile(file, "X\n"); assert.equal(await reader.read(file), "X\n");
}));

test("cached log: a rotated file with the same size and mtime is not the old file", async () => fixture(async (root) => {
  const file = path.join(root, "rotate.log"), date = new Date("2020-01-01");
  await fs.writeFile(file, "Old\n"); await fs.utimes(file, date, date);
  const { reader } = countedReader(); assert.equal(await reader.read(file), "Old\n");
  await fs.rename(file, file + ".1"); await fs.writeFile(file, "New\n"); await fs.utimes(file, date, date);
  assert.equal(await reader.read(file), "New\n");
  await fs.unlink(file); assert.equal(await reader.read(file), "");
  await fs.writeFile(file, "Back\n"); assert.equal(await reader.read(file), "Back\n");
}));

test("cached log: a read failure never falls back to cached contents", async () => fixture(async (root) => {
  const file = path.join(root, "access.log"); await fs.writeFile(file, "Original\n");
  let denied = false;
  const { reader, counts } = countedReader(4, { beforeOpen() { if (denied) throw Object.assign(Error("Private path"), { code: "EACCES" }); } });
  assert.equal(await reader.read(file), "Original\n"); denied = true;
  await assert.rejects(reader.read(file), (error) => !error.message.includes(file) && !error.message.includes("Private path"));
  denied = false; assert.equal(await reader.read(file), "Original\n"); assert.equal(counts.reads, 2);
}));

test("cached log: an append during reading prevents reuse of that snapshot", async () => fixture(async (root) => {
  const file = path.join(root, "racing.log"); await fs.writeFile(file, "Before\n");
  let appended = false;
  const { reader, counts } = countedReader(4, { async afterRead() { if (!appended) { appended = true; await fs.appendFile(file, "After\n"); } } });
  assert.equal(await reader.read(file), "Before\n");
  assert.equal(await reader.read(file), "Before\nAfter\n");
  await reader.read(file); assert.equal(counts.reads, 2);
}));

test("cached log: LRU bounds and byte limits do not reuse a different suffix", async () => fixture(async (root) => {
  const { reader, counts } = countedReader(2), files = ["a", "b", "c"].map(name => path.join(root, name + ".log"));
  for (const file of files) await fs.writeFile(file, "0123456789\n");
  await reader.read(files[0], 5); await reader.read(files[1], 5); await reader.read(files[0], 5);
  await reader.read(files[2], 5); await reader.read(files[1], 5);
  assert.equal(counts.reads, 4);
  assert.notEqual(await reader.read(files[1], 8), await reader.read(files[1], 5));
  for (const limit of [0, -1, NaN, 1.5, 1024 * 1024]) await assert.rejects(reader.read(files[0], limit), /Некорректные параметры/);
  assert.throws(() => new LogTailReader(0), /Некорректный размер/);
  assert.throws(() => new LogTailReader(17), /Некорректный размер/);
}));
