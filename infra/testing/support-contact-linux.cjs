"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const exec = require("node:util").promisify(require("node:child_process").execFile);
const { runFixture } = require("./ai-linux-acceptance.cjs");
const mail = require("../scripts/configure-lms-mail.cjs");
const root = path.resolve(__dirname, "../..");

async function acceptance(output, source) {
  const patch = JSON.parse(await fs.readFile(path.join(output, "patch.json"), "utf8"));
  const emit = async value => { await fs.writeFile(path.join(output, "stage.tmp"), JSON.stringify(value)); await fs.rename(path.join(output, "stage.tmp"), path.join(output, "stage.json")); };
  async function wait(name) {
    for (let attempt = 0; attempt < 900; attempt++) {
      try { await fs.access(path.join(output, name)); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error("CONTACT_BROWSER_TIMEOUT_" + name);
  }
  await runFixture(async ({ c, run, app, shared, user, unit }) => {
    await run("systemctl", ["stop", unit]);
    // Only reusable dependency code is copied from the existing local test LMS, never its data or configuration.
    const modules = "/srv/lms-core/clients/demo-client/current/lms/node_modules";
    await fs.rename(path.join(app, "node_modules"), path.join(app, "fixture-node-modules"));
    await fs.cp(modules, path.join(app, "node_modules"), { recursive: true });
    for (const name of ["app/components/Footer.tsx", "app/components/VatesLogo.tsx", "app/components/CustomIcon.tsx", "app/privacy/page.tsx", "public/vates-logo-transparent.png"]) {
      await fs.mkdir(path.dirname(path.join(app, name)), { recursive: true });
      await fs.copyFile(path.join(source, name), path.join(app, name));
    }
    await fs.writeFile(path.join(app, "package.json"), JSON.stringify({ name: "core-contact-isolated-test", private: true, dependencies: { next: "16.2.4", react: "19.2.4", "react-dom": "19.2.4" } }));
    await fs.writeFile(path.join(app, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020", lib: ["dom", "esnext"], strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, module: "esnext", moduleResolution: "bundler", jsx: "react-jsx", resolveJsonModule: true, isolatedModules: true, plugins: [{ name: "next" }], paths: { "@/*": ["./*"] } }, include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"], exclude: ["node_modules"] }));
    await fs.writeFile(path.join(app, "next.config.ts"), "import type { NextConfig } from 'next'; const config: NextConfig={poweredByHeader:false}; export default config;\n");
    await fs.writeFile(path.join(app, "app/layout.tsx"), "import Footer from './components/Footer';export default function Layout({children}:{children:React.ReactNode}){return <html lang='ru'><body>{children}<Footer/></body></html>};\n");
    await fs.writeFile(path.join(app, "app/page.tsx"), "export default function Page(){return <main><h1>Local contact acceptance</h1><a href='/privacy?doc=privacy#privacy'>Privacy</a></main>};\n");
    const api = path.join(app, "app/api/core-runtime/health"); await fs.mkdir(api, { recursive: true });
    await fs.writeFile(path.join(api, "route.ts"), "export const dynamic='force-dynamic';export async function GET(){return Response.json({protocol:'lms-core-client-v1',status:'ok',clientId:process.env.CORE_RUNTIME_CLIENT_ID,releaseId:process.env.CORE_RUNTIME_RELEASE_ID})};\n");
    const smtp = path.join(app, "app/api/send-email"); await fs.mkdir(smtp, { recursive: true });
    await fs.writeFile(path.join(smtp, "route.ts"), "// Fixture capability only: nodemailer createTransport sendMail process.env.SMTP_USER SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS\nexport async function POST(){return new Response(null,{status:405})};\n");
    await fs.writeFile(path.join(app, "app/lib/aliceAi.ts"), "// Fixture capability: getAliceAiConfig AI_API_KEY AI_PROJECT_ID AI_PROMPT_ID AI_VECTOR_STORE_ID\nexport {};\n");
    await run("chown", ["-R", `${user}:${user}`, app]);
    await run("chmod", ["-R", "u=rwX,g=rX,o=", app]);
    const baseline = await exec("/usr/sbin/runuser", ["-u", user, "--", process.execPath, path.join(app, "node_modules/next/dist/bin/next"), "build", "--webpack"], { cwd: app, timeout: 600000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: shared, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" } });
    await fs.writeFile(path.join(output, "baseline-build.log"), baseline.stdout + baseline.stderr);
    const oldBuild = await fs.readFile(path.join(app, ".next/BUILD_ID"), "utf8");
    await run("systemctl", ["start", unit]);
    async function healthy() {
      for (let attempt = 0; ; attempt++) {
        try { const r = await fetch(`http://127.0.0.1:${c.webPort}/api/core-runtime/health`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch {}
        if (attempt > 50) throw Error("REAL_NEXT_NOT_READY"); await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    await healthy();
    const settings = { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "465", SMTP_SECURE: "true", SMTP_USER: "first@example.invalid", SMTP_PASS: "fixture-contact-pass" };
    let probes = 0, running = true;
    const monitor = (async () => { while (running) { try { if ((await fetch(`http://127.0.0.1:${c.webPort}/api/core-runtime/health`, { signal: AbortSignal.timeout(1000) })).ok) probes++; } catch {} await new Promise(resolve => setTimeout(resolve, 150)); } })();
    const first = await mail.configureMail({ ...c, operationId: randomUUID() }, settings, { run, contactPatch: patch });
    running = false; await monitor;
    await fs.writeFile(path.join(output, "first-result.json"), JSON.stringify(first, null, 2));
    if (first.phase !== "applied") await fs.copyFile(path.join(shared, "contact-build.private.log"), path.join(output, "upgrade-build.log")).catch(() => {});
    assert.equal(first.phase, "applied", JSON.stringify(first)); assert.equal(first.buildPerformed, true); assert.equal(first.supportEmail, settings.SMTP_USER); assert.ok(probes > 5);
    const newBuild = await fs.readFile(path.join(app, ".next/BUILD_ID"), "utf8"); assert.notEqual(newBuild, oldBuild);
    assert.equal(await fs.readFile(path.join(app, "app/components/Footer.tsx"), "utf8"), patch.files.find(file => file.path.endsWith("Footer.tsx")).contents);
    await emit({ phase: "first", url: `http://127.0.0.1:${c.webPort}`, email: settings.SMTP_USER });
    await wait("rotate");
    const second = await mail.configureMail({ ...c, operationId: randomUUID() }, { ...settings, SMTP_USER: "second@example.invalid", SMTP_PASS: "" }, { run, contactPatch: patch });
    assert.equal(second.phase, "applied", JSON.stringify(second)); assert.equal(second.buildPerformed, false); assert.equal(second.supportEmail, "second@example.invalid");
    assert.equal(await fs.readFile(path.join(app, ".next/BUILD_ID"), "utf8"), newBuild);
    const env = await fs.readFile(path.join(shared, "ai.env"), "utf8");
    assert.ok(env.includes("fixture-ai-v2") && env.includes("CORE_AI_UNRELATED=must-survive"));
    const parsed = require("node:util").parseEnv(env);
    assert.equal(parsed.SUPPORT_EMAIL, "second@example.invalid"); assert.equal(parsed.VAPID_SUBJECT, "mailto:second@example.invalid");
    assert.equal(JSON.stringify(second).includes(settings.SMTP_PASS), false);
    await emit({ phase: "second", url: `http://127.0.0.1:${c.webPort}`, email: "second@example.invalid" });
    await wait("finish");
    const failed = await mail.configureMail({ ...c, operationId: randomUUID() }, { ...settings, SMTP_USER: "rollback@example.invalid" }, { run, contactPatch: patch, attempts: 2, delayMs: 100,
      fetch: async (url, init) => { const response = await fetch(url, init); const value = await (await fetch(`http://127.0.0.1:${c.webPort}/api/core-runtime/support-contact`)).json(); return value.supportEmail === "rollback@example.invalid" ? { ok: false, json: () => response.json() } : response; } });
    assert.equal(failed.phase, "failed"); assert.equal(failed.rollbackRestored, true);
    assert.equal(await fs.readFile(path.join(shared, "ai.env"), "utf8"), env);
    const response = await fetch(`http://127.0.0.1:${c.webPort}/api/core-runtime/support-contact`);
    assert.deepEqual(await response.json(), { protocol: "lms-core-support-contact-v1", supportEmail: "second@example.invalid" });
    assert.match(response.headers.get("cache-control"), /no-store/);
    await fs.writeFile(path.join(output, "linux-contact-receipt.json"), JSON.stringify({ realLinuxSystemd: true, realNextProductionBuild: true, oneTimeUpgrade: true, healthyResponsesDuringUpgrade: probes, rotationWithoutBuild: true, envPreserved: true, healthFailureRollback: true, sourcePatchVerified: true, publicApiOnlyEmail: true, externalRequests: 0 }, null, 2));
  });
  await emit({ phase: "complete" });
}
acceptance(process.argv[2], process.argv[3]).catch(async error => { console.error(error.stack || error.message); try { await fs.writeFile(path.join(process.argv[2], "failure.txt"), error.stack || error.message); } catch {} process.exitCode = 1; });
