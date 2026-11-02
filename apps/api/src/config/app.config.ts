export const appConfig = () => ({
  app: {
    env: process.env.NODE_ENV ?? "development",
    port: Number(process.env.API_PORT ?? 3001)
  },
  database: {
    url: process.env.DATABASE_URL ?? ""
  },
  redis: {
    url: process.env.REDIS_URL ?? ""
  },
  security: {
    aiHistoryEncryptionKey: process.env.AI_HISTORY_ENCRYPTION_KEY ?? "",
    documentStorageEncryptionKey: process.env.DOCUMENT_STORAGE_ENCRYPTION_KEY ?? ""
  },
  storage: {
    privateRoot: process.env.PRIVATE_STORAGE_ROOT ?? "infra/private-storage",
    maxDocumentBytes: Number(process.env.MAX_DOCUMENT_BYTES ?? 15 * 1024 * 1024)
  }
});
