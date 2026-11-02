import { Module } from "@nestjs/common";
import { RuntimeController } from "./runtime.controller";
import { RuntimeCryptoService } from "./runtime-crypto.service";
import { RuntimeGuard } from "./runtime.guard";
import { RuntimeService } from "./runtime.service";

@Module({ controllers: [RuntimeController], providers: [RuntimeGuard, RuntimeCryptoService, RuntimeService] })
export class RuntimeModule {}
