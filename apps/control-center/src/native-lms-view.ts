import { BrowserWindow, WebContentsView } from "electron";
import { randomUUID } from "node:crypto";

export class NativeLmsView {
  private view?: WebContentsView;
  private origin = "";
  private pointSession = "";
  constructor(private readonly window: () => BrowserWindow | null, private readonly editorPreload?: string) {}
  async open(url: string) {
    this.close();
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.pathname !== "/") throw Error("Разрешён только проверенный локальный просмотр LMS.");
    const parent = this.window(); if (!parent) throw Error("Окно Core закрыто.");
    this.origin = parsed.origin;
    this.pointSession = randomUUID();
    const view = new WebContentsView({ webPreferences: { partition: "lms-view-" + randomUUID(), nodeIntegration: false, contextIsolation: true, sandbox: true, ...(this.editorPreload ? { preload: this.editorPreload } : {}) } });
    this.view = view; view.setVisible(false); parent.contentView.addChildView(view);
    view.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try { const target = new URL(details.url); allowed = target.origin === this.origin || target.protocol === "data:" || target.protocol === "blob:" && target.origin === this.origin; } catch {}
      callback({ cancel: !allowed });
    });
    view.webContents.on("will-navigate", (event, target) => { if (new URL(target).origin !== this.origin) event.preventDefault(); });
    view.webContents.setWindowOpenHandler(({ url: target }) => { if (new URL(target).origin === this.origin) void view.webContents.loadURL(target).catch(() => {}); return { action: "deny" }; });
    await view.webContents.loadURL(parsed.origin + "/");
  }
  layout(input: unknown) {
    const view = this.view, parent = this.window(); if (!view || !parent) return;
    const value = input as { visible?: boolean; x?: number; y?: number; width?: number; height?: number };
    if (!value?.visible || ![value.x, value.y, value.width, value.height].every((number) => typeof number === "number" && Number.isFinite(number))) { view.setVisible(false); return; }
    const [width, height] = parent.getContentSize();
    const x = Math.max(0, Math.min(width, Math.round(value.x!))), y = Math.max(30, Math.min(height, Math.round(value.y!)));
    const w = Math.max(0, Math.min(width - x, Math.round(value.width!))), h = Math.max(0, Math.min(height - y, Math.round(value.height!)));
    view.setBounds({ x, y, width: w, height: h }); view.setVisible(w > 20 && h > 20);
  }
  reload() { this.view?.webContents.reload(); }
  owns(event: Electron.IpcMainEvent, session?: string) {
    if (!this.editorPreload || !this.view || event.sender !== this.view.webContents || event.senderFrame !== event.sender.mainFrame || session !== undefined && session !== this.pointSession) return false;
    try { return new URL(event.senderFrame.url).origin === this.origin; } catch { return false; }
  }
  updatePoint(config: unknown) {
    if (this.editorPreload && this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send("core-point:document", { ...(config as object), session: this.pointSession });
  }
  async login(cookie: Electron.CookiesSetDetails) {
    if (!this.view || new URL(cookie.url).origin !== this.origin) throw Error("Просмотр LMS не открыт.");
    await this.view.webContents.session.cookies.set(cookie);
    await this.view.webContents.loadURL(this.origin + "/");
  }
  close() {
    if (!this.view) return;
    const parent = this.window(); if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(this.view);
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close({ waitForBeforeUnload: false }); this.view = undefined; this.origin = "";
  }
}
