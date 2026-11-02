import http, { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { NewDeploymentState, NewDeploymentService } from "./new-deployment";
import { Credentials, normalizeRemoteTarget, RemoteSession, RemoteTarget, RemoteTargetService } from "./remote-target";

const hop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
export type ViewerState = { phase: "closed" | "connecting" | "open" | "disconnected"; clientId?: string; url?: string; message: string };

// ssh2 channels are Duplex streams, not net.Socket. Node's HTTP agent also calls
// socket-specific timeout/keepalive methods, so adapt that contract explicitly.
export class SshHttpSocket extends Duplex {
  private idle?: ReturnType<typeof setTimeout>;
  private idleMs = 0;
  readonly connecting = false;
  readonly remoteAddress = "127.0.0.1";
  constructor(private readonly channel: Duplex) {
    super();
    channel.on("data", (chunk) => { this.touch(); if (!this.push(chunk)) channel.pause(); });
    channel.once("end", () => this.push(null));
    channel.once("close", () => this.destroy());
    channel.once("error", () => this.destroy(new Error("SSH_WEB_CHANNEL_CLOSED")));
  }
  private touch() { clearTimeout(this.idle); if (this.idleMs) this.idle = setTimeout(() => this.emit("timeout"), this.idleMs); }
  setTimeout(milliseconds: number, callback?: () => void) { this.idleMs = milliseconds; if (callback) this.once("timeout", callback); this.touch(); return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
  destroySoon() { if (this.writableFinished) this.destroy(); else { this.once("finish", () => this.destroy()); this.end(); } }
  _read() { this.channel.resume(); }
  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) { this.touch(); this.channel.write(chunk, encoding, callback); }
  _final(callback: (error?: Error | null) => void) { this.channel.end(callback); }
  _destroy(error: Error | null, callback: (error?: Error | null) => void) { clearTimeout(this.idle); this.channel.destroy(); callback(error); }
}

export async function createLmsGateway(state: Pick<NewDeploymentState, "clientId" | "releaseId" | "webPort">, open: (port: number) => Promise<Duplex>) {
  const cookieName = "core_lms_session_" + state.clientId.replaceAll("-", "");
  const upstreamOrigin = `http://127.0.0.1:${state.webPort}`;
  let origin = "";
  let closed = false;
  const sockets = new Set<Duplex>();
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = ((_options: unknown, callback: (error: Error | null, socket?: Duplex) => void) => {
    void open(state.webPort).then((channel) => { if (closed) { channel.destroy(); callback(new Error("VIEWER_CLOSED")); return; } const socket = new SshHttpSocket(channel); sockets.add(socket); socket.once("close", () => sockets.delete(socket)); callback(null, socket); }, () => callback(new Error("SSH_WEB_CHANNEL_UNAVAILABLE")));
    return undefined;
  }) as typeof agent.createConnection;
  const deny = (response: ServerResponse, status: number) => { response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end("Доступ к приватному просмотру отклонён."); };
  const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.host !== origin.slice(7) || request.socket.remoteAddress !== "127.0.0.1") { deny(response, 421); return; }
    const unsafe = !["GET", "HEAD"].includes(request.method || "");
    if ((request.headers.origin && request.headers.origin !== origin) || (unsafe && request.headers.origin !== origin) || request.headers["sec-fetch-site"] === "cross-site") { deny(response, 403); return; }
    if (!request.url?.startsWith("/") || request.url.startsWith("//") || request.method === "CONNECT") { deny(response, 400); return; }
    const headers = { ...request.headers };
    for (const name of Object.keys(headers)) if (hop.has(name) || name.startsWith("x-forwarded-") || name === "forwarded") delete headers[name];
    headers.host = `127.0.0.1:${state.webPort}`;
    if (headers.origin) headers.origin = upstreamOrigin;
    if (headers.referer) {
      try { const ref = new URL(headers.referer); if (ref.origin !== origin) { deny(response, 403); return; } headers.referer = upstreamOrigin + ref.pathname + ref.search; }
      catch { deny(response, 403); return; }
    }
    if (headers.cookie) headers.cookie = headers.cookie.split(";").filter((part) => part.trim().startsWith(cookieName + "=")).join(";");
    const proxy = http.request({ hostname: "127.0.0.1", port: state.webPort, method: request.method, path: request.url, headers, agent }, (upstream) => {
      const result = { ...upstream.headers };
      for (const name of Object.keys(result)) if (hop.has(name)) delete result[name];
      if (result.location) {
        try { const location = new URL(result.location, upstreamOrigin); if (location.origin !== upstreamOrigin) { upstream.destroy(); deny(response, 502); return; } result.location = origin + location.pathname + location.search + location.hash; }
        catch { upstream.destroy(); deny(response, 502); return; }
      }
      if (result["set-cookie"]) result["set-cookie"] = result["set-cookie"].filter((cookie) => cookie.startsWith(cookieName + "=")).map((cookie) => cookie.replace(/;\s*Domain=[^;]+/ig, ""));
      result["cache-control"] = "private, no-store";
      // Keep CSP and X-Frame-Options intact. The app uses a native top-level WebContentsView.
      response.writeHead(upstream.statusCode || 502, result); upstream.pipe(response);
      upstream.once("error", () => response.destroy());
    });
    let bytes = 0;
    request.on("data", (chunk) => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) { proxy.destroy(); if (!response.headersSent) deny(response, 413); else response.destroy(); } });
    request.once("aborted", () => proxy.destroy());
    proxy.setTimeout(30000, () => proxy.destroy());
    proxy.once("error", () => { if (!response.headersSent) deny(response, 502); else response.destroy(); });
    request.pipe(proxy);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: origin, close: async () => { closed = true; agent.destroy(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

export class LmsViewerService {
  private current: ViewerState = { phase: "closed", message: "LMS не открыта." };
  private stop?: () => void;
  private task?: Promise<void>;
  private opening = false;
  private generation = 0;
  constructor(private readonly remote: Pick<RemoteTargetService, "withSession">, private readonly deployments: Pick<NewDeploymentService, "get">, private readonly report: (state: ViewerState) => void = () => {}) {}
  get() { return { ...this.current }; }
  private publish(value: ViewerState) { this.current = value; this.report(this.get()); }
  async close() { ++this.generation; this.stop?.(); await this.task; this.stop = undefined; this.task = undefined; this.publish({ phase: "closed", message: "Приватное соединение закрыто." }); }
  async open(clientId: string, input: unknown, auth: Credentials) {
    if (this.opening) { if (auth) { delete auth.password; delete auth.passphrase; } throw Error("Подключение просмотра уже выполняется."); }
    this.opening = true;
    try {
      await this.close();
      const saved = await this.deployments.get(clientId), target = normalizeRemoteTarget(input);
      if (!saved || saved.phase !== "succeeded" || ["host", "port", "username", "fingerprint", "basePath"].some((key) => saved.target[key as keyof RemoteTarget] !== target[key as keyof RemoteTarget])) throw Error("Выберите SSH-цель успешно установленной LMS.");
      this.publish({ phase: "connecting", clientId, message: "Открываю защищённое SSH-соединение..." });
      let ready!: (value: ViewerState) => void, reject!: (error: Error) => void;
      const result = new Promise<ViewerState>((resolve, fail) => { ready = resolve; reject = fail; });
      const generation = this.generation;
      this.task = this.remote.withSession(saved.target, auth, async (session: RemoteSession) => {
        if (!session.openLoopback) throw Error("SSH-просмотр недоступен в этом транспорте.");
        const gateway = await createLmsGateway(saved, session.openLoopback);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; }); this.stop = release;
        const remove = session.onClose?.(() => { this.publish({ phase: "disconnected", clientId, message: "SSH-соединение прервано. Откройте LMS заново." }); release(); });
        try {
          if (generation !== this.generation) throw Error("VIEWER_CANCELLED");
          const health = await fetch(gateway.url + "/api/core-runtime/health", { redirect: "error", signal: AbortSignal.timeout(12000), headers: { Connection: "close" } });
          const data = await health.json();
          if (generation !== this.generation) throw Error("VIEWER_CANCELLED");
          if (!health.ok || data.protocol !== "lms-core-client-v1" || data.clientId !== clientId || data.releaseId !== saved.releaseId || data.storage !== "postgresql-runtime") throw Error("Не подтверждена идентичность LMS. Просмотр не открыт.");
          this.publish({ phase: "open", clientId, url: gateway.url, message: "LMS открыта через SSH; база и внутренний API не публикуются." });
          ready(this.get()); await held;
        } finally { remove?.(); await gateway.close(); }
      }, true).then(() => {}, () => { const error = new Error("SSH-просмотр не открыт: проверьте вход и состояние установленной LMS."); reject(error); if (generation === this.generation) this.publish({ phase: "disconnected", clientId, message: error.message }); });
      return await result;
    } finally { this.opening = false; if (auth) { delete auth.password; delete auth.passphrase; } }
  }
}
