import { Module } from "@nestjs/common";

import { LearningContentController } from "./learning-content.controller";
import { LearningContentService } from "./learning-content.service";

@Module({
  controllers: [LearningContentController],
  providers: [LearningContentService]
})
export class LearningContentModule {}
