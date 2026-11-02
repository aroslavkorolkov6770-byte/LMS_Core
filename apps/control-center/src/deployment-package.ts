import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SourceSnapshotService } from "./source-snapshots";

const run = promisify(execFile);
export const excludedDeploymentPath = (name: string): boolean => {
  const parts = name.replace(/\/$/, "").split("/");
  return parts.some((part) => [".git", ".next", "node_modules", "id_rsa", "id_ed25519"].includes(part.toLowerCase()) || /^\.env/i.test(part) || /\.(?:pem|key|p12|pfx)$/i.test(part)) ||
    ["data", "uploads", "storage", "infra/runtime"].some((prefix) => name === prefix || name.startsWith(`${prefix}/`)) ||
    name === "public/uploads" || name.startsWith("public/uploads/");
};
export type DeploymentPackage = { id: string; snapshotId: string; revision: string; repositoryUrl: string; branch: string;
  archivePath: string; sha256: string; bytes: number; files: number };

export class DeploymentPackageService {
  constructor(private readonly root: string, private readonly sources: Pick<SourceSnapshotService, "verifySnapshot">,
    private readonly git: string, private readonly tar: string) {}

  async prepare(snapshotId: string): Promise<DeploymentPackage> {
    const snapshot = await this.sources.verifySnapshot(snapshotId);
    if (snapshot.project.kind !== "nextjs" || snapshot.project.packageManager !== "npm" || !snapshot.project.hasBuild || !snapshot.project.hasStart) {
      throw new Error("Автообновление пока поддерживает Next.js с npm, build и start. Для этого проекта нужен отдельный адаптер.");
    }
    const id = randomUUID();
    const base = path.join(this.root, "infra/runtime/deploy-packages");
    const directory = path.join(base, id);
    const temporaryGit = path.join(directory, "objects.git");
    await mkdir(directory, { recursive: true });
    try {
      // Work on a copy so export rules cannot alter the original immutable Git snapshot.
      await cp(path.join(path.dirname(snapshot.archivePath), "objects.git"), temporaryGit, { recursive: true, errorOnExist: true });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
      Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" });
      const options = { cwd: directory, windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024, env };
      const tree = (await run(this.git, ["--git-dir", temporaryGit, "ls-tree", "-r", "--name-only", "-z", snapshot.revision], options)).stdout.split("\0").filter(Boolean);
      const excluded = tree.filter(excludedDeploymentPath);
      const excludedEntries = new Set(excluded);
      for (const name of excluded) {
        const parts = name.split("/");
        for (let size = 1; size < parts.length; size++) {
          const parent = parts.slice(0, size).join("/");
          if (excludedDeploymentPath(parent)) excludedEntries.add(parent);
        }
      }
      await writeFile(path.join(temporaryGit, "info/attributes"), `* -export-ignore -export-subst\n${[...excludedEntries].map((name) => `${JSON.stringify(`/${name}`)} export-ignore`).join("\n")}\n`);
      const archivePath = path.join(directory, "code.tar");
      await run(this.git, ["--git-dir", temporaryGit, "-c", "core.attributesFile=" + (process.platform === "win32" ? "NUL" : "/dev/null"), "-c", "tar.umask=0022", "archive", "--format=tar", `--output=${archivePath}`, snapshot.revision], options);
      const listed = (await run(this.tar, ["-tf", archivePath], options)).stdout.split(/\r?\n/).filter((name) => name && !name.endsWith("/"));
      const expected = tree.filter((name) => !excludedDeploymentPath(name)).sort();
      if (listed.some(excludedDeploymentPath) || JSON.stringify(listed.sort()) !== JSON.stringify(expected) || !listed.includes("package.json") || !listed.includes("package-lock.json")) {
        throw new Error("Пакет не прошёл проверку состава: данные и окружение не должны попадать в код релиза.");
      }
      const bytes = (await stat(archivePath)).size;
      if (!bytes || bytes > 512 * 1024 * 1024) throw new Error("Недопустимый размер пакета обновления.");
      const value: DeploymentPackage = { id, snapshotId, revision: snapshot.revision, repositoryUrl: snapshot.repositoryUrl, branch: snapshot.branch,
        archivePath, bytes, files: listed.length, sha256: createHash("sha256").update(await readFile(archivePath)).digest("hex") };
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify(value, null, 2), { flag: "wx" });
      return value;
    } finally {
      if (path.dirname(path.resolve(directory)) !== path.resolve(base) || path.basename(directory) !== id) throw new Error("Unsafe package cleanup path");
      await rm(temporaryGit, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}
