import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../../config/env.js';
import { AppError } from '../common/errors.js';

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
/** Duración del enlace firmado del logo de un negocio. Las pantallas lo piden de nuevo al cargar. */
export const LOGO_URL_TTL_SECONDS = 24 * 60 * 60;
const IMAGE_TYPES = [
  { type: 'image/jpeg', ext: 'jpg', test: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/png', ext: 'png', test: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/webp', ext: 'webp', test: (b: Buffer) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
];

/** Lo que sube el usuario, validado por su contenido (no por el nombre ni el tipo que declara el navegador). */
export function detectImage(buffer: Buffer): { type: string; ext: string } {
  if (!buffer?.length) throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Adjunta una imagen');
  if (buffer.length > MAX_IMAGE_BYTES) throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_TOO_LARGE', 'La foto pesa más de 6 MB');
  const match = IMAGE_TYPES.find((t) => t.test(buffer));
  if (!match) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_IMAGE', 'Sube una foto en JPG, PNG o WebP');
  return match;
}

/**
 * Archivos privados (comprobantes de pago).
 * - Con R2_* configurado: Cloudflare R2 (compatible con S3) y enlaces firmados de 10 min.
 * - Sin R2 (desarrollo): carpeta local y enlaces firmados por la API (/api/files/…).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger('Storage');
  private readonly s3: S3Client | null;
  private readonly bucket: string | null;
  private readonly localDir: string;
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const account = config.get('R2_ACCOUNT_ID', { infer: true });
    const accessKeyId = config.get('R2_ACCESS_KEY_ID', { infer: true });
    const secretAccessKey = config.get('R2_SECRET_ACCESS_KEY', { infer: true });
    this.bucket = config.get('R2_BUCKET', { infer: true }) ?? null;
    // Las pruebas nunca escriben en el bucket real, aunque el .env tenga R2.
    const isTest = config.get('NODE_ENV', { infer: true }) === 'test';
    this.s3 =
      !isTest && account && accessKeyId && secretAccessKey && this.bucket
        ? new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } })
        : null;
    this.localDir =
      config.get('NODE_ENV', { infer: true }) === 'test' ? join(tmpdir(), 'ubook-test-uploads') : config.get('LOCAL_UPLOADS_DIR', { infer: true });
    this.key = Buffer.from(hkdfSync('sha256', config.get('JWT_ACCESS_SECRET', { infer: true }), 'ubook', 'file-links', 32));
    if (!this.s3) this.logger.log(`Sin Cloudflare R2: los archivos se guardan en ${this.localDir}`);
  }

  get driver(): 'r2' | 'local' {
    return this.s3 ? 'r2' : 'local';
  }

  /** Guarda una imagen validada y devuelve su clave. */
  async putImage(prefix: string, buffer: Buffer): Promise<string> {
    const { type, ext } = detectImage(buffer);
    const now = new Date();
    const key = `${prefix}/${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomBytes(12).toString('hex')}.${ext}`;
    if (this.s3) {
      try {
        await this.s3.send(new PutObjectCommand({ Bucket: this.bucket!, Key: key, Body: buffer, ContentType: type }));
      } catch (e) {
        // Credenciales, permisos o bucket mal configurados: se registra el detalle y el usuario ve un mensaje claro.
        const err = e as { Code?: string; name?: string; $metadata?: { httpStatusCode?: number } };
        this.logger.error(`No se pudo subir a R2 (bucket "${this.bucket}"): ${err.Code ?? err.name} ${err.$metadata?.httpStatusCode ?? ''}`.trim());
        throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'STORAGE_UNAVAILABLE', 'No pudimos guardar la foto en este momento. Intenta de nuevo en unos minutos.');
      }
    } else {
      const path = this.localPath(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, buffer);
    }
    return key;
  }

  /** Borra todos los archivos bajo un prefijo (p. ej. `deposits/<orgId>`). Devuelve cuántos borró. */
  async deletePrefix(prefix: string): Promise<number> {
    const clean = `${prefix.replace(/\/+$/, '')}/`;
    if (!/^[a-z]+\/[0-9a-f]{24}\/$/.test(clean)) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_KEY', 'Prefijo inválido');
    if (!this.s3) {
      await rm(this.localPath(clean), { recursive: true, force: true });
      return 0;
    }
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket!, Prefix: clean, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket!, Delete: { Objects: keys, Quiet: true } }));
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  /** Borra un archivo. No falla si ya no existe. */
  async delete(key: string): Promise<void> {
    if (this.s3) {
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket!, Delete: { Objects: [{ Key: key }], Quiet: true } }));
      return;
    }
    await rm(this.localPath(key), { force: true });
  }

  /** Enlace temporal para ver un archivo privado. */
  async url(key: string, ttlSeconds = 600): Promise<string> {
    if (this.s3) return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket!, Key: key }), { expiresIn: ttlSeconds });
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const payload = Buffer.from(`${key}|${exp}`).toString('base64url');
    return `/api/files/${payload}.${this.sign(payload)}`;
  }

  /** Para el controlador de archivos locales: valida la firma y lee el archivo. */
  async readLocal(token: string): Promise<{ buffer: Buffer; type: string } | null> {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = Buffer.from(this.sign(payload));
    if (expected.length !== signature.length || !timingSafeEqual(expected, Buffer.from(signature))) return null;
    const [key, exp] = Buffer.from(payload, 'base64url').toString().split('|');
    if (!key || Number(exp) < Date.now() / 1000) return null;
    try {
      const buffer = await readFile(this.localPath(key));
      return { buffer, type: detectImage(buffer).type };
    } catch {
      return null;
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url').slice(0, 32);
  }

  /** Ruta local segura (sin "../"). */
  private localPath(key: string): string {
    const path = normalize(join(this.localDir, key));
    if (!path.startsWith(normalize(this.localDir))) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_KEY', 'Archivo inválido');
    return path;
  }
}
