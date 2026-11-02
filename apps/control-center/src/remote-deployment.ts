import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DeploymentPackageService } from "./deployment-package";
import { Credentials, normalizeRemoteTarget, RemoteConnectionError, RemoteTarget, RemoteTargetService } from "./remote-target";

const phases: Record<string, string> = {
  preparing: "Готовлю код без клиентских данных и секретов...", connecting: "Подключаюсь к SSH-серверу. Код на сервер ещё не передаётся...", uploading: "Передаю проверенный пакет на сервер...",
  validating: "Проверяю процесс, порт, данные и ресурсы сервера...", building: "Устанавливаю зависимости и собираю отдельный релиз. Текущий сайт продолжает работать...",
  stopping: "Кратко останавливаю только выбранную LMS...", backup: "Создаю и проверяю резервную копию...",
  switching: "Переключаю код, сохраняя данные и прежний путь...", starting: "Запускаю новую версию...", health: "Проверяю HTTP-ответ и процесс новой версии...",
  rolling_back: "Ошибка обновления. Возвращаю предыдущую версию...", rolled_back: "Обновление отменено, предыдущая версия снова отвечает.",
  succeeded: "Новая версия запущена и отвечает. Данные сохранены.", failed: "Обновление не выполнено. Проверьте этап и код ошибки.",
  needs_attention: "Автовосстановление не подтверждено. Требуется проверка сервера.", disconnected: "Связь прервана. Задача на сервере могла продолжиться. Нажмите «Проверить результат» перед новым обновлением."
};
const terminal = new Set(["succeeded", "failed", "rolled_back", "needs_attention"]);
export type DeploymentState = { id: string; target: RemoteTarget; snapshotId: string; revision: string; phase: string; message: string;
  updatedAt: string; failedStep?: string; errorCode?: string; backupPath?: string; backupSha256?: string; previousPath?: string;
  port?: number; processName?: string; swapCreatedBytes?: number };
type WorkerStatus = Omit<Partial<DeploymentState>, "id" | "target" | "snapshotId" | "revision">;

function workerStatus(text: string): WorkerStatus {
  let value: Record<string, unknown>;
  try { value = JSON.parse(text); } catch { throw new Error("Результат серверной задачи не читается."); }
  if (typeof value.phase !== "string" || !Object.hasOwn(phases, value.phase) || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("Неполный результат серверной задачи.");
  }
  const result: WorkerStatus = { phase: value.phase, updatedAt: value.updatedAt, message: phases[value.phase] };
  for (const key of ["errorCode", "failedStep", "backupPath", "backupSha256", "previousPath", "processName"] as const) {
    if (typeof value[key] === "string" && value[key].length <= 512 && !/[\x00-\x1f]/.test(value[key])) result[key] = value[key] as string;
  }
  if (Number.isInteger(value.port) && Number(value.port) > 0 && Number(value.port) < 65536) result.port = Number(value.port);
  if (value.swapCreatedBytes === 4 * 1024 ** 3) result.swapCreatedBytes = value.swapCreatedBytes;
  return result;
}

