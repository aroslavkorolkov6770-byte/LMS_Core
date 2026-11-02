import { ArgumentsHost, Catch, ExceptionFilter, HttpException, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter, NestExpressApplication } from "@nestjs/platform-express";
import { RUNTIME_PROTOCOL } from "./modules/lms-runtime/runtime-contract";
import { RuntimeAppModule } from "./runtime-app.module";

@Catch()
class RuntimeErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const parserType = error && typeof error === "object" && "type" in error ? error.type : null;
    const status = error instanceof HttpException ? error.getStatus() : parserType === "entity.too.large" ? 413 : parserType === "entity.parse.failed" ? 400 : 500;
    const codes: Record<number, string> = { 400: "INVALID_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "REVISION_CONFLICT", 413: "PAYLOAD_TOO_LARGE", 503: "RUNTIME_UNAVAILABLE" };
    host.switchToHttp().getResponse().status(status).json({ protocol: RUNTIME_PROTOCOL, error: codes[status] || "RUNTIME_ERROR" });
  }
}

export async function createRuntimeApplication() {
  // Use an explicit adapter so the portable release never resolves a package from the host's node_modules.
  const app = await NestFactory.create<NestExpressApplication>(RuntimeAppModule, new ExpressAdapter(), { logger: false, bodyParser: false });
  app.useBodyParser("json", { limit: "26mb" });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, validationError: { target: false, value: false } }));
  app.useGlobalFilters(new RuntimeErrorFilter());
  return app;
}

export async function startRuntimeServer() {
  const port = Number(process.env.LMS_RUNTIME_PORT || 4101);
  const host = process.env.LMS_RUNTIME_LISTEN_HOST || "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid private runtime listener");
  const app = await createRuntimeApplication();
  try { await app.listen(port, host); return app; }
  catch { await app.close(); throw new Error("Runtime listener failed"); }
}

if (require.main === module) void startRuntimeServer().catch(() => { process.stderr.write("LMS runtime API startup failed\n"); process.exitCode = 1; });
