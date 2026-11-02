import { Module } from "@nestjs/common";

import { TestAttemptsController } from "./test-attempts.controller";
import { TestAttemptsService } from "./test-attempts.service";

@Module({
  controllers: [TestAttemptsController],
  providers: [TestAttemptsService]
})
export class TestAttemptsModule {}
