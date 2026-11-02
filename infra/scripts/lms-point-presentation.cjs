"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const root = path.resolve(__dirname, "../..");
const { CATALOG, validatePointDesign } = require("./point-design-contract.cjs");
const { designHash } = require("./client-design-contract.cjs");
const { createPointRuntime } = require("../lms-adapter/point-editor-preload.cjs");
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function applyPointPresentation(directory, input, sourceRevision) {
  const document = validatePointDesign(input);
  if (document.sourceRevision !== sourceRevision) throw Error("POINT_DESIGN_SOURCE_MISMATCH");
  for (const id of Object.keys(document.elements)) {
    const item = CATALOG.find((entry) => entry.id === id);
    const source = await fs.readFile(path.join(directory, item.file), "utf8");
    if (!source.includes(item.anchor)) throw Error(`POINT_ELEMENT_NOT_SUPPORTED:${id}`);
  }
  const file = path.join(directory, "app/layout.tsx"), before = await fs.readFile(file, "utf8");
  if (before.split("<ThemeProvider>").length !== 2 || before.split("</ThemeProvider>").length !== 2 || before.includes("CorePointDesign") || before.includes("CoreClientDesign")) throw Error("POINT_LAYOUT_NOT_SUPPORTED");
  // No logo/text/theme/CSS source is rewritten. The single root hook mounts the exact same point patcher as preview.
  const after = 'import CorePointDesign from "./components/CorePointDesign";\nimport { readCorePointDesign } from "./lib/corePointDesignServer";\n' + before.replace("</ThemeProvider>", "<CorePointDesign design={readCorePointDesign()} />\n        </ThemeProvider>");
  await fs.writeFile(file, after);
  for (const name of ["CorePointDesign.tsx", "corePointDesignServer.ts"]) {
    const destination = name.startsWith("Core") ? "app/components" : "app/lib";
    await fs.copyFile(path.join(root, "infra/lms-adapter", name), path.join(directory, destination, name));
  }
  await fs.writeFile(path.join(directory, "app/lib/corePointRuntime.ts"), `// @ts-nocheck\n// Generated from the reviewed preview runtime; no document-supplied code.\nexport const createPointRuntime = ${createPointRuntime.toString()};\n`, { flag: "wx" });
  await fs.writeFile(path.join(directory, "app/lib/corePointCatalog.json"), JSON.stringify(CATALOG), { flag: "wx" });
  for (const [source, destination] of [["client-design-contract.cjs", "core-client-design-contract.cjs"], ["point-design-contract.cjs", "point-design-contract.cjs"]]) await fs.copyFile(path.join(root, "infra/scripts", source), path.join(directory, destination));
  await fs.writeFile(path.join(directory, "core-client-design.json"), JSON.stringify(document), { flag: "wx" });
  return { version: 3, clientId: document.clientId, sha256: designHash(document), supportedTextKeys: [], supportedElementIds: Object.keys(document.elements), supportedSettings: ["point.elements"], unsupportedSettings: [], warnings: [],
    modifiedFiles: [{ path: "app/layout.tsx", beforeSha256: hash(before), afterSha256: hash(after) }] };
}
module.exports = { applyPointPresentation };
