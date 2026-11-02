import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Credentials, normalizeRemoteTarget, RemoteTarget, RemoteTargetService } from "./remote-target";
import { NewDeploymentService, NewDeploymentState } from "./new-deployment";
import { InstallationPackageService } from "./installation-package";
import { DeploymentState } from "./remote-deployment";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const terminal = new Set(["succeeded", "failed", "rolled_back", "needs_attention"]);
const labels: Record<string, string> = { preparing: "Готовлю выбранный Git-код с адаптером установленной LMS. Сервер пока не изменяется...", connecting: "Подключаюсь к серверу клиента...", uploading: "Передаю проверенный пакет без клиентских данных...", validating: "Проверяю владельца установки, systemd и совместимость БД...", building: "Собираю новую LMS отдельно; прежний сайт работает...", stopping: "Кратко останавливаю только веб-службу клиента...", backup: "Сохраняю окружение и файлы клиента...", switching: "Сохраняю прежнюю LMS и переключаю веб-код...", starting: "Запускаю обновлённую LMS...", health: "Проверяю обновлённую LMS и доступность её БД...", rolling_back: "Возвращаю прежнюю LMS...", rolled_back: "Прежняя LMS восстановлена. Данные и настройки сохранены.", succeeded: "LMS обновлена из выбранного Git-кода и отвечает. БД, доступы и настройки сохранены.", failed: "Обновление не выполнено; прежняя LMS не заменена.", disconnected: "Связь прервана. Проверьте результат: серверная задача могла продолжиться.", needs_attention: "Не удалось подтвердить восстановление. Не запускайте повтор, проверьте результат." };
const hints: Record<string, string> = { UPDATE_DESIGN_REBASE_REQUIRED: "У клиента есть сохранённое оформление другой Git-версии. Сначала нужна совместимая версия оформления; Core не стирает его автоматически.", UPDATE_BACKEND_MIGRATION_REQUIRED: "Новая версия требует отдельного обновления backend/схемы. БД не менялась.", UPDATE_DISK_LOW: "Для отдельной сборки и резервной копии нужно не менее3ГиБ свободного диска.", UPDATE_MEMORY_LOW: "Для сборки нужно не менее3ГиБ RAM+swap. Используйте подготовку памяти в Core.", MANAGED_CONFIGURATION_BUSY: "На сервере уже выполняется настройка ИИ/почты или обновление. Дождитесь её завершения.", LMS_BUILD_FAILED: "Новый Git-код не собрался на сервере. Прежняя LMS не остановлена.", DEPENDENCY_INSTALL_FAILED: "Не удалось установить зависимости выбранной версии. Прежняя LMS не остановлена." };
export type ManagedUpdateState = DeploymentState & { clientId: string; releaseId: string; installationJobId: string; managed: true };

// A missing UI path may be recovered only from this client's verified installation.
export function resolveManagedUpdateTarget(input: unknown, installed: NewDeploymentState, clientId: string): RemoteTarget {
  if (!installed || installed.clientId !== clientId || installed.phase !== "succeeded") throw Error("Выберите успешно установленного клиента Core.");
  const target = normalizeRemoteTarget(input), expected = installed.target;
  if (!expected.appPath || !expected.fingerprint || ["host", "port", "username", "basePath", "fingerprint"].some(key => target[key as keyof RemoteTarget] !== expected[key as keyof RemoteTarget]) || target.appPath && target.appPath !== expected.appPath) throw Error("SSH-цель не совпадает с установленной LMS выбранного клиента. Загрузите сохранённый сервер клиента; чужой путь не подставляется.");
  return { ...target, appPath: expected.appPath };
}

