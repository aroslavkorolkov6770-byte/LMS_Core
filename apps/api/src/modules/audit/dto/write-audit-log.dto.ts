export class WriteAuditLogDto {
  clientId!: string;
  actorUserId?: string;
  action!: string;
  entityType!: string;
  entityId!: string;
  details?: Record<string, unknown>;
}
