"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { createInstallDriver, InstallError } = require("./lms-new-install-worker.cjs");
const demand = (value, code) => { if (!value) throw new InstallError(code); };

// Finish only the known post-bootstrap interruption. This does not rebuild, recreate SQL or change logins.
async function resumeBootstrappedInstallation(input, options = {}) {
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  demand(input && [input.jobId, input.clientId, input.releaseId].every(value => uuid.test(value || "")), "RESUME_IDENTITY_INVALID");
  demand(options.fixture === true || process.platform === "linux" && process.getuid?.() === 0, "LINUX_ROOT_REQUIRED");
  const directory = path.join(options.jobRoot || "/srv/lms-core/jobs", input.jobId);
  let current = path.parse(path.resolve(directory)).root;
  for (const part of path.resolve(directory).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const stat = await fs.lstat(current);
    demand(stat.isDirectory() && !stat.isSymbolicLink() && (options.fixture === true || stat.uid === 0 && !(stat.mode & 0o022)), "RESUME_DIRECTORY_UNSAFE");
  }
  const config = JSON.parse(await fs.readFile(path.join(directory, "job.json"), "utf8")), job = config.job;
  demand(job.id === input.jobId && job.client.id === input.clientId && job.releaseId === input.releaseId &&
    input.appPath === path.join(options.base || "/srv/lms-core/clients", job.client.slug), "RESUME_IDENTITY_CHANGED");
  const previous = JSON.parse(await fs.readFile(path.join(directory, "status.json"), "utf8"));
  demand(previous.id === job.id && previous.clientId === input.clientId && previous.releaseId === job.releaseId &&
    previous.phase === "needs_attention" && previous.failedStep === "bootstrap" && previous.errorCode === "CURRICULUM_INSTALL_VERIFY_FAILED", "RESUME_STAGE_NOT_SUPPORTED");
  demand(/^[a-f0-9]{64}$/.test(config.sha256) && crypto.createHash("sha256").update(await fs.readFile(path.join(directory, "code.tar"))).digest("hex") === config.sha256, "ARCHIVE_HASH_MISMATCH");
  try {
    const pid = Number(await fs.readFile(path.join(directory, "worker.pid"), "utf8"));
    if (pid > 1) {
      try {
        const cmd = await fs.readFile(`/proc/${pid}/cmdline`, "utf8");
        demand(!cmd.split("\0").includes(path.join(directory, "lms-install-job.cjs")), "INSTALL_WORKER_STILL_RUNNING");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const driver = createInstallDriver(job, null, path.join(directory, "payload"), { ...options, resume: true });
  if (options.inspect === true) {
    await driver.validateResume();
    return { phase: "checked", clientId: input.clientId, jobId: job.id, releaseId: job.releaseId, resumeAvailable: true };
  }
  const lockFile = path.join(directory, ".content-resume.lock"), lock = await fs.open(lockFile, "wx", 0o600);
  let failedStep = "validateResume", started = false;
  const persist = async state => {
    const temporary = path.join(directory, `resume-status-${crypto.randomUUID()}.tmp`);
    const value = { id: job.id, clientId: input.clientId, releaseId: job.releaseId, webPort: job.webPort, apiPort: job.apiPort,
      events: [...(previous.events || []), { phase: "resuming_content", at: new Date().toISOString() }], updatedAt: new Date().toISOString(), ...state };
    await fs.writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await fs.rename(temporary, path.join(directory, "status.json"));
    return value;
  };
  try {
    // Validation is read-only. Preserve the old failure if ownership or vault verification fails.
    await driver.validateResume(); started = true;
    for (const [stage, phase] of [["resumeContent", "bootstrap"], ["configure", "configure"], ["activate", "activate"], ["health", "health"], ["commit", "commit"]]) {
      failedStep = stage; await persist({ phase }); await driver[stage]();
    }
    return await persist({ phase: "succeeded", failedStep: null, errorCode: null, resumedWithoutDatabaseReset: true });
  } catch (error) {
    if (!started) throw error;
    let cleanupFailed = false;
    try { await driver.cleanup(); } catch { cleanupFailed = true; }
    return await persist({ phase: "needs_attention", failedStep,
      errorCode: cleanupFailed ? "OWN_SERVICE_CLEANUP_FAILED" : error instanceof InstallError ? error.code : "INSTALL_RESUME_FAILED" });
  } finally { await lock.close(); await fs.unlink(lockFile); }
}
module.exports = { resumeBootstrappedInstallation };
