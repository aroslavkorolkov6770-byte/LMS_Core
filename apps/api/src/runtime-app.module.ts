import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { appConfig } from "./config/app.config";
import { DatabaseModule } from "./modules/database/database.module";
import { RuntimeModule } from "./modules/lms-runtime/runtime.module";

export const runtimeConfig = () => ({ runtime: {
  clientId: process.env.LMS_RUNTIME_CLIENT_ID || "",
  serviceToken: process.env.LMS_RUNTIME_SERVICE_TOKEN || "",
  encryptionKey: process.env.LMS_RUNTIME_ENCRYPTION_KEY || "",
  bootstrapEnabled: process.env.LMS_RUNTIME_BOOTSTRAP_ENABLED === "true"
} });

// Deliberately excludes the control plane, dev-auth, arbitrary admin and deploy endpoints.
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [appConfig, runtimeConfig] }), DatabaseModule, RuntimeModule] })
export class RuntimeAppModule {}
