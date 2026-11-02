"use strict";
const http = require("node:http");
const path = require("node:path");
try { process.loadEnvFile(path.join(process.cwd(), ".env.production.local")); } catch (error) { if (error.code !== "ENOENT") throw error; }
const context = JSON.parse(require("node:fs").readFileSync(process.env.CORE_AI_FIXTURE_CONTEXT, "utf8"));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  const key = process.env.AI_API_KEY || "";
  response.end(JSON.stringify(request.url === "/fixture/check" ? { tokenVersion: ["fixture-ai-v1", "fixture-ai-v2", "fixture-ai-v3"].indexOf(key) + 1, unrelatedPreserved: process.env.CORE_AI_UNRELATED === "must-survive" } :
    { protocol: "lms-core-client-v1", status: "ok", clientId: context.clientId, releaseId: context.releaseId }));
}).listen(port, "127.0.0.1");
