import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, timingSafeEqual } from "node:crypto";

@Injectable()
export class RuntimeGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(context: ExecutionContext): boolean {
    const clientId = this.config.get<string>("runtime.clientId", "");
    const configured = this.config.get<string>("runtime.serviceToken", "");
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(clientId) || !/^[A-Za-z0-9_-]{43,256}$/.test(configured)) {
      throw new ServiceUnavailableException("Runtime access is not configured");
    }
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown>; runtimeClientId?: string }>();
    const authorization = request.headers.authorization;
    const supplied = typeof authorization === "string" ? /^Bearer ([A-Za-z0-9_-]{43,256})$/.exec(authorization)?.[1] : null;
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!supplied || !timingSafeEqual(digest(supplied), digest(configured))) throw new UnauthorizedException("Runtime authentication failed");
    // The tenant comes from server configuration, not a body/query or x-dev-role header.
    request.runtimeClientId = clientId;
    return true;
  }
}