export class ManagedUpdateService {
  private busy = false;
  constructor(private readonly root: string, private readonly remote: Pick<RemoteTargetService, "withSession">,
    private readonly installations: Pick<NewDeploymentService, "get">, private readonly packages: Pick<InstallationPackageService, "prepare" | "verify">,
    private readonly allowed: (target: RemoteTarget) => Promise<boolean>, private readonly pause = () => new Promise(resolve => setTimeout(resolve, 3000))) {}
  private file(clientId: string): string { if (!UUID.test(clientId)) throw Error("Выберите клиента."); return path.join(this.root, "infra/runtime/managed-updates", `${clientId}.json`); }
  async get(clientId: string): Promise<ManagedUpdateState | null> {
    try {
      const state = JSON.parse(await readFile(this.file(clientId), "utf8")) as ManagedUpdateState;
      if (state.clientId !== clientId || state.managed !== true || !UUID.test(state.id) || !UUID.test(state.snapshotId) || !UUID.test(state.releaseId) || !UUID.test(state.installationJobId) || !labels[state.phase]) throw Error("UPDATE_STATE_INVALID");
      state.target = normalizeRemoteTarget(state.target);
      if (!this.busy && !terminal.has(state.phase)) { state.phase = "disconnected"; state.message = labels.disconnected; }
      return state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw Error("Не удалось прочитать состояние обновления выбранного клиента."); }
  }
  private async save(state: ManagedUpdateState, report: (state: ManagedUpdateState) => void): Promise<void> {
    const file = this.file(state.clientId); await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`; await writeFile(temporary, JSON.stringify(state), { flag: "wx", mode: 0o600 }); await rename(temporary, file); report({ ...state });
  }
  private accept(text: string, state: ManagedUpdateState): void {
    const value = JSON.parse(text);
    if (value.id !== state.id || value.clientId !== state.clientId || !labels[value.phase] || !Number.isFinite(Date.parse(value.updatedAt))) throw Error("MANAGED_UPDATE_STATUS_MISMATCH");
    state.phase = value.phase; state.message = hints[value.errorCode] || labels[value.phase]; state.updatedAt = value.updatedAt;
    delete state.errorCode; delete state.failedStep;
    for (const key of ["errorCode", "failedStep"] as const) if (typeof value[key] === "string" && /^[A-Za-z_]{1,80}$/.test(value[key])) state[key] = value[key];
    if (typeof value.backupPath === "string") {
      if (value.backupPath !== `${state.target.appPath}/releases/${state.releaseId}/.web-backup-${state.id}`) throw Error("UPDATE_BACKUP_INVALID");
      state.backupPath = value.backupPath;
    }
  }
  async inspect(clientId: string, input: unknown, auth: Credentials): Promise<{ kind: "managed"; clientId: string; appRoot: string; webPort: number; checkedAt: string }> {
    try {
      const installed = await this.installations.get(clientId), target = resolveManagedUpdateTarget(input, installed!, clientId);
      if (!await this.allowed(target)) throw Error("Внешняя проверка запрещена локальным режимом.");
      const worker = await readFile(path.join(this.root, "infra/scripts/configure-lms-ai.cjs"), "utf8");
      const payload = { clientId, jobId: installed!.id, releaseId: installed!.releaseId, appPath: target.appPath, webPort: installed!.webPort };
      const script = worker + `\nenvironment(${JSON.stringify(payload)},{profile:{keys:[],capability:{file:'app/api/core-runtime/health/route.ts',required:['lms-core-client-v1','postgresql-runtime']}}}).then(async e=>{await e.health();process.stdout.write(JSON.stringify({ok:true}));}).catch(()=>process.stdout.write(JSON.stringify({ok:false})));`;
      const result = JSON.parse(await this.remote.withSession(target, auth, session => session.execute("node -", script, 45000)));
      if (result.ok !== true) throw Error("Сервер не подтвердил владельца установленной LMS или её работоспособность. Обновление не запускалось.");
      return { kind: "managed", clientId, appRoot: target.appPath!, webPort: installed!.webPort, checkedAt: new Date().toISOString() };
    } finally { delete auth?.password; delete auth?.passphrase; }
  }
  async deploy(clientId: string, input: unknown, auth: Credentials, snapshotId: string, report: (state: ManagedUpdateState) => void): Promise<ManagedUpdateState> {
    if (this.busy) throw Error("Обновление уже выполняется."); this.busy = true;
    let state: ManagedUpdateState | undefined, started = false;
    try {
      const installed = await this.installations.get(clientId);
      const target = resolveManagedUpdateTarget(input, installed!, clientId);
      if (!await this.allowed(target)) throw Error("Внешние изменения заблокированы локальным режимом.");
      const previous = await this.get(clientId);
      if (previous && !["succeeded", "failed", "rolled_back"].includes(previous.phase)) throw Error("Сначала проверьте результат предыдущего обновления этого клиента.");
      state = { id: randomUUID(), clientId, releaseId: installed!.releaseId, installationJobId: installed!.id, managed: true, target, snapshotId, revision: "", phase: "preparing", message: labels.preparing, updatedAt: new Date().toISOString() };
      const progress = async (phase: string) => { state!.phase = phase; state!.message = labels[phase]; state!.updatedAt = new Date().toISOString(); await this.save(state!, report); };
      await this.save(state, report);
      const prepared = await this.packages.prepare(snapshotId), pkg = await this.packages.verify(prepared, snapshotId);
      state.revision = pkg.revision; await progress("connecting");
      return await this.remote.withSession(target, auth, async session => {
        const directory = `/var/lib/lms-core/jobs/${state!.id}`;
        const names = ["lms-managed-update.cjs", "configure-lms-ai.cjs", "lms-new-install-worker.cjs", "lms-update-worker.cjs", "lms-install-job.cjs", "runtime-process.cjs", "client-design-contract.cjs", "point-design-contract.cjs"];
        const files = await Promise.all(names.map(async name => ({ name, data: (await readFile(path.join(this.root, "infra/scripts", name))).toString("base64") })));
        const config = { id: state!.id, clientId, jobId: installed!.id, releaseId: installed!.releaseId, appPath: target.appPath, webPort: installed!.webPort, revision: pkg.revision, packageId: pkg.id, sha256: pkg.sha256 };
        const setup = `const fs=require('node:fs');process.umask(0o077);if(process.platform!=='linux'||process.getuid()!==0)throw Error('ROOT_REQUIRED');let p='';for(const part of '${directory}'.split('/').filter(Boolean)){p+='/'+part;if(!fs.existsSync(p))fs.mkdirSync(p,{mode:0o700});const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))throw Error('UNSAFE_JOB');}for(const f of ${JSON.stringify(files)})fs.writeFileSync('${directory}/'+f.name,Buffer.from(f.data,'base64'),{flag:'wx',mode:0o600});fs.writeFileSync('${directory}/config.json',JSON.stringify(${JSON.stringify(config)}),{flag:'wx',mode:0o600});fs.writeFileSync('${directory}/status.json',JSON.stringify({id:'${state!.id}',clientId:'${clientId}',phase:'validating',updatedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});`;
        await progress("uploading"); await session.execute("node -", setup);
        const bytes = await readFile(pkg.archivePath); if (createHash("sha256").update(bytes).digest("hex") !== pkg.sha256) throw Error("UPDATE_ARCHIVE_CHANGED");
        await session.execute(`umask 077; cat > '${directory}/code.tar'`, bytes, 120000);
        started = true;
        await session.execute(`nohup node '${directory}/lms-managed-update.cjs' '${directory}/config.json' > '${directory}/worker.private.log' 2>&1 < /dev/null &\nprintf '%s' "$!" > '${directory}/worker.pid'`, "");
        for (let attempt = 0; attempt < 1600; attempt++) {
          await this.pause(); this.accept(await session.execute(`cat '${directory}/status.json'`, "", 15000), state!); await this.save(state!, report);
          if (terminal.has(state!.phase)) return { ...state! };
        }
        throw Error("UPDATE_OBSERVATION_TIMEOUT");
      });
    } catch (error) {
      if (!state) throw error;
      state.phase = started ? "disconnected" : "failed"; state.message = started ? labels.disconnected : error instanceof Error ? error.message : labels.failed;
      state.errorCode = started ? "SSH_OBSERVATION_INTERRUPTED" : "MANAGED_PREPARATION_FAILED"; state.updatedAt = new Date().toISOString(); await this.save(state, report); return state;
    } finally { this.busy = false; delete auth?.password; delete auth?.passphrase; }
  }
  async refresh(clientId: string, input: unknown, auth: Credentials, report: (state: ManagedUpdateState) => void): Promise<ManagedUpdateState> {
    if (this.busy) throw Error("Дождитесь текущей команды."); this.busy = true;
    try {
      const state = await this.get(clientId); if (!state) throw Error("У клиента ещё нет задания обновления.");
      const installed = await this.installations.get(clientId), target = resolveManagedUpdateTarget(input, installed!, clientId);
      if (!await this.allowed(target) || installed!.id !== state.installationJobId || installed!.releaseId !== state.releaseId || ["host", "port", "username", "basePath", "appPath", "fingerprint"].some(key => target[key as keyof RemoteTarget] !== state.target[key as keyof RemoteTarget])) throw Error("Цель обновления изменилась.");
      if (state.phase === "failed" && state.errorCode === "MANAGED_PREPARATION_FAILED") return state;
      const directory = `/var/lib/lms-core/jobs/${state.id}`;
      const script = `const fs=require('node:fs'),d='${directory}';let s=JSON.parse(fs.readFileSync(d+'/status.json','utf8'));if(!['succeeded','failed','rolled_back','needs_attention'].includes(s.phase)){let alive=false;try{const p=Number(fs.readFileSync(d+'/worker.pid','utf8'));alive=p>1&&fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes(d+'/lms-managed-update.cjs');}catch{}if(!alive)s={...s,phase:'needs_attention',errorCode:'WORKER_NOT_RUNNING',updatedAt:new Date().toISOString()};}process.stdout.write(JSON.stringify(s));`;
      this.accept(await this.remote.withSession(target, auth, session => session.execute("node -", script)), state); await this.save(state, report); return state;
    } finally { this.busy = false; delete auth?.password; delete auth?.passphrase; }
  }
}
