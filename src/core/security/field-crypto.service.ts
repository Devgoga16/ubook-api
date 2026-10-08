import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Env } from '../../config/env.js';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Cifrado de datos sensibles a nivel de campo (AES-256-GCM). Lo que se guarda
 * en la base no se puede leer ni alterar sin la clave.
 * Formato: "v1:" + base64(iv | tag | texto cifrado).
 */
@Injectable()
export class FieldCryptoService {
  private readonly logger = new Logger(FieldCryptoService.name);
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const raw = config.get('RECORDS_ENCRYPTION_KEY', { infer: true });
    if (raw) {
      this.key = Buffer.from(raw, 'base64');
      if (this.key.length !== 32) throw new Error('RECORDS_ENCRYPTION_KEY debe ser de 32 bytes en base64');
      return;
    }
    if (config.get('NODE_ENV', { infer: true }) === 'production') {
      throw new Error('Falta RECORDS_ENCRYPTION_KEY: es obligatoria en producción para cifrar las fichas clínicas');
    }
    // Solo desarrollo: clave derivada del secreto de JWT para no bloquear el arranque.
    this.logger.warn('RECORDS_ENCRYPTION_KEY no definida: usando una clave derivada (solo para desarrollo).');
    this.key = Buffer.from(
      hkdfSync('sha256', config.get('JWT_ACCESS_SECRET', { infer: true }), 'ubook', 'records-encryption', 32),
    );
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [version, body] = payload.split(':');
    if (version !== VERSION || !body) throw new Error('Formato de dato cifrado desconocido');
    const buf = Buffer.from(body, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, IV_BYTES));
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }

  encryptJson(value: unknown): string {
    return this.encrypt(JSON.stringify(value));
  }

  decryptJson<T>(payload: string): T {
    return JSON.parse(this.decrypt(payload)) as T;
  }
}
