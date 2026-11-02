import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { ROLE_CODES, RoleCode } from "@lms-core/shared";

@Injectable()
export class DevAuthGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: {
        userId: string;
        clientId: string;
        roleCode: RoleCode;
      };
    }>();

    const devAuthEnabled = this.configService.get<string>("app.env", "development") !== "production";

    if (!devAuthEnabled) {
      return true;
    }

    const roleCodeHeader = request.headers["x-dev-role-code"];
    const clientIdHeader = request.headers["x-dev-client-id"];
    const userIdHeader = request.headers["x-dev-user-id"];

    request.user = {
      userId: typeof userIdHeader === "string" ? userIdHeader : "dev-user",
      clientId: typeof clientIdHeader === "string" ? clientIdHeader : "dev-client",
      roleCode:
        typeof roleCodeHeader === "string"
          ? (roleCodeHeader as RoleCode)
          : ROLE_CODES.systemAdmin
    };

    return true;
  }
}
