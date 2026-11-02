import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedDocumentFile = {
  ciphertext: string;
  iv: string;
  authTag: string;
  encryptionVersion: number;
};

@Injectable()
export class DocumentFileCryptoService {
  private readonly algorithm = "aes-256-gcm";
  private readonly encryptionVersion = 1;

  constructor(private readonly configService: ConfigService) {}

  encrypt(data: Buffer, clientId: string, fileKey: string): EncryptedDocumentFile {
    const iv = randomBytes(12);
    const cipher = createCipheriv(this.algorithm, this.getEncryptionKey(), iv);
    cipher.setAAD(this.buildAdditionalAuthenticatedData(clientId, fileKey));
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);

    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      encryptionVersion: this.encryptionVersion
    };
  }

  decrypt(
    encrypted: EncryptedDocumentFile,
    clientId: string,
    fileKey: string
  ): Buffer {
    if (encrypted.encryptionVersion !== this.encryptionVersion) {
      throw new ServiceUnavailableException("Unsupported document encryption version");
    }

    try {
      const decipher = createDecipheriv(
        this.algorithm,
        this.getEncryptionKey(),
        Buffer.from(encrypted.iv, "base64")
      );
      decipher.setAAD(this.buildAdditionalAuthenticatedData(clientId, fileKey));
      decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));

      return Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
        decipher.final()
      ]);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }

      throw new UnauthorizedException("Document integrity check failed", {
        cause: error
      });
    }
  }

  private getEncryptionKey(): Buffer {
    const configuredKey = this.configService.get<string>(
      "security.documentStorageEncryptionKey",
      ""
    );
    const normalizedKey = configuredKey.trim();

    if (!normalizedKey) {
      throw new ServiceUnavailableException(
        "Document storage encryption key is not configured"
      );
    }

    const key = /^[0-9a-f]{64}$/i.test(normalizedKey)
      ? Buffer.from(normalizedKey, "hex")
      : Buffer.from(normalizedKey, "base64");

    if (key.length !== 32) {
      throw new ServiceUnavailableException(
        "Document storage encryption key must contain 32 bytes"
      );
    }

    return key;
  }

  private buildAdditionalAuthenticatedData(clientId: string, fileKey: string): Buffer {
    return Buffer.from(`${clientId}:${fileKey}:v${this.encryptionVersion}`, "utf8");
  }
}
