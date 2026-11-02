import { createReadStream, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GitReadCommand, normalizeRepositoryConfig, parseRemoteRefs, RepositoryConfig, repositoryFailure } from "./repository";

const execFileAsync = promisify(execFile);
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 20000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export type SourceSnapshot = {
  id: string; repositoryUrl: string; requestedBranch: string; branch: string; revision: string; fetchedAt: string;
  sourcePath: string; archivePath: string; archiveSha256: string; archiveBytes: number; fileCount: number; sourceBytes: number;
  project: { kind: "nextjs" | "unknown"; packageManager: string; hasBuild: boolean; hasStart: boolean; nodeEngine: string };
  warnings: string[];
};
export type SourceState = {
  phase: "idle" | "working" | "ready" | "failed"; step: string; message: string;
  attemptedAt: string | null; repositoryUrl: string; requestedBranch: string; snapshot: SourceSnapshot | null;
};
type GitAccess = {
  withReadAccess<T>(input: unknown, operation: (config: RepositoryConfig, git: GitReadCommand) => Promise<T>): Promise<T>;
};
type ArchiveRunner = (file: string, args: string[], options: { cwd: string; timeout: number; maxBuffer: number; windowsHide: boolean }) => Promise<{ stdout: string; stderr: string }>;
type TreeEntry = { name: string; bytes: number };
class SourceError extends Error {}

export function parseSourceTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const portableNames = new Set<string>();
  let bytes = 0;
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\s+(-|\d+)\t(.+)$/s.exec(record);
    if (!match) throw new SourceError("Git вернул неполный список файлов. Получение остановлено.");
    const [, mode, type, , rawBytes, name] = match;
    if (mode === "160000") throw new SourceError("В репозитории есть Git submodules. Их получение пока не поддерживается; неполный код не будет выдан за готовый.");
    if (mode === "120000") throw new SourceError("В репозитории есть символьные ссылки. Требуется отдельная проверка переносимости перед загрузкой.");
    if (!["100644", "100755"].includes(mode) || type !== "blob") throw new SourceError("Неподдерживаемый тип файла Git.");
    const parts = name.split("/");
    if (/[\x00-\x1f\x7f\\:]/.test(name) || parts.some((part) => !part || part === "." || part === ".." ||
      part.toLowerCase() === ".git" || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new SourceError("В Git есть небезопасное или непереносимое имя файла. Рабочая копия не создана.");
    }
    const key = name.toLocaleLowerCase("en-US");
    if (portableNames.has(key)) throw new SourceError("В Git есть файлы, отличающиеся только регистром. Такая версия неоднозначна на Windows.");
    portableNames.add(key);
    const size = Number(rawBytes);
    if (!Number.isSafeInteger(size) || size < 0) throw new SourceError("Не удалось определить размер файлов Git.");
    bytes += size;
    entries.push({ name, bytes: size });
    if (bytes > MAX_SOURCE_BYTES || entries.length > MAX_FILES) throw new SourceError("Версия превышает лимит: 512 MiB исходников или 20 000 файлов.");
  }
  if (!entries.length) throw new SourceError("В выбранной версии нет файлов.");
  return entries;
}

