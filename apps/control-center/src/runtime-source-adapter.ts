import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DeploymentPackageService } from "./deployment-package";
import { adaptRuntimeAuth, emptyPilotTrainingDefaults } from "./runtime-auth-adapter";

const run = promisify(execFile);
export type RuntimeSourceArtifact = { id: string; snapshotId: string; revision: string; sourcePath: string; manifestPath: string;
  protocol: "lms-core-runtime-v1"; database: "postgresql-via-nest-api"; modifiedFiles: Array<{ path: string; beforeSha256: string; afterSha256: string }>;
  createdFiles: Array<{ path: string; sha256: string }>; adapterVersion: 3; contentMode: "empty";
  requiredEnvironment: string[]; containsBackend: false; deployed: false };

export class RuntimeSourceAdapterService {
  constructor(private readonly root: string, private readonly packages: Pick<DeploymentPackageService, "prepare">, private readonly tar: string) {}
  async prepare(snapshotId: string): Promise<RuntimeSourceArtifact> {
    const pkg = await this.packages.prepare(snapshotId);
    const id = randomUUID();
    const base = path.join(this.root, "infra/runtime/runtime-adapted-sources");
    const temporary = path.join(base, `.staging-${id}`);
    const final = path.join(base, id);
    await mkdir(temporary, { recursive: true });
    try {
      const source = path.join(temporary, "source");
      await mkdir(source);
      await run(this.tar, ["-xf", pkg.archivePath, "-C", source], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
      const dataStore = await readFile(path.join(source, "app/lib/storage/dataStore.ts"), "utf8");
      const auth = await readFile(path.join(source, "app/lib/serverAuth.ts"), "utf8");
      if (!["readDataValue", "readDataValues", "writeDataValue"].every((name) => dataStore.includes(`export const ${name}`)) ||
          !auth.includes("scrypt2") || !auth.includes("process.env.BOOTSTRAP_ADMIN_LOGIN") || !auth.includes("process.env.BOOTSTRAP_ADMIN_PASSWORD")) {
        throw new Error("У Git-источника другой контракт storage/auth. Автоматическая адаптация остановлена без изменения исходников.");
      }
      const permitted = new Set(["app/lib/storage/dataStore.ts", "app/lib/storage/jsonFileStore.ts", "app/lib/serverAuth.ts"]);
      const inspect = async (directory: string): Promise<void> => {
        for (const file of await readdir(directory, { withFileTypes: true })) {
          const absolute = path.join(directory, file.name);
          if (file.isSymbolicLink()) throw new Error("Ссылки не поддерживаются в исходниках новой установки.");
          if (file.isDirectory()) await inspect(absolute);
          else if (/\.[cm]?[jt]sx?$/.test(file.name)) {
            const relative = path.relative(source, absolute).split(path.sep).join("/");
            if (!permitted.has(relative) && /\b(?:readJsonFile|writeJsonFile)\b|(?:from\s*|require\s*\()\s*['"][^'"]*jsonFileStore/.test(await readFile(absolute, "utf8"))) {
              throw new Error("В Git-LMS найден обход общего storage через локальный JSON. Нужен отдельный адаптер этого источника.");
            }
          }
        }
      };
      await inspect(path.join(source, "app"));
      const patches = [
        ["app/lib/storage/dataStore.ts", "core-runtime-data-store.ts"],
        ["app/lib/storage/jsonFileStore.ts", "disabled-json-store.ts"]
      ];
      const modifiedFiles: RuntimeSourceArtifact["modifiedFiles"] = [];
      const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
      for (const [relative, template] of patches) {
        const file = path.join(source, relative);
        const before = await readFile(file);
        const after = await readFile(path.join(this.root, "infra/lms-adapter", template));
        await writeFile(file, after);
        modifiedFiles.push({ path: relative, beforeSha256: sha(before), afterSha256: sha(after) });
      }
      const authPath = path.join(source, "app/lib/serverAuth.ts");
      const adaptedAuth = Buffer.from(adaptRuntimeAuth(auth));
      await writeFile(authPath, adaptedAuth);
      modifiedFiles.push({ path: "app/lib/serverAuth.ts", beforeSha256: sha(Buffer.from(auth)), afterSha256: sha(adaptedAuth) });
      const trainingPath = "app/tasks/data/defaultTrainingTests.ts";
      const originalTraining = await readFile(path.join(source, trainingPath));
      const emptyTraining = Buffer.from(emptyPilotTrainingDefaults(originalTraining.toString("utf8")));
      await writeFile(path.join(source, trainingPath), emptyTraining);
      modifiedFiles.push({ path: trainingPath, beforeSha256: sha(originalTraining), afterSha256: sha(emptyTraining) });
      const healthPath = "app/api/core-runtime/health/route.ts";
      const health = await readFile(path.join(this.root, "infra/lms-adapter/runtime-health-route.ts"));
      await mkdir(path.dirname(path.join(source, healthPath)), { recursive: true });
      await writeFile(path.join(source, healthPath), health, { flag: "wx" });
      const artifact: RuntimeSourceArtifact = { id, snapshotId, revision: pkg.revision, sourcePath: path.join(final, "source"), manifestPath: path.join(final, "manifest.json"),
        protocol: "lms-core-runtime-v1", database: "postgresql-via-nest-api", modifiedFiles, adapterVersion: 3, contentMode: "empty", createdFiles: [{ path: healthPath, sha256: sha(health) }],
        requiredEnvironment: ["CORE_RUNTIME_API_URL", "CORE_RUNTIME_SERVICE_TOKEN", "CORE_RUNTIME_CLIENT_ID", "CORE_RUNTIME_RELEASE_ID", "AUTH_SECRET"], containsBackend: false, deployed: false };
      await writeFile(path.join(temporary, "manifest.json"), JSON.stringify(artifact, null, 2), { flag: "wx" });
      await rename(temporary, final);
      return artifact;
    } finally {
      if (path.dirname(path.resolve(temporary)) !== path.resolve(base) || path.basename(temporary) !== `.staging-${id}`) throw new Error("Unsafe adapter staging cleanup");
      await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
}
