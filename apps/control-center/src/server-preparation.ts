import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NewInstallationService } from "./new-installation";
import { Credentials, normalizeRemoteTarget, RemoteSession, RemoteTarget, RemoteTargetService } from "./remote-target";
const version = "22.23.4", nodeSha = "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce";
const phases: Record<string, string> = { downloading: "Получаю проверенный Node 22...", connecting: "Проверяю SSH/Ubuntu до изменений...", uploading: "Передаю инструменты подготовки...", validating: "Проверяю ОС, память и конфликты...", packages: "Устанавливаю необходимые пакеты Ubuntu...", node: "Устанавливаю отдельный Node 22...", postgres: "Проверяю локальную PostgreSQL и peer-доступ...", succeeded: "Окружение готово. Повторите проверку сервера; для новой локальной БД пароль postgres не требуется.", failed: "Подготовка не запущена. Проверьте подключение и повторите попытку.", needs_attention: "Подготовка требует проверки. Смотрите код ошибки; чужие пароли не сбрасывались.", disconnected: "Наблюдение прервано. Сначала проверьте результат подготовки." };
const terminal = new Set(["succeeded", "failed", "needs_attention"]);
const preparationErrors: Record<string, string> = {
  INSUFFICIENT_RESOURCES: "Не хватает RAM + swap или свободного диска. Добавьте swap отдельной кнопкой либо увеличьте ресурсы у хостера, затем повторите подготовку Ubuntu.",
  UNSUPPORTED_SERVER: "Поддерживаются Ubuntu 24.04 и 26.04 amd64. Версия ОС не менялась.",
  ROOT_REQUIRED: "Для подготовки нужен SSH-пользователь root.",
  NODE_VERSION_CONFLICT: "На сервере уже есть несовместимая версия Node. Core ее не заменял.",
  PREPARATION_WORKER_STOPPED: "Процесс подготовки остановился. Перед повтором нужно проверить его результат.",
  APT_UPDATE_FAILED: "Не удалось обновить список пакетов Ubuntu. Проверьте доступ сервера к репозиториям.",
  APT_INSTALL_FAILED: "Ubuntu не смогла установить зависимости. Нужна проверка журнала подготовки."
};
const preparationMessage = (phase: string, code?: string) => phases[phase] + (code && preparationErrors[code] ? " " + preparationErrors[code] : "");
const memoryErrors: Record<string, string> = {
  ROOT_REQUIRED: "Нужен SSH-пользователь root.", UNSUPPORTED_SERVER: "Поддерживаются Ubuntu 24.04 и 26.04 amd64.", SYSTEMD_REQUIRED: "На сервере не подтвержден systemd.",
  RAM_TOO_LOW: "Системе доступно менее 900 МиБ RAM. Swap не заменяет необходимую оперативную память; увеличьте RAM у хостера.",
  SWAP_PATH_UNSAFE: "Служебный путь swap небезопасен; чужие файлы не изменены.", PREPARATION_BUSY: "На сервере уже идет подготовка. Дождитесь ее результата.",
  SWAP_FILE_OCCUPIED: "Путь swap занят неподтвержденным файлом. Core его не заменяет.", SWAP_FILE_INCOMPLETE: "Собственный swap-файл не завершен. Нужна проверка; автоматически файл не удаляется.",
  SWAP_FILESYSTEM_UNSUPPORTED: "Для этого способа создания swap нужна файловая система ext4 или XFS.",
  SWAP_DISK_LOW: "Нужно не менее 11 ГиБ свободного места: 4 ГиБ для swap и 7 ГиБ для сборки.",
  SWAP_TOOLS_MISSING: "На сервере отсутствуют стандартные инструменты создания swap.", SWAP_ALLOCATION_FAILED: "Не удалось выделить swap-файл. Проверьте свободное место; частичный файл не удаляется автоматически.",
  SWAP_INITIALIZATION_FAILED: "Не удалось инициализировать swap-файл.", SWAP_ACTIVATION_FAILED: "Хост не разрешил включить swap. Файл сохранен; проверьте ограничения виртуализации у хостера.",
  SWAP_NOT_ENOUGH: "После команды памяти по-прежнему недостаточно. Повторите проверку ресурсов.", SWAP_INTERRUPTED: "Команда swap прервалась. Перед повтором нужно проверить результат и файл."
};
export type PreparationState = { id: string; clientId: string; target: RemoteTarget; phase: string; message: string; updatedAt: string; errorCode?: string };
export class ServerPreparationService {
  private active = false;
  private activeId?: string;
  constructor(private readonly root: string, private readonly remote: Pick<RemoteTargetService, "withSession">, private readonly plans: Pick<NewInstallationService, "get">,
    private readonly targetAllowed = async (target: RemoteTarget) => ["127.0.0.1", "localhost"].includes(target.host)) {}
  private file(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("Некорректный клиент."); return path.join(this.root, "infra/runtime/server-preparations", id + ".json"); }
  async get(id: string): Promise<PreparationState | null> { try { const state = JSON.parse(await readFile(this.file(id), "utf8")); if (!/^[a-f0-9-]{36}$/.test(state.id) || state.clientId !== id || !Object.hasOwn(phases, state.phase) || !Number.isFinite(Date.parse(state.updatedAt))) return null;
    const phase = !terminal.has(state.phase) && state.id !== this.activeId ? "disconnected" : state.phase;
    return { id: state.id, clientId: id, target: normalizeRemoteTarget(state.target), phase, message: preparationMessage(phase, state.errorCode), updatedAt: state.updatedAt, ...(typeof state.errorCode === "string" && /^[A-Z_]{1,100}$/.test(state.errorCode) ? { errorCode: state.errorCode } : {}) }; } catch { return null; } }
  private async nodeArchive() {
    const base = path.join(this.root, "infra/runtime/node-distributions"), file = path.join(base, `node-v${version}-linux-x64.tar.xz`);
    let bytes: Buffer;
    try { bytes = await readFile(file); } catch {
      const response = await fetch(`https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.xz`, { redirect: "error", signal: AbortSignal.timeout(120000) });
      if (!response.ok || Number(response.headers.get("content-length")) > 64 * 1024 * 1024) throw Error("Не удалось получить Node с официального сервера.");
      if (!response.body) throw Error("Официальный сервер не вернул архив Node.");
      const chunks: Buffer[] = []; let length = 0;
      const reader = response.body.getReader();
      try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > 64 * 1024 * 1024) { await reader.cancel(); throw Error("Архив Node превышает допустимый размер."); } chunks.push(Buffer.from(next.value)); } }
      finally { reader.releaseLock(); }
      bytes = Buffer.concat(chunks, length);
      if (bytes.length > 64 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== nodeSha) throw Error("Контрольная сумма Node не совпала.");
      await mkdir(base, { recursive: true }); const temporary = file + "." + randomUUID() + ".tmp"; await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, file);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== nodeSha) throw Error("Сохраненный Node-архив изменился.");
    return bytes;
  }
  private async save(state: PreparationState, report: (state: PreparationState) => void) { const file = this.file(state.clientId); await mkdir(path.dirname(file), { recursive: true }); const temporary = file + "." + randomUUID() + ".tmp"; await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 }); await rename(temporary, file);
    try { report({ ...state }); } catch { /* Closing the UI must not change the persisted worker result. */ } }
  private readStatus(text: string, state: PreparationState) {
    const raw = JSON.parse(text);
    if (raw.id !== state.id || !Object.hasOwn(phases, raw.phase) || !Number.isFinite(Date.parse(raw.updatedAt))) throw Error("Неполный результат подготовки.");
    return { phase: raw.phase, message: preparationMessage(raw.phase, raw.errorCode), updatedAt: raw.updatedAt, ...(typeof raw.errorCode === "string" && /^[A-Z_]{1,100}$/.test(raw.errorCode) ? { errorCode: raw.errorCode } : {}) };
  }
  private async observe(session: RemoteSession, state: PreparationState) {
    const base = `/srv/lms-core/preparations/${state.id}`;
    const result = this.readStatus(await session.execute(`cat '${base}/status.json'`), state);
    if (!terminal.has(result.phase)) {
      const alive = await session.execute("sh -s", `set -eu\npid=$(cat '${base}/worker.pid' 2>/dev/null || true)\ncase "$pid" in ''|*[!0-9]*) printf stopped;; *) if kill -0 "$pid" 2>/dev/null; then printf running; else printf stopped; fi;; esac\n`);
      if (alive !== "running") return { phase: "needs_attention", message: phases.needs_attention, updatedAt: new Date().toISOString(), errorCode: "PREPARATION_WORKER_STOPPED" };
    }
    return result;
  }
  async prepare(clientId: string, planId: string, input: unknown, auth: Credentials, report: (state: PreparationState) => void) {
    if (this.active) throw Error("Подготовка уже выполняется."); this.active = true;
    let state: PreparationState | undefined, launched = false;
    try {
      const plan = await this.plans.get(clientId), target = normalizeRemoteTarget(input), previous = await this.get(clientId);
      if (!plan || plan.id !== planId || target.username !== "root" || !await this.targetAllowed(target) || !target.fingerprint || ["host", "port", "username", "basePath", "fingerprint"].some((key) => target[key as keyof RemoteTarget] !== plan.target[key as keyof RemoteTarget])) throw Error("Проверьте режим выполнения, выбранный Linux/root и подтвержденный SSH.");
      if (previous && !["succeeded", "failed"].includes(previous.phase)) {
        // These rejections occur before package/database changes; verify the exact old result on the pinned host.
        if (previous.phase !== "needs_attention" || !["INSUFFICIENT_RESOURCES", "UNSUPPORTED_SERVER"].includes(previous.errorCode || "") || ["host", "port", "username", "basePath", "fingerprint"].some((key) => target[key as keyof RemoteTarget] !== previous.target[key as keyof RemoteTarget])) throw Error("Сначала проверьте результат предыдущей подготовки.");
        const confirmed = await this.remote.withSession(target, { ...auth }, (session) => this.observe(session, previous));
        if (confirmed.phase !== "needs_attention" || confirmed.errorCode !== previous.errorCode) throw Error("Состояние предыдущей подготовки изменилось. Сначала проверьте результат.");
      }
      state = { id: randomUUID(), clientId, target, phase: "downloading", message: phases.downloading, updatedAt: new Date().toISOString() };
      this.activeId = state.id;
      const current = state; const progress = async (value: Partial<PreparationState>) => { Object.assign(current, value); await this.save(current, report); };
      await progress({}); const archive = await this.nodeArchive();
      await progress({ phase: "connecting", message: phases.connecting });
      return await this.remote.withSession(target, auth, async (session) => {
        const probe = await session.execute("sh -s", "set -eu\n[ $(id -u) = 0 ]\n. /etc/os-release\n[ \"$ID\" = ubuntu ] && { [ \"$VERSION_ID\" = 24.04 ] || [ \"$VERSION_ID\" = 26.04 ]; } && [ $(uname -m) = x86_64 ]\n[ -d /run/systemd/system ]\ncommand -v flock >/dev/null\nprintf CORE_UBUNTU_READY\n");
        if (probe !== "CORE_UBUNTU_READY") throw Error("Поддерживаются Ubuntu 24.04/26.04 amd64/root/systemd.");
        const dir = `/srv/lms-core/preparations/${current.id}`;
        const setup = `set -eu\numask 077\np=''\nfor part in srv lms-core preparations ${current.id}; do p="$p/$part"; [ ! -L "$p" ]; if [ ! -e "$p" ]; then if [ "$p" = /srv/lms-core ]; then mkdir -m 755 "$p"; else mkdir -m 700 "$p"; fi; fi; [ -d "$p" ]; [ "$(stat -c %u "$p")" = 0 ]; mode=$(stat -c %a "$p"); [ "$((0$mode & 0022))" = 0 ]; done\n`;
        await session.execute("sh -s", setup);
        await progress({ phase: "uploading", message: phases.uploading });
        await session.execute(`umask 077; cat > '${dir}/node.tar.xz'`, archive, 120000);
        const script = (await readFile(path.join(this.root, "infra/scripts/prepare-clean-server.sh"), "utf8")).replaceAll("__CORE_PREP_ID__", current.id);
        await session.execute(`umask 077; cat > '${dir}/prepare.sh'`, script);
        launched = true;
        await session.execute(`umask 077; nohup sh '${dir}/prepare.sh' > '${dir}/private.log' 2>&1 < /dev/null & printf '%s' "$!" > '${dir}/worker.pid'`, "");
        for (let i = 0; i < 1200; i++) { await new Promise((resolve) => setTimeout(resolve, 3000)); await progress(await this.observe(session, current)); if (terminal.has(current.phase)) return { ...current }; }
        throw Error("PREPARATION_OBSERVATION_TIMEOUT");
      });
    } catch (error) { if (!state) throw error; Object.assign(state, { phase: launched ? "disconnected" : "failed", message: phases[launched ? "disconnected" : "failed"], errorCode: "PREPARATION_NOT_CONFIRMED" }); await this.save(state, report); return state; }
    finally { this.active = false; this.activeId = undefined; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
  async prepareMemory(clientId: string, planId: string, input: unknown, auth: Credentials) {
    if (this.active) throw Error("Подготовка уже выполняется.");
    this.active = true;
    try {
      const plan = await this.plans.get(clientId), target = normalizeRemoteTarget(input);
      if (!plan || plan.id !== planId || target.username !== "root" || !await this.targetAllowed(target) || !target.fingerprint || ["host", "port", "username", "basePath", "fingerprint"].some((key) => target[key as keyof RemoteTarget] !== plan.target[key as keyof RemoteTarget])) throw Error("Выбран другой план, сервер или неподтвержденный SSH-доступ.");
      const script = await readFile(path.join(this.root, "infra/scripts/prepare-build-memory.sh"), "utf8");
      const result = await this.remote.withSession(target, auth, async (session) => {
        const raw = JSON.parse(await session.execute("sh -s", script, 240000));
        if (raw?.version !== 1 || typeof raw.ok !== "boolean") throw Error("Некорректный результат подготовки памяти.");
        if (!raw.ok) {
          if (typeof raw.code !== "string" || !memoryErrors[raw.code]) throw Error("Неизвестный результат подготовки памяти. Проверьте сервер перед повтором.");
          return { ok: false as const, errorCode: raw.code as string, message: memoryErrors[raw.code] };
        }
        if (![raw.memoryBytes, raw.swapBytes].every((value) => Number.isSafeInteger(value) && value >= 0) || ![0, 1].includes(raw.created) || ![0, 1].includes(raw.reused) || raw.memoryBytes < 900 * 1024 ** 2 || raw.memoryBytes + raw.swapBytes < 3 * 1024 ** 3) throw Error("Подтвержденных ресурсов после подготовки недостаточно.");
        return { ok: true as const, memoryBytes: raw.memoryBytes as number, swapBytes: raw.swapBytes as number, created: raw.created === 1, reused: raw.reused === 1,
          message: `Память готова: RAM ${Math.round(raw.memoryBytes / 1024 ** 2)} МиБ, swap ${(raw.swapBytes / 1024 ** 3).toFixed(2)} ГиБ. ${raw.created ? "Создан swap-файл 4 ГиБ; активен до перезагрузки, файл автоматически не удаляется." : raw.reused ? "Использован проверенный собственный swap-файл Core." : "Ресурсов уже достаточно; новый файл не создавался."} Повторите подготовку Ubuntu и проверку сервера.` };
      });
      const directory = path.join(this.root, "infra/runtime/memory-preparations");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `${clientId}.json`), temporary = file + "." + randomUUID() + ".tmp";
      await writeFile(temporary, JSON.stringify({ version: 1, clientId, planId, target, checkedAt: new Date().toISOString(), ...result }), { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
      return result;
    } finally { this.active = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
  async refresh(clientId: string, input: unknown, auth: Credentials, report: (state: PreparationState) => void) {
    if (this.active) throw Error("Подготовка еще выполняется.");
    this.active = true;
    try { const state = await this.get(clientId), target = normalizeRemoteTarget(input); if (!state || ["host", "port", "username", "basePath", "fingerprint"].some((key) => target[key as keyof RemoteTarget] !== state.target[key as keyof RemoteTarget])) throw Error("Другая SSH-цель.");
      Object.assign(state, await this.remote.withSession(state.target, auth, (session) => this.observe(session, state))); await this.save(state, report); return state;
    } finally { this.active = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
}
