const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "../..");

(async () => {
  const fromNext = createRequire(require.resolve("next", { paths: [path.join(root, "apps/deploy-panel")] }));
  const sharp = fromNext("sharp"), directory = path.join(root, "apps/control-center/renderer/assets");
  const source = await fs.readFile(path.join(directory, "core-mark.svg"));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const size of sizes) frames.push(await sharp(source).resize(size, size).png().toBuffer());
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (const [index, size] of sizes.entries()) {
    const at = 6 + index * 16;
    header[at] = size === 256 ? 0 : size; header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(frames[index].length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += frames[index].length;
  }
  await fs.writeFile(path.join(directory, "core-mark.ico"), Buffer.concat([header, ...frames]));
  await sharp(source).resize(256, 256).png().toFile(path.join(directory, "core-mark.png"));
  console.log(JSON.stringify({ icon: path.join(directory, "core-mark.ico"), sizes, bytes: offset }));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
