import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type EncryptedAiHistory = {
  ciphertext: string;
  iv: string;
  authTag: string;
  encryptionVersion: number;
};

@Injectable()
export class AiHistoryCryptoService {
  private readonly algorithm = "aes-256-gcm";
  private readonly encryptionVersion = 1;

  constructor(private readonly configService: ConfigService) {}

  encrypt(value: unknown, clientId: string, userKey: string): EncryptedAiHistory {
    const key = this.getEncryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(this.algorithm, key, iv);
    cipher.setAAD(this.buildAdditionalAuthenticatedData(clientId, userKey));

    const plaintext = JSON.stringify(value);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final()
    ]);

    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      encryptionVersion: this.encryptionVersion
    };
  }

  decrypt<T>(
    encrypted: EncryptedAiHistory,
    clientId: string,
    userKey: string
  ): T {
    if (encrypted.encryptionVersion !== this.encryptionVersion) {
      throw new ServiceUnavailableException("Unsupported AI history encryption version");
    }

    try {
      const decipher = createDecipheriv(
        this.algorithm,
        this.getEncryptionKey(),
        Buffer.from(encrypted.iv, "base64")
      );
      decipher.setAAD(this.buildAdditionalAuthenticatedData(clientId, userKey));
      decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));

      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");

      return JSON.parse(plaintext) as T;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }

      throw new UnauthorizedException("AI history integrity check failed", {
        cause: error
      });
    }
  }

  private getEncryptionKey(): Buffer {
    const configuredKey = this.configService.get<string>(
      "security.aiHistoryEncryptionKey",
      ""
    );
    const normalizedKey = configuredKey.trim();

    if (!normalizedKey) {
      throw new ServiceUnavailableException("AI history encryption key is not configured");
    }

    const key = /^[0-9a-f]{64}$/i.test(normalizedKey)
      ? Buffer.from(normalizedKey, "hex")
      : Buffer.from(normalizedKey, "base64");

    if (key.length !== 32) {
      throw new ServiceUnavailableException("AI history encryption key must contain 32 bytes");
    }

    return key;
  }

  private buildAdditionalAuthenticatedData(clientId: string, userKey: string): Buffer {
    return Buffer.from(`${clientId}:${userKey}:v${this.encryptionVersion}`, "utf8");
  }
}
