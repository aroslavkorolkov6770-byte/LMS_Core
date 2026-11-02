import { Injectable } from "@nestjs/common";

import { CORE_ROLES } from "@lms-core/shared";

@Injectable()
export class AuthService {
  getMeta(): {
    module: string;
    status: string;
    devHeaders: string[];
    roles: string[];
  } {
    return {
      module: "auth",
      status: "active",
      devHeaders: ["x-dev-user-id", "x-dev-client-id", "x-dev-role-code"],
      roles: CORE_ROLES.map((role) => role.code)
    };
  }
}
