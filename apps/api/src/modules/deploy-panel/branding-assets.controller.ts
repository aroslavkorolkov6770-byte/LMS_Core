import { BadRequestException, Controller, Get, Post, Query, Req, Res } from "@nestjs/common";
import { IncomingMessage, ServerResponse } from "node:http";
import { ROLE_CODES } from "@lms-core/shared";
import { Roles } from "../auth/roles.decorator";
import { DeployPanelService } from "./deploy-panel.service";

const MAX_BYTES = 4 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

@Controller("deploy-panel/branding-assets")
export class BrandingAssetsController {
  constructor(private readonly panel: DeployPanelService) {}

  @Post()
  @Roles(ROLE_CODES.systemAdmin)
  async upload(@Query("clientId") clientId: string, @Req() request: IncomingMessage): Promise<unknown> {
    if (!UUID.test(clientId || "") || request.headers["content-type"] !== "application/octet-stream" || Number(request.headers["content-length"] || 0) > MAX_BYTES) throw new BadRequestException("Допустим файл PNG, JPEG или WebP до 4 МБ.");
    const chunks: Buffer[] = [];
    let size = 0;
    const deadline = setTimeout(() => request.destroy(new Error("IMAGE_UPLOAD_TIMEOUT")), 15000);
    try {
      // Binary input avoids multipart filenames and never stores the image as base64 in SQL.
      for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > MAX_BYTES) throw new BadRequestException("Изображение больше 4 МБ.");
        chunks.push(chunk);
      }
      return await this.panel.saveBrandingImage(clientId, Buffer.concat(chunks));
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Файл не принят. Используйте корректное PNG, JPEG или WebP до 4 МБ.");
    } finally { clearTimeout(deadline); }
  }

  @Get()
  @Roles(ROLE_CODES.systemAdmin)
  async read(@Query("clientId") clientId: string, @Query("asset") asset: string, @Res() response: ServerResponse): Promise<void> {
    if (!UUID.test(clientId || "") || !/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(asset || "")) throw new BadRequestException("Некорректное изображение клиента.");
    try {
      const result = await this.panel.readBrandingImage(clientId, asset);
      response.writeHead(200, { "Content-Type": result.info.mime, "Content-Length": result.bytes.length, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable" });
      response.end(result.bytes);
    } catch { response.writeHead(404, { "Cache-Control": "no-store" }); response.end(); }
  }
}
