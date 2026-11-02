import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClientDesignReference } from "./client-design";

export type PointPatch = { text?: string; styles?: Partial<Record<"all" | "light" | "dark", Record<string, string | number>>> };
export type PointDocument = { format: "lms-client-point-design-v3"; version: 3; clientId: string; sourceRevision: string; elements: Record<string, PointPatch> };
export type PointSaved = { clientId: string; sourceRevision: string; revision: number; document: PointDocument };
export type PointCatalogEntry = { id: string; label: string; route: string; selector: string; text: string | null; properties: string[] };
export type PointState = { clientId?: string; sourceRevision?: string; revision: number; document?: PointDocument; dirty: boolean; busy: boolean; enabled: boolean; selectedId: string; selectedTheme: "light" | "dark"; computed?: Record<string, string | number>; error: string; catalog: PointCatalogEntry[]; fonts: Record<string, string> };
export type PointDesignProvider = Pick<PointDesignService, "captureOptional" | "currentHash" | "hasChanges">;

export class PointDesignService {
  readonly contract: { CATALOG: PointCatalogEntry[]; FONTS: Record<string, string>; validatePointDesign(value: unknown): PointDocument };
  private readonly hash: (value: unknown) => string;
  constructor(private readonly root: string, private readonly request: (clientId: string, revision: string, payload?: unknown) => Promise<unknown>) {
    this.contract = require(path.join(root, "infra/scripts/point-design-contract.cjs"));
    this.hash = require(path.join(root, "infra/scripts/client-design-contract.cjs")).designHash;
  }
  async load(clientId: string, sourceRevision: string): Promise<PointSaved> {
    const value = await this.request(clientId, sourceRevision) as PointSaved;
    const document = this.contract.validatePointDesign(value.document);
    if (document.clientId !== clientId || document.sourceRevision !== sourceRevision || value.clientId !== clientId || value.sourceRevision !== sourceRevision || !Number.isSafeInteger(value.revision) || value.revision < 0) throw Error("Оформление принадлежит другому клиенту или версии кода.");
    return { clientId, sourceRevision, revision: value.revision, document };
  }
  async save(value: PointSaved): Promise<PointSaved> {
    const document = this.contract.validatePointDesign(value.document);
    const saved = await this.request(value.clientId, value.sourceRevision, { expectedRevision: value.revision, document }) as PointSaved;
    const normalized = this.contract.validatePointDesign(saved.document);
    if (saved.clientId !== value.clientId || saved.sourceRevision !== value.sourceRevision || saved.revision !== value.revision + 1 || JSON.stringify(normalized) !== JSON.stringify(document)) throw Error("Сервер не подтвердил запись именно этого черновика. Перечитайте сохраненную версию.");
    return { ...saved, document: normalized };
  }
  async currentHash(clientId: string, revision: string): Promise<string> { return this.hash((await this.load(clientId, revision)).document); }
  async hasChanges(clientId: string, revision: string): Promise<boolean> { return Object.keys((await this.load(clientId, revision)).document.elements).length > 0; }
  async captureOptional(clientId: string, revision: string): Promise<ClientDesignReference | undefined> {
    const { document } = await this.load(clientId, revision);
    if (!Object.keys(document.elements).length) return undefined;
    const reference: ClientDesignReference = { id: randomUUID(), version: 3, clientId, sha256: this.hash(document), source: "saved" };
    const base = path.join(this.root, "infra/runtime/client-designs"), temporary = path.join(base, `.staging-${reference.id}`);
    await mkdir(temporary, { recursive: true });
    await writeFile(path.join(temporary, "design.json"), JSON.stringify(document), { flag: "wx" });
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify(reference), { flag: "wx" });
    await rename(temporary, path.join(base, reference.id));
    return reference;
  }
}

