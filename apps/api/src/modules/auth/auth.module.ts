import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { DevAuthGuard } from "./dev-auth.guard";
import { RolesGuard } from "./roles.guard";

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: APP_GUARD,
      useClass: DevAuthGuard
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard
    }
  ],
  exports: [AuthService]
})
export class AuthModule {}
