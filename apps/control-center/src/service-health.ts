import { execFile } from "node:child_process";
import { get } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type HealthCheck = {
  healthState: "healthy" | "unhealthy" | "unknown" | "stopped";
  checkedAt: string;
  responseTimeMs: number;
  message: string;
};

function result(started: number, healthy: boolean, message: string): HealthCheck {
  return {
    healthState: healthy ? "healthy" : "unhealthy",
    checkedAt: new Date().toISOString(),
    responseTimeMs: Date.now() - started,
    message
  };
}

export function checkHttpHealth(url: string, expectedService: string, timeoutMs = 3000): Promise<HealthCheck> {
  const started = Date.now();
  return new Promise((resolve) => {
    let finished = false;
    const finish = (healthy: boolean, message: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result(started, healthy, message));
    };
    const request = get(url, { headers: { accept: "application/json" } }, (response) => {
      if (response.statusCode !== 200) {
        finish(false, `Порт открыт, но проверка приложения ${expectedService} вернула HTTP ${response.statusCode ?? "неизвестен"}. Проверьте журнал и конфликт портов.`);
        response.destroy();
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > 16384) {
          finish(false, "Получен слишком большой ответ проверки сервиса.");
          response.destroy();
        }
      });
      response.once("end", () => {
        try {
          const data = JSON.parse(body) as { service?: unknown; status?: unknown };
          const matches = data?.service === expectedService && data?.status === "ok";
          finish(matches, matches ? "Нужное приложение отвечает на проверку." : "На порту отвечает другой сервис или получен неверный статус.");
        } catch {
          finish(false, "На порту нет ожидаемого ответа приложения.");
        }
      });
      response.once("error", () => finish(false, "Ответ проверки сервиса прервался."));
    });
    // A total deadline also covers a connected server that never finishes its body.
    const timer = setTimeout(() => {
      finish(false, "Сервис не ответил на проверку вовремя.");
      request.destroy();
    }, timeoutMs);
    request.once("error", () => finish(false, "Не удалось получить ответ приложения."));
  });
}

export async function checkLocalPage(url: string, timeoutMs = 3000): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port || target.username || target.password) return result(started, false, "Проверка страницы разрешена только для локального приложения Core.");
    const response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "text/html", Connection: "close" } });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
      await response.body?.cancel();
      return result(started, false, `Технический маршрут отвечает, но стартовая страница не готова: HTTP ${response.status}. Проверьте журнал приложения.`);
    }
    const reader = response.body?.getReader();
    if (!reader) return result(started, false, "Стартовая страница не вернула содержимое.");
    let bytes = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 4 * 1024 * 1024) { await reader.cancel(); return result(started, false, "Стартовая страница превысила допустимый размер проверки."); } } }
    finally { reader.releaseLock(); }
    return result(started, bytes > 0, bytes > 0 ? "Приложение и стартовая страница готовы." : "Стартовая страница пуста.");
  } catch {
    return result(started, false, "Стартовая страница не загрузилась вовремя. Возможно, ещё идет сборка; проверьте журнал приложения.");
  }
}

export type DatabaseProbeRunner = (
  executable: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; windowsHide: boolean; maxBuffer: number }
) => Promise<{ stdout: string }>;

export async function checkPostgresHealth(
  executable: string,
  databaseUrl: string,
  expectedPort: number,
  runner: DatabaseProbeRunner = async (file, args, options) => execFileAsync(file, args, options)
): Promise<HealthCheck> {
  const started = Date.now();
  try {
    const connection = new URL(databaseUrl);
    const hostname = connection.hostname.replace(/^\[|\]$/g, "");
    if (!["postgres:", "postgresql:"].includes(connection.protocol) ||
        !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
        Number(connection.port || 5432) !== expectedPort || !connection.pathname.slice(1)) {
      return result(started, false, "Настройки БД не соответствуют локальному сервису. Удаленное подключение не выполнялось.");
    }
    const { stdout } = await runner(executable, ["-X", "-w", "-t", "-A", "-c", "SELECT 1"], {
      windowsHide: true,
      timeout: 4000,
      maxBuffer: 16384,
      env: {
        ...process.env,
        PGHOST: hostname,
        PGPORT: String(expectedPort),
        PGUSER: decodeURIComponent(connection.username),
        PGPASSWORD: decodeURIComponent(connection.password),
        PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
        PGCONNECT_TIMEOUT: "2",
        PGOPTIONS: "-c statement_timeout=2000"
      }
    });
    const healthy = stdout.trim() === "1";
    return result(started, healthy, healthy ? "Проектная база выполнила SQL-проверку." : "База вернула неожиданный результат проверки.");
  } catch {
    // Connection errors may contain a password or connection string; do not expose them.
    return result(started, false, "SQL-проверка не выполнена. Проверьте запуск PostgreSQL и параметры доступа к проектной базе.");
  }
}
