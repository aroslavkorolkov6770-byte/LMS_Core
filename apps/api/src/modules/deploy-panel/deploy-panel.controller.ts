import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ROLE_CODES } from "@lms-core/shared";

import { Roles } from "../auth/roles.decorator";
import { BootstrapClientDto } from "./dto/bootstrap-client.dto";
import { DeployWorkflowActionDto } from "./dto/deploy-workflow-action.dto";
import { DeployClientDetailDto } from "./dto/deploy-client-detail.dto";
import { PreviewSettingsQueryDto, SavePreviewSettingsDto } from "./dto/preview-settings.dto";
import { UpdateDeployProfileDto } from "./dto/update-deploy-profile.dto";
import { ValidateClientDto } from "./dto/validate-client.dto";
import { DeployPanelService } from "./deploy-panel.service";

@Controller("deploy-panel")
export class DeployPanelController {
  constructor(private readonly deployPanelService: DeployPanelService) {}

  @Get("meta")
  getMeta(): { module: string; status: string; dashboardRoute: string; detailRoute: string } {
    return this.deployPanelService.getMeta();
  }

  @Get("dashboard")
  @Roles(ROLE_CODES.systemAdmin)
  async getDashboard(): Promise<unknown> {
    return this.deployPanelService.getDashboard();
  }

  @Get("client-detail")
  @Roles(ROLE_CODES.systemAdmin)
  async getClientDetail(@Query() query: DeployClientDetailDto): Promise<unknown> {
    return this.deployPanelService.getClientDetail(query);
  }

  @Get("preview-settings")
  @Roles(ROLE_CODES.systemAdmin)
  async getPreviewSettings(@Query() query: PreviewSettingsQueryDto): Promise<unknown> {
    return this.deployPanelService.getPreviewSettings(query);
  }

  @Post("bootstrap-client")
  @Roles(ROLE_CODES.systemAdmin)
  async bootstrapClient(@Body() payload: BootstrapClientDto): Promise<unknown> {
    return this.deployPanelService.bootstrapClient(payload);
  }

  @Post("preview-settings")
  @Roles(ROLE_CODES.systemAdmin)
  async savePreviewSettings(@Body() payload: SavePreviewSettingsDto): Promise<unknown> {
    return this.deployPanelService.savePreviewSettings(payload);
  }

  @Post("update-deploy-profile")
  @Roles(ROLE_CODES.systemAdmin)
  async updateDeployProfile(@Body() payload: UpdateDeployProfileDto): Promise<unknown> {
    return this.deployPanelService.updateDeployProfile(payload);
  }

  @Post("mark-draft")
  @Roles(ROLE_CODES.systemAdmin)
  async markDraft(@Body() payload: DeployWorkflowActionDto): Promise<unknown> {
    return this.deployPanelService.markDraft(payload);
  }

  @Post("mark-validated")
  @Roles(ROLE_CODES.systemAdmin)
  async markValidated(@Body() payload: DeployWorkflowActionDto): Promise<unknown> {
    return this.deployPanelService.markValidated(payload);
  }

  @Post("mark-ready-to-deploy")
  @Roles(ROLE_CODES.systemAdmin)
  async markReadyToDeploy(@Body() payload: DeployWorkflowActionDto): Promise<unknown> {
    return this.deployPanelService.markReadyToDeploy(payload);
  }

  @Post("mark-deployed")
  @Roles(ROLE_CODES.systemAdmin)
  async markDeployed(@Body() payload: DeployWorkflowActionDto): Promise<unknown> {
    return this.deployPanelService.markDeployed(payload);
  }

  @Post("run-deploy")
  @Roles(ROLE_CODES.systemAdmin)
  async runDeploy(@Body() payload: DeployWorkflowActionDto): Promise<unknown> {
    return this.deployPanelService.runDeploy(payload);
  }

  @Post("run-health-check")
  @Roles(ROLE_CODES.systemAdmin)
  async runHealthCheck(@Body() payload: DeployWorkflowActionDto): Promise<unknown> {
    return this.deployPanelService.runHealthCheck(payload);
  }

  @Get("validate-client")
  @Roles(ROLE_CODES.systemAdmin)
  async validateClient(@Query() query: ValidateClientDto): Promise<unknown> {
    return this.deployPanelService.validateClient(query);
  }
}
