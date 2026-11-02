// Test entry loads the unchanged Core main with probe instrumentation and its ordinary Windows profile.
const path = require("node:path");
const { app } = require("electron");
const root = path.resolve(__dirname, "../..");
const manifest = require(path.join(root, "apps/control-center/package.json"));
app.setName(manifest.name);
app.setPath("userData", path.join(app.getPath("appData"), manifest.name));
require("./native-probe-hook.cjs");
require(path.join(root, "apps/control-center/dist/main.js"));