export class PointEditor {
  private state: PointState;
  private saved?: PointDocument;
  private operation = 0;
  constructor(private readonly service: PointDesignService, private readonly report: (state: PointState) => void = () => {}) {
    this.state = { revision: 0, dirty: false, busy: false, enabled: false, selectedId: "", selectedTheme: "light", error: "", catalog: service.contract.CATALOG, fonts: service.contract.FONTS };
  }
  get(): PointState { return structuredClone(this.state); }
  private publish() { this.report(this.get()); return this.get(); }
  async bind(clientId: string, sourceRevision: string) {
    if (this.state.dirty && (this.state.clientId !== clientId || this.state.sourceRevision !== sourceRevision)) throw Error("Сначала сохраните или отмените правки текущего клиента.");
    if (this.state.clientId === clientId && this.state.sourceRevision === sourceRevision && this.state.document) return this.get();
    const operation = ++this.operation;
    this.state = { ...this.state, clientId, sourceRevision, document: undefined, busy: true, error: "", selectedId: "", enabled: false };
    this.publish();
    try {
      const value = await this.service.load(clientId, sourceRevision);
      if (operation !== this.operation) return this.get();
      this.saved = value.document; this.state.document = structuredClone(value.document); this.state.revision = value.revision; this.state.dirty = false;
    } catch (error) { if (operation === this.operation) this.state.error = error instanceof Error ? error.message : "Не удалось загрузить оформление."; throw error; }
    finally { if (operation === this.operation) { this.state.busy = false; this.publish(); } }
    return this.get();
  }
  enable(enabled: unknown) { if (!this.state.document || this.state.busy) throw Error("Дождитесь загрузки редактора."); this.state.enabled = enabled === true; return this.publish(); }
  select(selection: unknown) {
    if (!this.state.enabled || !this.state.document || !selection || typeof selection !== "object") return;
    const value = selection as { id?: string; theme?: string; computed?: Record<string, unknown>; unavailable?: boolean; exitSelection?: boolean };
    if (value.exitSelection) { this.state.enabled = false; this.publish(); return; }
    if (value.unavailable) { this.state.selectedId = ""; this.state.computed = undefined; this.state.error = "Этот элемент пока не входит в безопасный список редактирования."; this.publish(); return; }
    if (!this.state.catalog.some((item) => item.id === value.id)) return;
    this.state.selectedId = value.id!; this.state.selectedTheme = value.theme === "dark" ? "dark" : "light"; this.state.error = "";
    this.state.computed = Object.fromEntries(Object.entries(value.computed || {}).filter(([key, item]) => ["color", "backgroundColor", "borderColor", "fontFamily", "fontSizePx", "fontWeight"].includes(key) && (typeof item === "string" && item.length < 240 || typeof item === "number" && Number.isFinite(item)))) as Record<string, string | number>;
    this.publish();
  }
  change(id: unknown, patch: unknown) {
    if (!this.state.document || this.state.busy || !this.state.catalog.some((item) => item.id === id)) throw Error("Сначала выберите допустимый элемент в LMS.");
    const next = structuredClone(this.state.document);
    if (patch === null) delete next.elements[String(id)];
    else next.elements[String(id)] = patch as PointPatch;
    this.state.document = this.service.contract.validatePointDesign(next);
    this.state.dirty = JSON.stringify(this.saved) !== JSON.stringify(this.state.document); this.state.error = "";
    return this.publish();
  }
  discard() { if (this.state.busy) throw Error("Дождитесь сохранения."); if (this.saved) this.state.document = structuredClone(this.saved); this.state.dirty = false; this.state.error = ""; return this.publish(); }
  async reload() {
    if (!this.state.clientId || !this.state.sourceRevision || this.state.busy) throw Error("Дождитесь завершения операции.");
    this.state.busy = true; this.publish();
    try {
      const saved = await this.service.load(this.state.clientId, this.state.sourceRevision);
      this.saved = saved.document; this.state.document = structuredClone(saved.document); this.state.revision = saved.revision; this.state.dirty = false; this.state.error = "";
    } catch (error) { this.state.error = "Не удалось перечитать сохраненную версию. Текущий черновик оставлен в окне."; throw error; }
    finally { this.state.busy = false; this.publish(); }
    return this.get();
  }
  async save() {
    if (!this.state.document || !this.state.clientId || !this.state.sourceRevision || this.state.busy) throw Error("Редактор пока не готов к сохранению.");
    this.state.busy = true; this.state.error = ""; this.publish();
    try {
      const value = await this.service.save({ clientId: this.state.clientId, sourceRevision: this.state.sourceRevision, revision: this.state.revision, document: this.state.document });
      this.saved = value.document; this.state.document = structuredClone(value.document); this.state.revision = value.revision; this.state.dirty = false;
    } catch (error) { this.state.error = error instanceof Error ? error.message : "Сохранение не завершено. Черновик сохранен в окне."; throw error; }
    finally { this.state.busy = false; this.publish(); }
    return this.get();
  }
}
