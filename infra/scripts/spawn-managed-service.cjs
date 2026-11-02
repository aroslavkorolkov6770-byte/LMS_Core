const { spawn } = require("node:child_process");
const path = require("node:path");
const { appendBoundedLog, createLogWriter, pruneServiceLogs } = require("./managed-logs.cjs");

try {
  const [workingDirectory, outputPath, errorPath, ...args] = process.argv.slice(2);
  if (!workingDirectory || !outputPath || !errorPath || args.length === 0) {
    throw new Error("Invalid service launch parameters.");
  }

  const logsRoot = path.join(workingDirectory, "infra", "runtime", "logs");
  const output = createLogWriter(logsRoot, outputPath);
  const errorOutput = createLogWriter(logsRoot, errorPath);
  const match = /^([a-z0-9-]+)-\d{8}-\d{6}-[a-f0-9]{8}\.out\.log$/i.exec(path.basename(outputPath));
  if (match) {
    try { pruneServiceLogs(logsRoot, match[1], [outputPath, errorPath]); }
    catch { appendBoundedLog(logsRoot, errorPath, "Previous log cleanup could not finish.\n"); }
  }
  const child = spawn(process.execPath, args, {
    cwd: workingDirectory,
    detached: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const handleLogError = () => {
    // A full/read-only disk must not freeze the service on a blocked output pipe.
    child.stdout.unpipe(output);
    child.stderr.unpipe(errorOutput);
    child.stdout.resume();
    child.stderr.resume();
    process.stderr.write("Service logging is unavailable. Check free space and log permissions.\n");
  };
  output.on("error", handleLogError);
  errorOutput.on("error", handleLogError);
  child.stdout.pipe(output);
  child.stderr.pipe(errorOutput);
  child.once("error", (error) => {
    try { appendBoundedLog(logsRoot, errorPath, `Service process failed to start: ${error.message}\n`); } catch {}
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    if (code && code !== 0) {
      try { appendBoundedLog(logsRoot, errorPath, `Service process exited with code ${code}.\n`); } catch {}
      process.exitCode = code;
    }
  });
} catch (error) {
  console.error(`Service launch failed: ${error.message}`);
  process.exitCode = 1;
}
