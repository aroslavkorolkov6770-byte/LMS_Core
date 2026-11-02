import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module";
import { DeployPanelController } from "./deploy-panel.controller";
import { DeployPanelService } from "./deploy-panel.service";
import { BrandingAssetsController } from "./branding-assets.controller";
import { PointDesignController } from "./point-design.controller";

@Module({
  imports: [DatabaseModule],
  controllers: [DeployPanelController, BrandingAssetsController, PointDesignController],
  providers: [DeployPanelService]
})
export class DeployPanelModule {}
