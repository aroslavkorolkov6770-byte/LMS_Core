import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SourceSnapshotService } from "./source-snapshots";
import type { ClientDesignReference } from "./client-design";

const run = promisify(execFile);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type InstallationContentMode = "empty" | "source";
export type InstallationCurriculum = { revision: string; sha256: string; topics: number; tests: number; questions: number };
export type InstallationPackage = { id: string; sourceId: string; revision: string; sha256: string; archiveBytes: number;
  contentMode?: InstallationContentMode; curriculum?: InstallationCurriculum;
  design?: { id: string; version: 1 | 2 | 3; clientId: string; sha256: string; supportedTextKeys: string[]; supportedElementIds?: string[]; supportedSettings?: string[]; unsupportedSettings?: string[]; warnings?: { setting: string; code: string; message: string }[]; assetCount?: number } };

export async function verifyInstallerVersions(root: string, files: { path: string; sha256: string }[]): Promise<void> {
  // A cached package must not reach SSH with workers from a different Core update.
  for (const name of ["lms-install-job.cjs", "lms-new-install-worker.cjs", "runtime-process.cjs", "source-curriculum.cjs"]) {
    const expected = files.find(file => file.path === `installer/${name}`);
    const current = createHash("sha256").update(await readFile(path.join(root, "infra/scripts", name))).digest("hex");
    if (!expected || expected.sha256 !== current) throw Error("Установщик Core обновлён. Нажмите только «2. Собрать пакет». Карточку клиента и SSH-пароль менять не нужно; сервер не изменён.");
  }
}
export class InstallationPackageService {
  constructor(private readonly root: string, private readonly sources: Pick<SourceSnapshotService, "verifySnapshot">, private readonly prepareSource?: (snapshotId: string) => Promise<void>) {}
  async verify(value: InstallationPackage, snapshotId: string): Promise<InstallationPackage & { archivePath: string }> {
    if (!value || !UUID.test(value.id) || !UUID.test(value.sourceId)) throw new Error("Некорректный установочный пакет.");
    const contentMode = value.contentMode ?? "empty";
    if (!["empty", "source"].includes(contentMode)) throw Error("Некорректный режим наполнения пакета.");
    const snapshot = await this.sources.verifySnapshot(snapshotId);
    const base = path.join(this.root, "infra/runtime/installation-packages", value.id);
    const manifest = JSON.parse(await readFile(path.join(base, "manifest.json"), "utf8"));
    const source = JSON.parse(await readFile(path.join(this.root, "infra/runtime/runtime-adapted-sources", value.sourceId, "manifest.json"), "utf8"));
    if (manifest.id !== value.id || manifest.sourceId !== value.sourceId || manifest.revision !== snapshot.revision || source.snapshotId !== snapshotId ||
      source.revision !== snapshot.revision || source.adapterVersion !== 3 || source.contentMode !== "empty" || manifest.sha256 !== value.sha256 ||
      manifest.archiveBytes !== value.archiveBytes || value.revision !== snapshot.revision || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Пакет не соответствует выбранной Git-версии.");
    const archivePath = path.join(base, "installation.tar");
    const bytes = await readFile(archivePath);
    if (bytes.length !== value.archiveBytes || createHash("sha256").update(bytes).digest("hex") !== value.sha256) throw new Error("Архив установщика изменился.");
    if (JSON.stringify(manifest.design || null) !== JSON.stringify(value.design || null)) throw Error("Оформление пакета не соответствует плану установки.");
    if ((manifest.contentMode ?? "empty") !== contentMode || JSON.stringify(manifest.curriculum || null) !== JSON.stringify(value.curriculum || null)) throw Error("Наполнение пакета не соответствует плану установки.");
    const release = await (require(path.join(this.root, "infra/scripts/lms-new-install-worker.cjs")) as { verifyPackage: (directory: string, id: string) => Promise<{ contentMode: string; curriculum?: InstallationCurriculum; files: { path: string; sha256: string }[] }> }).verifyPackage(path.join(base, "payload"), value.id);
    await verifyInstallerVersions(this.root, release.files);
    if (release.contentMode !== contentMode || JSON.stringify(release.curriculum || null) !== JSON.stringify(manifest.curriculum || null)) throw Error("Наполнение архива не совпало с его manifest.");
    return { id: value.id, sourceId: value.sourceId, revision: value.revision, sha256: value.sha256, archiveBytes: value.archiveBytes, archivePath, contentMode,
      ...(release.curriculum ? { curriculum: release.curriculum } : {}), ...(manifest.design ? { design: manifest.design } : {}) };
  }
  async prepare(snapshotId: string, design?: ClientDesignReference, contentMode: InstallationContentMode = "empty", automatic = true): Promise<InstallationPackage> {
    if (!["empty", "source"].includes(contentMode)) throw Error("Выберите наполнение LMS: материалы Git или пустая база.");
    const snapshot = await this.sources.verifySnapshot(snapshotId);
    const directory = path.join(this.root, "infra/runtime/runtime-adapted-sources");
    const candidates = await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
    for (const name of candidates) {
      if (!UUID.test(name)) continue;
      try {
        const source = JSON.parse(await readFile(path.join(directory, name, "manifest.json"), "utf8"));
        const receipt = JSON.parse(await readFile(path.join(this.root, "infra/runtime/local-acceptance", name, "acceptance.json"), "utf8"));
        if (source.snapshotId !== snapshotId || source.revision !== snapshot.revision || source.contentMode !== "empty" || source.adapterVersion !== 3 ||
          receipt.sourceId !== name || receipt.revision !== snapshot.revision || receipt.restrictedDatabaseRole !== true) continue;
      } catch { continue; }
      try {
        // Run Node separately: process.execPath inside Electron is not a Node CLI.
        const result = await run("node", [path.join(this.root, "infra/scripts/build-lms-installation.cjs"), name, design?.id || "-", contentMode], { cwd: this.root, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
        const built = JSON.parse(result.stdout);
        const publicValue: InstallationPackage = { id: built.id, sourceId: built.sourceId, revision: built.revision, sha256: built.sha256, archiveBytes: built.archiveBytes,
          contentMode: built.contentMode ?? "empty", ...(built.curriculum ? { curriculum: built.curriculum } : {}), ...(built.design ? { design: built.design } : {}) };
        if (publicValue.contentMode !== contentMode) throw Error("PACKAGE_CONTENT_MODE_MISMATCH");
        if (design && (built.design?.id !== design.id || built.design.clientId !== design.clientId || built.design.sha256 !== design.sha256)) throw Error("DESIGN_PACKAGE_MISMATCH");
        if (!design && built.design) throw Error("UNEXPECTED_PRESENTATION_PACKAGE");
        await this.verify(publicValue, snapshotId);
        return publicValue;
      } catch (error) {
        // Expose only our fixed error code, not subprocess output that may contain local paths or data.
        const failure = error as { stderr?: string; message?: string };
        const code = /Installation package failed: ([A-Z][A-Z0-9_]{2,79})\b/.exec(failure.stderr || "")?.[1] || "PACKAGE_BUILD_FAILED";
        const hint = code.startsWith("SUPPORT_") ? "Изменилась структура контактов поддержки в выбранном Git-коде. Нужен совместимый адаптер этой версии." : "Локальная сборка не прошла проверку. Пакет не отправлен.";
        throw new Error(`${hint} Код: ${code}. Git ${snapshot.revision.slice(0, 12)}. Сервер не изменён.`);
      }
    }
    if (automatic && this.prepareSource) { await this.prepareSource(snapshotId); return this.prepare(snapshotId, design, contentMode, false); }
    throw new Error(`Для выбранного Git ${snapshot.revision.slice(0, 12)} ещё не завершена локальная подготовка LMS: PostgreSQL-адаптер, сборка и проверка запуска. Это не ошибка SSH или пароля. Старый код вместо выбранного не используется; сервер не изменён.`);
  }
}
