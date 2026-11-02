import { Body, Controller, Get, Header, Post, Put, Req, UseGuards } from "@nestjs/common";
import { RUNTIME_PROTOCOL } from "./runtime-contract";
import { RuntimeBootstrapDto, RuntimeReadDto, RuntimeWriteDto } from "./runtime.dto";
import { RuntimeGuard } from "./runtime.guard";
import { RuntimeService } from "./runtime.service";

type RuntimeRequest = { runtimeClientId: string };
@Controller("lms-runtime/v1")
@UseGuards(RuntimeGuard)
export class RuntimeController {
  constructor(private readonly service: RuntimeService) {}
  @Get("health") @Header("Cache-Control", "no-store")
  health() { return { protocol: RUNTIME_PROTOCOL, service: "lms-core-runtime-api", status: "ok" }; }
  @Post("read") @Header("Cache-Control", "no-store")
  read(@Req() request: RuntimeRequest, @Body() body: RuntimeReadDto) { return this.service.read(request.runtimeClientId, body.keys); }
  @Put("write") @Header("Cache-Control", "no-store")
  write(@Req() request: RuntimeRequest, @Body() body: RuntimeWriteDto) { return this.service.write(request.runtimeClientId, body); }
  @Post("bootstrap") @Header("Cache-Control", "no-store")
  bootstrap(@Req() request: RuntimeRequest, @Body() body: RuntimeBootstrapDto) { return this.service.bootstrap(request.runtimeClientId, body); }
}
