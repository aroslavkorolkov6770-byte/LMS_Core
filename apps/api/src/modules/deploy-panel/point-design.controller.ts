import path from "node:path";
import { BadRequestException, Body, ConflictException, Controller, Get, InternalServerErrorException, NotFoundException, Post, Query } from "@nestjs/common";
import { Allow, IsInt, IsUUID, Matches, Min } from "class-validator";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";
import { Roles } from "../auth/roles.decorator";
import { DatabaseService } from "../database/database.service";

class PointDesignQuery {
  @IsUUID() clientId!: string;
  @Matches(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/) sourceRevision!: string;
}
class SavePointDesign extends PointDesignQuery {
  @IsInt() @Min(0) expectedRevision!: number;
  @Allow() document!: unknown;
}

@Controller("deploy-panel/point-design")
export class PointDesignController {
  private readonly contract = require(path.resolve(__dirname, "../../../../../infra/scripts/point-design-contract.cjs")) as {
    validatePointDesign(value: unknown): { clientId: string; sourceRevision: string; elements: Record<string, unknown> };
    emptyPointDesign(clientId: string, revision: string): unknown;
  };
  constructor(private readonly database: DatabaseService) {}
  private key(revision: string) { return `core.point-design.v3:${revision}`; }

  @Get()
  @Roles(ROLE_CODES.systemAdmin)
  async get(@Query() input: PointDesignQuery): Promise<unknown> {
    try {
      const [client] = await this.database.db.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, input.clientId)).limit(1);
      if (!client) throw new NotFoundException("Клиент не найден.");
      const [row] = await this.database.db.select().from(schema.clientContent).where(and(eq(schema.clientContent.clientId, input.clientId), eq(schema.clientContent.key, this.key(input.sourceRevision)))).limit(1);
      const saved = row?.payload as { revision?: number; document?: unknown } | undefined;
      return { clientId: input.clientId, sourceRevision: input.sourceRevision, revision: saved?.revision ?? 0,
        document: saved ? this.contract.validatePointDesign(saved.document) : this.contract.emptyPointDesign(input.clientId, input.sourceRevision) };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Не удалось прочитать точечное оформление клиента.", { cause: error });
    }
  }

  @Post()
  @Roles(ROLE_CODES.systemAdmin)
  async save(@Body() input: SavePointDesign): Promise<unknown> {
    let document;
    try { document = this.contract.validatePointDesign(input.document); }
    catch { throw new BadRequestException("Недопустимая правка. Разрешены только существующие элементы, текст, цвета и встроенные шрифты."); }
    if (document.clientId !== input.clientId || document.sourceRevision !== input.sourceRevision) throw new BadRequestException("Оформление принадлежит другому клиенту или Git-версии.");
    try {
      return await this.database.db.transaction(async (tx) => {
        // One lock for this client/revision also protects the first insert; a stale editor cannot overwrite another save.
        const key = this.key(input.sourceRevision);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.clientId + key}, 0))`);
        const [client] = await tx.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.id, input.clientId)).limit(1);
        if (!client) throw new NotFoundException("Клиент не найден.");
        const condition = and(eq(schema.clientContent.clientId, input.clientId), eq(schema.clientContent.key, key));
        const [row] = await tx.select().from(schema.clientContent).where(condition).limit(1);
        const revision = (row?.payload as { revision?: number } | undefined)?.revision ?? 0;
        if (revision !== input.expectedRevision) throw new ConflictException("Оформление уже изменено в другом окне. Черновик сохранен в редакторе; перечитайте сохраненную версию перед повторной записью.");
        const payload = { revision: revision + 1, document };
        const [saved] = row
          ? await tx.update(schema.clientContent).set({ payload, updatedAt: new Date(), updatedByUserId: null }).where(condition).returning({ id: schema.clientContent.id })
          : await tx.insert(schema.clientContent).values({ clientId: input.clientId, key, payload }).returning({ id: schema.clientContent.id });
        await tx.insert(schema.auditLog).values({ clientId: input.clientId, actorUserId: null, action: "point_design.saved", entityType: "client_content", entityId: saved.id,
          details: { source: "core_git_point_editor", sourceRevision: input.sourceRevision, revision: payload.revision, elementIds: Object.keys(document.elements) } });
        return { clientId: input.clientId, sourceRevision: input.sourceRevision, ...payload };
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException("Не удалось сохранить точечное оформление. Черновик не сброшен.", { cause: error });
    }
  }
}
