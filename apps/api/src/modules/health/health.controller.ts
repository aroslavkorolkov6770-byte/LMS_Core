import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly configService: ConfigService
  ) {}

  @Get()
  getHealth(): {
    status: string;
    service: string;
    env: string;
    timestamp: string;
  } {
    return {
      ...this.healthService.getHealth(),
      env: this.configService.get<string>("app.env", "development")
    };
  }
}