export function sourceWarnings(entries: TreeEntry[]): string[] {
  const names = entries.map((entry) => entry.name);
  const warnings: string[] = [];
  if (names.some((name) => /(^|\/)\.env(?:\.|$)/i.test(name) && !/\.(?:example|sample|template)$/i.test(name))) {
    warnings.push("В Git есть env-файлы. До отправки на сервер нужно исключить чужие секреты и подготовить окружение клиента.");
  }
  if (names.some((name) => /(^|\/)(?:id_rsa|id_ed25519|[^/]+\.(?:pem|p12|pfx|key))$/i.test(name))) {
    warnings.push("В Git есть файлы, похожие на ключи. Нельзя отправлять пакет без проверки состава.");
  }
  if (names.some((name) => /^data\/(?!seed\/).+\.json$/i.test(name))) {
    warnings.push("В Git есть JSON-данные. Перед созданием клиентской версии нужно отделить учебный контент от пользователей, сессий и прогресса пилота.");
  }
  if (names.some((name) => /(^|\/)node_modules\//.test(name))) {
    warnings.push("В Git присутствует node_modules. Зависимости нужно собирать для ОС сервера, а не переносить с ноутбука.");
  }
  return warnings;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export class SourceSnapshotService {
  private readonly cache: string;
  private readonly stateFile: string;
  private active: SourceState | null = null;

  constructor(private readonly root: string, private readonly repository: GitAccess, private readonly tar: string,
    private readonly runner: ArchiveRunner = (file, args, options) => execFileAsync(file, args, options)) {
    this.cache = path.join(root, "infra", "runtime", "source-cache");
    this.stateFile = path.join(root, "infra", "runtime", "source-fetch.json");
  }

  private validSnapshot(input: unknown): input is SourceSnapshot {
    if (!input || typeof input !== "object") return false;
    const value = input as SourceSnapshot;
    if (typeof value.id !== "string" || !UUID.test(value.id) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.revision || "") ||
        !/^[a-f0-9]{64}$/.test(value.archiveSha256 || "")) return false;
    const directory = path.join(this.cache, value.id);
    return value.sourcePath === path.join(directory, "source") && value.archivePath === path.join(directory, "source.tar") &&
      typeof value.repositoryUrl === "string" && typeof value.requestedBranch === "string" && typeof value.branch === "string" &&
      typeof value.fetchedAt === "string" && Array.isArray(value.warnings) && value.warnings.every((item) => typeof item === "string") &&
      [value.archiveBytes, value.fileCount, value.sourceBytes].every((item) => Number.isSafeInteger(item) && item >= 0) &&
      ["nextjs", "unknown"].includes(value.project?.kind) && typeof value.project?.packageManager === "string";
  }

  async getState(): Promise<SourceState> {
    if (this.active) return this.active;
    try {
      const value = JSON.parse(await readFile(this.stateFile, "utf8")) as SourceState;
      if (!["idle", "working", "ready", "failed"].includes(value.phase) || typeof value.message !== "string" ||
          typeof value.repositoryUrl !== "string" || typeof value.requestedBranch !== "string" || typeof value.step !== "string") throw new Error("Invalid source state");
      const snapshot = this.validSnapshot(value.snapshot) && existsSync(value.snapshot.archivePath) && existsSync(value.snapshot.sourcePath) ? value.snapshot : null;
      if (value.phase === "working") return { ...value, phase: "failed", message: "Предыдущее получение кода прервано. Повторите операцию; незавершенная версия не используется.", snapshot };
      if (value.phase === "ready" && !snapshot) return { ...value, phase: "failed", message: "Файлы полученной версии недоступны. Получите код повторно.", snapshot: null };
      return { ...value, snapshot };
    } catch {
      return { phase: "idle", step: "idle", message: "Код из Git еще не получен.", attemptedAt: null, repositoryUrl: "", requestedBranch: "", snapshot: null };
    }
  }

  private async persist(state: SourceState): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { flag: "wx" });
    await rename(temporary, this.stateFile);
  }

  async verifySnapshot(id: string): Promise<SourceSnapshot> {
    if (!UUID.test(id)) throw new SourceError("Некорректный идентификатор версии.");
    const snapshot = JSON.parse(await readFile(path.join(this.cache, id, "source-manifest.json"), "utf8"));
    if (!this.validSnapshot(snapshot)) throw new SourceError("Описание версии повреждено.");
    if ((await sha256(snapshot.archivePath)) !== snapshot.archiveSha256) throw new SourceError("Архив кода изменен после получения. Требуется повторное скачивание.");
    return snapshot;
  }

  async fetch(input: unknown, report: (state: SourceState) => void = () => {}): Promise<SourceState> {
    if (this.active) throw new Error("Получение кода уже выполняется.");
    const config = normalizeRepositoryConfig(input);
    const previous = await this.getState();
    // Set the lock before the first asynchronous preparation of this operation.
    if (this.active) throw new Error("Получение кода уже выполняется.");
    const state: SourceState = { phase: "working", step: "checking_access", message: "Проверяю источник Git...", attemptedAt: new Date().toISOString(), repositoryUrl: config.url, requestedBranch: config.branch, snapshot: previous.snapshot };
    this.active = state;
    const id = randomUUID();
    const staging = path.join(this.cache, `.staging-${id}`);
    const directory = path.join(this.cache, id);
    const progress = async (step: string, message: string) => {
      Object.assign(state, { step, message });
      await this.persist(state);
      report({ ...state });
    };
    try {
      await mkdir(this.cache, { recursive: true });
      const space = await statfs(this.cache);
      if (space.bavail * space.bsize < 2 * 1024 * 1024 * 1024) throw new SourceError("Для безопасного получения версии нужно не менее 2 GiB свободного места.");
      await progress("checking_access", "Проверяю доступ, ветку и точный commit...");
      const snapshot = await this.repository.withReadAccess(config, async (_normalized, git) => {
        const remote = await git(["ls-remote", "--symref", "--exit-code", "--", config.url, "HEAD", "refs/heads/*"]);
        const selected = parseRemoteRefs(remote.stdout, config.branch);
        if (selected.status !== "connected" || !selected.selectedBranch || !selected.revision) throw new SourceError(selected.message);
        await mkdir(staging, { recursive: false });
        const gitDirectory = path.join(staging, "objects.git");
        const source = path.join(staging, "source");
        const emptyTemplate = path.join(staging, "empty-template");
        await mkdir(emptyTemplate);
        const inRepository = (args: string[], timeout?: number, maxBuffer?: number) => git([
          "--git-dir", gitDirectory, "-c", `core.hooksPath=${emptyTemplate}`, "-c", "core.autocrlf=false", "-c", "core.symlinks=false", ...args
        ], timeout, maxBuffer);
        await git(["init", "--bare", `--template=${emptyTemplate}`, gitDirectory]);
        await progress("fetching", `Получаю ветку ${selected.selectedBranch}, версия ${selected.revision.slice(0, 12)}...`);
        await inRepository(["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", config.url, `refs/heads/${selected.selectedBranch}`], 120000);
        const fetched = (await inRepository(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).stdout.trim();
        if (fetched !== selected.revision) throw new SourceError("Ветка изменилась во время скачивания. Повторите получение, чтобы версия была однозначной.");
        await progress("checking_files", "Проверяю список файлов, размер и переносимость версии...");
        const entries = parseSourceTree((await inRepository(["ls-tree", "-r", "-l", "-z", "--full-tree", fetched], 25000, 16 * 1024 * 1024)).stdout);
        await mkdir(source);
        await inRepository(["--work-tree", source, "-c", "core.bare=false", "checkout", "--force", fetched, "--", "."], 60000);
        const warnings = sourceWarnings(entries);
        const project = await this.inspectProject(source);
        if (project.kind === "unknown" || !project.hasBuild || !project.hasStart) warnings.push("Способ сборки/запуска не определен автоматически. Нужна настройка адаптера перед развёртыванием.");
        await progress("packing", "Создаю архив исходников и контрольную сумму. Код проекта не запускается...");
        const archive = path.join(staging, "source.tar");
        // Preserve Git executable bits and all tracked files, without export-ignore/subst changing the snapshot.
        await mkdir(path.join(gitDirectory, "info"), { recursive: true });
        await writeFile(path.join(gitDirectory, "info", "attributes"), "* -export-ignore -export-subst\n");
        await inRepository(["-c", "tar.umask=0022", "archive", "--format=tar", `--output=${archive}`, fetched], 60000);
        const listing = await this.runner(this.tar, ["-t", "-f", archive], { cwd: staging, timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        const archivedFiles = listing.stdout.split(/\r?\n/).filter((name) => name && !name.endsWith("/")).sort();
        const expectedFiles = entries.map((entry) => entry.name).sort();
        if (archivedFiles.length !== expectedFiles.length || archivedFiles.some((name, index) => name !== expectedFiles[index])) {
          throw new SourceError("Состав архива отличается от выбранного commit. Неполная версия не будет использована.");
        }
        const archiveBytes = (await stat(archive)).size;
        if (!archiveBytes || archiveBytes > MAX_SOURCE_BYTES + MAX_FILES * 4096) throw new SourceError("Архив пуст или превышает допустимый размер.");
        return { id, repositoryUrl: config.url, requestedBranch: config.branch, branch: selected.selectedBranch, revision: fetched, fetchedAt: new Date().toISOString(),
          sourcePath: path.join(directory, "source"), archivePath: path.join(directory, "source.tar"), archiveSha256: await sha256(archive), archiveBytes,
          fileCount: entries.length, sourceBytes: entries.reduce((total, entry) => total + entry.bytes, 0), project, warnings } satisfies SourceSnapshot;
      });
      await writeFile(path.join(staging, "source-manifest.json"), JSON.stringify(snapshot, null, 2), { flag: "wx" });
      await rename(staging, directory);
      Object.assign(state, { phase: "ready", step: "ready", snapshot, message: `Код получен: ${snapshot.branch}, версия ${snapshot.revision.slice(0, 12)}. Это исходники, не установленный сайт.` });
      await this.persist(state);
      report({ ...state });
      return { ...state };
    } catch (error) {
      const failure = error as { code?: string };
      const message = error instanceof SourceError ? error.message : failure.code === "ENOSPC" ? "На диске закончилось место. Частичная версия не используется." :
        state.step === "packing" && failure.code === "ENOENT" ? "Не найдена утилита tar для проверки архива. Версия не выдана за готовую." : repositoryFailure(error).message;
      Object.assign(state, { phase: "failed", step: state.step, message });
      await this.persist(state);
      report({ ...state });
      return { ...state };
    } finally {
      try {
        // Only the exact generated staging directory can be removed, never a source checkout selected by the user.
        if (path.dirname(path.resolve(staging)) !== path.resolve(this.cache) || path.basename(staging) !== `.staging-${id}` || !UUID.test(id)) throw new Error("Unsafe source cleanup path");
        await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } finally {
        this.active = null;
      }
    }
  }

  private async inspectProject(source: string): Promise<SourceSnapshot["project"]> {
    const fallback: SourceSnapshot["project"] = { kind: "unknown", packageManager: "unknown", hasBuild: false, hasStart: false, nodeEngine: "" };
    const file = path.join(source, "package.json");
    if (!existsSync(file) || (await stat(file)).size > 512 * 1024) return fallback;
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      return { kind: value.dependencies?.next || value.devDependencies?.next ? "nextjs" : "unknown",
        packageManager: existsSync(path.join(source, "pnpm-lock.yaml")) ? "pnpm" : existsSync(path.join(source, "package-lock.json")) ? "npm" : "unknown",
        hasBuild: typeof value.scripts?.build === "string", hasStart: typeof value.scripts?.start === "string",
        nodeEngine: typeof value.engines?.node === "string" ? value.engines.node.slice(0, 100) : "" };
    } catch { return fallback; }
  }
}
