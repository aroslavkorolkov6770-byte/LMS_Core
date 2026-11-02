import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PointDocument } from "./point-design";

export type ClientDesignReference = { id: string; version: 1 | 2 | 3; clientId: string; sha256: string; source: "saved" | "default" };
type LegacyClientDesign = { format: string; version: 1 | 2; clientId: string; brandName: string; theme: Record<string, string>; typography: Record<string, string | number>; content: Record<string, unknown>; assets?: { path: string; sha256: string; bytes: number; mime: string }[] };
export type PublicClientDesign = LegacyClientDesign | PointDocument;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type Contract = { createClientDesign: (input: unknown) => LegacyClientDesign; validateClientDesign: (input: unknown) => PublicClientDesign; designHash: (input: unknown) => string };

export class ClientDesignService {
  private readonly contract: Contract;
  constructor(private readonly root: string, private readonly client: (id: string) => Promise<unknown>, private readonly settings: (id: string) => Promise<unknown>) {
    this.contract = require(path.join(root, "infra/scripts/client-design-contract.cjs")) as Contract;
  }
  private async load(clientId: string): Promise<{ design: PublicClientDesign; source: ClientDesignReference["source"]; files: { file: string; bytes: Buffer }[] }> {
    if (!UUID.test(clientId)) throw Error("Выберите клиента для снимка оформления.");
    try {
      const detail = await this.client(clientId) as { client?: { id: string; name: string; brandName: string } };
      const saved = await this.settings(clientId) as { clientId?: string; source?: string; settings?: unknown };
      if (detail.client?.id !== clientId || saved.clientId !== clientId || !["saved", "default"].includes(saved.source || "") || !saved.settings) throw Error("CLIENT_MISMATCH");
      const images = require(path.join(this.root, "infra/scripts/client-brand-assets.cjs")) as { resolveImage: (root: string, id: string, url: unknown) => Promise<{ imageUrl: string; assets: unknown[]; files: { file: string; bytes: Buffer }[] }> };
      const resolved = await images.resolveImage(this.root, clientId, (saved.settings as { content?: { homeBackgroundImageUrl?: string } }).content?.homeBackgroundImageUrl);
      const design = this.contract.createClientDesign({ clientId, brandName: detail.client.brandName || detail.client.name, settings: saved.settings, imageUrl: resolved.imageUrl, assets: resolved.assets });
      return { design, source: saved.source as ClientDesignReference["source"], files: resolved.files };
    } catch (error) {
      if ((error as Error)?.message === "BRANDING_IMAGE_UPLOAD_REQUIRED") throw Error("Загрузите фоновое изображение файлом в редакторе и сохраните настройки. Внешние ссылки и пути ноутбука в установку не копируются.");
      throw Error("Не удалось прочитать сохраненное оформление клиента. Проверьте Core API, изображение и допустимые настройки; черновики в пакет не включаются.");
    }
  }
  async currentHash(clientId: string): Promise<string> { return this.contract.designHash((await this.load(clientId)).design); }
  async capture(clientId: string): Promise<ClientDesignReference> {
    const { design, source, files } = await this.load(clientId);
    const reference: ClientDesignReference = { id: randomUUID(), version: design.version, clientId, sha256: this.contract.designHash(design), source };
    const base = path.join(this.root, "infra/runtime/client-designs"), temporary = path.join(base, `.staging-${reference.id}`);
    await mkdir(temporary, { recursive: true });
    if (files.length) {
      await mkdir(path.join(temporary, "assets"));
      for (const file of files) await writeFile(path.join(temporary, "assets", file.file), file.bytes, { flag: "wx", mode: 0o600 });
    }
    await writeFile(path.join(temporary, "design.json"), JSON.stringify(design), { flag: "wx" });
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify(reference), { flag: "wx" });
    await rename(temporary, path.join(base, reference.id));
    return reference;
  }
  async read(reference: ClientDesignReference): Promise<PublicClientDesign> {
    try {
      if (!UUID.test(reference.id) || !UUID.test(reference.clientId) || ![1, 2, 3].includes(reference.version)) throw Error("INVALID_REFERENCE");
      const file = path.join(this.root, "infra/runtime/client-designs", reference.id, "design.json");
      if ((await stat(file)).size > 1024 * 1024) throw Error("DESIGN_TOO_LARGE");
      const design = this.contract.validateClientDesign(JSON.parse(await readFile(file, "utf8")));
      if (design.version !== reference.version || design.clientId !== reference.clientId || this.contract.designHash(design) !== reference.sha256) throw Error("DESIGN_CHANGED");
      for (const asset of ("assets" in design ? design.assets : []) || []) {
        const assetFile = path.join(path.dirname(file), "assets", path.basename(asset.path));
        const info = await lstat(assetFile);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.bytes) throw Error("DESIGN_ASSET_CHANGED");
        const bytes = await readFile(assetFile);
        if (bytes.length !== asset.bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw Error("DESIGN_ASSET_CHANGED");
      }
      return design;
    } catch { throw Error("Снимок оформления изменился или принадлежит другому клиенту. Подготовьте пакет заново."); }
  }
}