export class RemoteDeploymentService {
  private active = false;
  private readonly file: string;
  constructor(private readonly root: string, private readonly remote: RemoteTargetService, private readonly packages: DeploymentPackageService) {
    this.file = path.join(root, "infra/runtime/remote-deployment.json");
  }
  async getState(): Promise<DeploymentState | null> {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as DeploymentState;
      normalizeRemoteTarget(saved.target);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(saved.id) || !Object.hasOwn(phases, saved.phase)) return null;
      if (!this.active && !terminal.has(saved.phase)) return { ...saved, phase: "disconnected", message: phases.disconnected };
      return saved;
    } catch { return null; }
  }
  private async save(state: DeploymentState, report: (state: DeploymentState) => void): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { flag: "wx" });
    await rename(temporary, this.file);
    report({ ...state });
  }
  async deploy(input: unknown, auth: Credentials, snapshotId: string, allowSwap: boolean, report: (state: DeploymentState) => void): Promise<DeploymentState> {
    if (this.active) throw new Error("Обновление уже выполняется.");
    const previous = await this.getState();
    if (this.active) throw new Error("Обновление уже выполняется.");
    if (previous && (!["succeeded", "failed", "rolled_back"].includes(previous.phase))) throw new Error("Сначала проверьте результат предыдущей серверной задачи. Повторная установка заблокирована.");
    const target = normalizeRemoteTarget(input);
    if (!target.appPath || !target.fingerprint) throw new Error("Нужны каталог существующей LMS и подтверждённый SSH-отпечаток.");
    this.active = true;
    const state: DeploymentState = { id: randomUUID(), target, snapshotId, revision: "", phase: "preparing", message: phases.preparing, updatedAt: new Date().toISOString() };
    let started = false;
    const progress = async (extra: WorkerStatus) => {
      Object.assign(state, extra);
      await this.save(state, report);
    };
    try {
      await this.save(state, report);
      const pkg = await this.packages.prepare(snapshotId);
      state.revision = pkg.revision;
      await progress({ phase: "connecting", message: phases.connecting, updatedAt: new Date().toISOString() });
      return await this.remote.withSession(target, auth, async (session) => {
        await progress({ phase: "uploading", message: phases.uploading, updatedAt: new Date().toISOString() });
        const jobDir = `/var/lib/lms-core/jobs/${state.id}`;
        const worker = await readFile(path.join(this.root, "infra/scripts/lms-update-worker.cjs"));
        const config = Buffer.from(JSON.stringify({ id: state.id, appPath: target.appPath, basePath: target.basePath, revision: pkg.revision, sha256: pkg.sha256, allowSwap: allowSwap === true }));
        const setup = `const fs=require('node:fs'); process.umask(0o077); if(process.platform!=='linux'||process.getuid()!==0)process.exit(1);
let p=''; for(const part of '${jobDir}'.split('/').filter(Boolean)){p+='/'+part;if(!fs.existsSync(p))fs.mkdirSync(p,{mode:0o700});const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))process.exit(1);} fs.chmodSync('${jobDir}',0o700);
fs.writeFileSync('${jobDir}/worker.cjs',Buffer.from('${worker.toString("base64")}','base64'),{flag:'wx',mode:0o600});
fs.writeFileSync('${jobDir}/config.json',Buffer.from('${config.toString("base64")}','base64'),{flag:'wx',mode:0o600});
fs.writeFileSync('${jobDir}/status.json',JSON.stringify({phase:'validating',updatedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});`;
        await session.execute("node -", setup);
        const code = await readFile(pkg.archivePath);
        if (createHash("sha256").update(code).digest("hex") !== pkg.sha256) throw new Error("Пакет кода изменился перед передачей.");
        await session.execute(`umask 077; cat > '${jobDir}/code.tar'`, code, 120000);
        // nohup detaches the bounded worker: closing the laptop window cannot interrupt cutover.
        started = true;
        await session.execute(`nohup node '${jobDir}/worker.cjs' '${jobDir}/config.json' > '${jobDir}/worker.private.log' 2>&1 < /dev/null &\nprintf '%s' "$!" > '${jobDir}/worker.pid'`, "");
        for (let attempt = 0; attempt < 1440; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 4000));
          const status = workerStatus(await session.execute(`cat '${jobDir}/status.json'`, "", 15000));
          await progress(status);
          if (terminal.has(status.phase!)) return { ...state };
        }
        throw new Error("Время наблюдения истекло. Проверьте результат задачи повторным подключением.");
      });
    } catch (error) {
      const message = started ? phases.disconnected : error instanceof Error ? error.message : phases.failed;
      await progress({ phase: started ? "disconnected" : "failed", message, failedStep: state.phase,
        errorCode: error instanceof RemoteConnectionError ? error.code : started ? "SSH_OBSERVATION_INTERRUPTED" : "PREPARATION_FAILED", updatedAt: new Date().toISOString() });
      return { ...state };
    } finally { this.active = false; delete auth?.password; delete auth?.passphrase; }
  }
  async refresh(input: unknown, auth: Credentials, report: (state: DeploymentState) => void): Promise<DeploymentState> {
    if (this.active) throw new Error("Наблюдение за обновлением уже выполняется.");
    const state = await this.getState();
    if (this.active) throw new Error("Наблюдение за обновлением уже выполняется.");
    if (!state) throw new Error("Сохранённая серверная задача не найдена.");
    const target = normalizeRemoteTarget(input);
    if (["host", "port", "username", "fingerprint", "appPath", "basePath"].some((key) => target[key as keyof RemoteTarget] !== state.target[key as keyof RemoteTarget])) {
      throw new Error("Параметры не совпали с сервером сохранённой задачи. Проверка другого сервера запрещена.");
    }
    this.active = true;
    try {
      const directory = `/var/lib/lms-core/jobs/${state.id}`;
      const script = `const fs=require('node:fs');const dir='${directory}';let s=JSON.parse(fs.readFileSync(dir+'/status.json','utf8'));
if(!['succeeded','failed','rolled_back','needs_attention'].includes(s.phase)){let alive=false;try{const pid=Number(fs.readFileSync(dir+'/worker.pid','utf8'));alive=pid>1&&fs.readFileSync('/proc/'+pid+'/cmdline','utf8').includes(dir+'/worker.cjs');}catch{}if(!alive)s={...s,phase:'needs_attention',errorCode:'WORKER_NOT_RUNNING',updatedAt:new Date().toISOString()};}process.stdout.write(JSON.stringify(s));`;
      const result = await this.remote.withSession(target, auth, (session) => session.execute("node -", script));
      Object.assign(state, workerStatus(result));
      await this.save(state, report);
      return state;
    } finally { this.active = false; }
  }
}
