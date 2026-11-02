import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  PayloadTooLargeException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { schema } from "@lms-core/db";
import { ROLE_CODES } from "@lms-core/shared";

import { AuditService } from "../audit/audit.service";
import { RequestUser } from "../auth/current-user.decorator";
import { DatabaseService } from "../database/database.service";
import { DocumentFileCryptoService } from "./document-file-crypto.service";
import { LegacyDocumentFileDto } from "./dto/legacy-document-file.dto";

type StoredDocumentEnvelope = {
  mimeType: string;
  sizeBytes: number;
  ciphertext: string;
  iv: string;
  authTag: string;
  encryptionVersion: number;
};

@Injectable()
export class DocumentFilesService {
  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly auditService: AuditService,
    private readonly cryptoService: DocumentFileCryptoService
  ) {}

  async getForActor(
    query: LegacyDocumentFileDto,
    actor: RequestUser
  ): Promise<{ data: Buffer; mimeType: string; sizeBytes: number }> {
    try {
      await this.assertCanRead(query.clientId, query.fileKey, actor);
      const envelope = await this.readEnvelope(query.clientId, query.fileKey);

      return {
        data: this.cryptoService.decrypt(envelope, query.clientId, query.fileKey),
        mimeType: envelope.mimeType,
        sizeBytes: envelope.sizeBytes
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to read private document file", {
        cause: error
      });
    }
  }

  async saveForActor(
    query: LegacyDocumentFileDto,
    mimeTypeHeader: string | undefined,
    stream: Readable,
    actor: RequestUser
  ): Promise<{ fileKey: string; mimeType: string; sizeBytes: number; saved: true }> {
    try {
      this.assertCanWrite(query.clientId, actor);
      await this.assertClientExists(query.clientId);
      const mimeType = this.normalizeMimeType(mimeTypeHeader);
      const data = await this.readLimitedStream(stream);
      const encrypted = this.cryptoService.encrypt(data, query.clientId, query.fileKey);
      const envelope: StoredDocumentEnvelope = {
        mimeType,
        sizeBytes: data.length,
        ...encrypted
      };

      await this.writeEnvelope(query.clientId, query.fileKey, envelope);
      const actorUserId = await this.getExistingActorUserId(actor.userId);

      await this.auditService.writeLog({
        clientId: query.clientId,
        actorUserId,
        action: "document_file.saved",
        entityType: "document_file",
        entityId: query.fileKey,
        details: {
          mimeType,
          sizeBytes: data.length,
          storage: "encrypted-private-local"
        }
      });

      return {
        fileKey: query.fileKey,
        mimeType,
        sizeBytes: data.length,
        saved: true
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to save private document file", {
        cause: error
      });
    }
  }

  async deleteForActor(
    query: LegacyDocumentFileDto,
    actor: RequestUser
  ): Promise<{ fileKey: string; deleted: boolean }> {
    try {
      this.assertCanWrite(query.clientId, actor);
      const filePath = this.getFilePath(query.clientId, query.fileKey);
      let deleted = true;

      try {
        await rm(filePath);
      } catch (error) {
        if (this.isFileNotFoundError(error)) {
          deleted = false;
        } else {
          throw error;
        }
      }

      await this.auditService.writeLog({
        clientId: query.clientId,
        actorUserId: await this.getExistingActorUserId(actor.userId),
        action: "document_file.deleted",
        entityType: "document_file",
        entityId: query.fileKey,
        details: {
          deleted
        }
      });

      return {
        fileKey: query.fileKey,
        deleted
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException("Failed to delete private document file", {
        cause: error
      });
    }
  }

  private async assertCanRead(
    clientId: string,
    fileKey: string,
    actor: RequestUser
  ): Promise<void> {
    if (
      (actor.roleCode === ROLE_CODES.clientAdmin || actor.roleCode === ROLE_CODES.employee) &&
      actor.clientId !== clientId
    ) {
      throw new ForbiddenException("User cannot read a document from another client");
    }

    if (actor.roleCode !== ROLE_CODES.employee) {
      return;
    }

    const [document] = await this.databaseService.db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.clientId, clientId),
          eq(schema.documents.storagePath, `file_data_${fileKey}`),
          eq(schema.documents.isPublished, true)
        )
      )
      .limit(1);

    if (!document) {
      throw new ForbiddenException("Employee cannot read an unpublished document");
    }
  }

  private assertCanWrite(clientId: string, actor: RequestUser): void {
    if (actor.roleCode === ROLE_CODES.employee) {
      throw new ForbiddenException("Employee cannot modify document files");
    }

    if (actor.roleCode === ROLE_CODES.clientAdmin && actor.clientId !== clientId) {
      throw new ForbiddenException("Client admin cannot modify another client document");
    }
  }

  private async assertClientExists(clientId: string): Promise<void> {
    const [client] = await this.databaseService.db
      .select({ id: schema.clients.id })
      .from(schema.clients)
      .where(eq(schema.clients.id, clientId))
      .limit(1);

    if (!client) {
      throw new NotFoundException("Client not found");
    }
  }

  private async readLimitedStream(stream: Readable): Promise<Buffer> {
    const maxDocumentBytes = this.configService.get<number>(
      "storage.maxDocumentBytes",
      15 * 1024 * 1024
    );
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;

      if (totalBytes > maxDocumentBytes) {
        throw new PayloadTooLargeException(
          `Document is larger than ${maxDocumentBytes} bytes`
        );
      }

      chunks.push(buffer);
    }

    return Buffer.concat(chunks);
  }

  private normalizeMimeType(value: string | undefined): string {
    const mimeType = value?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";

    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType)) {
      throw new BadRequestException("Invalid document MIME type");
    }

    return mimeType;
  }

  private async readEnvelope(
    clientId: string,
    fileKey: string
  ): Promise<StoredDocumentEnvelope> {
    try {
      const rawEnvelope = await readFile(this.getFilePath(clientId, fileKey), "utf8");
      const envelope = JSON.parse(rawEnvelope) as Partial<StoredDocumentEnvelope>;

      if (
        typeof envelope.mimeType !== "string" ||
        typeof envelope.sizeBytes !== "number" ||
        typeof envelope.ciphertext !== "string" ||
        typeof envelope.iv !== "string" ||
        typeof envelope.authTag !== "string" ||
        typeof envelope.encryptionVersion !== "number"
      ) {
        throw new Error("Invalid private document envelope");
      }

      return envelope as StoredDocumentEnvelope;
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        throw new NotFoundException("Private document file not found");
      }

      throw error;
    }
  }

  private async writeEnvelope(
    clientId: string,
    fileKey: string,
    envelope: StoredDocumentEnvelope
  ): Promise<void> {
    const filePath = this.getFilePath(clientId, fileKey);
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;

    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(envelope), {
      encoding: "utf8",
      flag: "wx"
    });
    await rm(filePath, { force: true });
    await rename(temporaryPath, filePath);
  }

  private getFilePath(clientId: string, fileKey: string): string {
    const configuredRoot = this.configService.get<string>(
      "storage.privateRoot",
      "infra/private-storage"
    );
    const workspaceRoot = path.resolve(__dirname, "../../../../..");
    const root = path.isAbsolute(configuredRoot)
      ? configuredRoot
      : path.resolve(workspaceRoot, configuredRoot);
    const fileName = `${createHash("sha256").update(fileKey).digest("hex")}.enc.json`;

    return path.join(root, "documents", clientId, fileName);
  }

  private isFileNotFoundError(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ENOENT"
    );
  }

  private async getExistingActorUserId(
    value: string | null | undefined
  ): Promise<string | undefined> {
    if (!value) {
      return undefined;
    }

    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(value)) {
      return undefined;
    }

    const [user] = await this.databaseService.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, value))
      .limit(1);

    return user?.id;
  }
}
