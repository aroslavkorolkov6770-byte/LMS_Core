import { spawn } from "node:child_process";

export function runJsonCommand<T>(
  executable: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  isExpectedResult: (value: unknown) => value is T
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exitTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      clearTimeout(timeout);
      if (exitTimer) clearTimeout(exitTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      child.kill();
      fail(new Error("Команда не ответила вовремя. Проверьте журнал сервиса."));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) {
        fail(new Error("Слишком большой ответ команды управления."));
        return;
      }

      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline).trim().replace(/^\uFEFF/, "");
        stdout = stdout.slice(newline + 1);
        try {
          const value: unknown = JSON.parse(line);
          if (isExpectedResult(value)) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
            return;
          }
        } catch {
          // Continue reading until the script emits its final JSON response.
        }
        newline = stdout.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.once("error", fail);
    child.once("exit", (code) => {
      if (settled) return;
      exitTimer = setTimeout(() => {
        fail(new Error(stderr.trim() || `Команда завершилась без ответа (код ${code ?? "неизвестен"}).`));
      }, 300);
    });
  });
}
