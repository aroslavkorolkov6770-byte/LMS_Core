import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type RuntimeEnvelope = { v: 1; iv: string; tag: string; ciphertext: string };

@Injectable()
export class RuntimeCryptoService {
  constructor(private readonly config: ConfigService) {}
  private key(): Buffer {
    const value = this.config.get<string>("runtime.encryptionKey", "");
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new ServiceUnavailableException("Runtime encryption is not configured");
    return Buffer.from(value, "hex");
  }
  encrypt(text: string, clientId: string, key: string, revision: number): RuntimeEnvelope {
    const iv = randomBytes(12);
    const encryption = createCipheriv("aes-256-gcm", this.key(), iv);
    encryption.setAAD(Buffer.from(JSON.stringify([clientId, key, revision, 1])));
    const ciphertext = Buffer.concat([encryption.update(text, "utf8"), encryption.final()]);
    return { v: 1, iv: iv.toString("base64"), tag: encryption.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  }
  decrypt(input: unknown, clientId: string, key: string, revision: number): unknown {
    try {
      const value = input as RuntimeEnvelope;
      if (value?.v !== 1 || typeof value.iv !== "string" || typeof value.tag !== "string" || typeof value.ciphertext !== "string") throw new Error("Invalid envelope");
      const iv = Buffer.from(value.iv, "base64"), tag = Buffer.from(value.tag, "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid envelope");
      const cipher = createDecipheriv("aes-256-gcm", this.key(), iv);
      cipher.setAAD(Buffer.from(JSON.stringify([clientId, key, revision, 1])));
      cipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.ciphertext, "base64")), cipher.final()]).toString("utf8"));
    } catch { throw new ServiceUnavailableException("Runtime value integrity check failed"); }
  }
}
