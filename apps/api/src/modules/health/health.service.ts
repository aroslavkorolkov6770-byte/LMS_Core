import { Injectable } from "@nestjs/common";

@Injectable()
export class HealthService {
  getHealth(): {
    status: string;
    service: string;
    timestamp: string;
  } {
    return {
      status: "ok",
      service: "lms-core-api",
      timestamp: new Date().toISOString()
    };
  }
}
