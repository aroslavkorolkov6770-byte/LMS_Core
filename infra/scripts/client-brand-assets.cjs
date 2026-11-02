"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const LEGACY_BACKGROUND = "https://u.9111s.ru/uploads/202402/17/a0254a12ef37da5aaf5c5646a30baab8.webp";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FILE = /^([a-f0-9]{64})\.(png|jpg|webp)$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function demand(condition, code = "INVALID_BRANDING_IMAGE") { if (!condition) throw Error(code); }
function inspectImage(bytes) {
  demand(Buffer.isBuffer(bytes) && bytes.length >= 24 && bytes.length <= MAX_IMAGE_BYTES);
  let width, height, extension, mime;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    demand(bytes.toString("ascii", 12, 16) === "IHDR" && bytes.readUInt32BE(8) === 13 && bytes.includes(Buffer.from("IEND")));
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); extension = "png"; mime = "image/png";
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      demand(bytes[offset] === 255); const marker = bytes[offset + 1]; offset += 2;
      if (marker === 255) { offset--; continue; }
      if (marker === 218 || marker === 217) break;
      const length = bytes.readUInt16BE(offset); demand(length >= 2 && offset + length <= bytes.length);
      if ([192, 193, 194].includes(marker)) { height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break; }
      offset += length;
    }
    extension = "jpg"; mime = "image/jpeg";
  } else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    demand(bytes.readUInt32LE(4) + 8 === bytes.length);
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X" && bytes.length >= 30) { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); width = (bits & 16383) + 1; height = ((bits >>> 14) & 16383) + 1; }
    else if (kind === "VP8 " && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
    extension = "webp"; mime = "image/webp";
  }
  demand(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16000000);
  return { extension, mime, width, height, bytes: bytes.length, sha256: hash(bytes) };
}
function assetUrl(clientId, file) {
  demand(UUID.test(clientId) && FILE.test(file));
  return `/api/client-brand-assets?clientId=${clientId.toLowerCase()}&asset=${file}`;
}
function parseAssetUrl(value, clientId) {
  demand(UUID.test(clientId));
  if (!value || value === LEGACY_BACKGROUND) return null;
  demand(typeof value === "string" && value.length < 300, "BRANDING_IMAGE_UPLOAD_REQUIRED");
  const url = new URL(value, "http://core.invalid");
  const file = url.searchParams.get("asset");
  demand(url.origin === "http://core.invalid" && value === assetUrl(clientId, file || ""), "BRANDING_IMAGE_UPLOAD_REQUIRED");
  return file;
}
async function ownedDirectory(root, clientId, create = false) {
  demand(UUID.test(clientId));
  const base = path.join(root, "infra/runtime/client-brand-assets"), directory = path.join(base, clientId.toLowerCase());
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const current of [base, directory]) { const stat = await fs.lstat(current); demand(stat.isDirectory() && !stat.isSymbolicLink()); }
  return directory;
}
async function storeImage(root, clientId, bytes) {
  const info = inspectImage(bytes), file = `${info.sha256}.${info.extension}`;
  const directory = await ownedDirectory(root, clientId, true), destination = path.join(directory, file);
  try { await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; await readImage(root, clientId, file); }
  return { clientId, asset: file, url: assetUrl(clientId, file), ...info };
}
async function readImage(root, clientId, file) {
  demand(FILE.test(file));
  const directory = await ownedDirectory(root, clientId), absolute = path.join(directory, file);
  const stat = await fs.lstat(absolute); demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_IMAGE_BYTES);
  const bytes = await fs.readFile(absolute), info = inspectImage(bytes);
  demand(file === `${info.sha256}.${info.extension}`, "BRANDING_IMAGE_CHANGED");
  return { bytes, info, file };
}
async function resolveImage(root, clientId, value) {
  const file = parseAssetUrl(value, clientId);
  if (!file) return { imageUrl: "", assets: [], files: [] };
  const image = await readImage(root, clientId, file);
  const descriptor = { path: `core-branding/${file}`, sha256: image.info.sha256, bytes: image.info.bytes, mime: image.info.mime };
  return { imageUrl: `/${descriptor.path}`, assets: [descriptor], files: [{ file, bytes: image.bytes }] };
}
module.exports = { MAX_IMAGE_BYTES, LEGACY_BACKGROUND, inspectImage, assetUrl, parseAssetUrl, storeImage, readImage, resolveImage };
