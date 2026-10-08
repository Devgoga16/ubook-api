import { plainToInstance, Type } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export class Env {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @Type(() => Number)
  @IsInt()
  PORT = 4000;

  @IsString()
  MONGODB_URI: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  JWT_ACCESS_TTL_SECONDS = 900;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  REFRESH_TTL_DAYS = 30;

  /** Orígenes permitidos para CORS, separados por coma. */
  @IsString()
  CORS_ORIGIN = 'http://localhost:5173';

  /**
   * SameSite de la cookie de sesión.
   * - lax (por defecto): web y API en el mismo sitio (app.tudominio.com + api.tudominio.com).
   * - none: web y API en dominios distintos (p. ej. *.vercel.app + *.onrender.com).
   *   Exige HTTPS, y Safari puede bloquearla: mejor usar dominios propios.
   */
  @IsIn(['lax', 'strict', 'none'])
  COOKIE_SAMESITE: 'lax' | 'strict' | 'none' = 'lax';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  TRIAL_DAYS = 30;

  @IsString()
  TRIAL_PLAN_CODE = 'pro';

  @IsOptional()
  @IsEmail()
  SUPERADMIN_EMAIL?: string;

  @IsOptional()
  @IsString()
  @MinLength(12)
  SUPERADMIN_PASSWORD?: string;

  /**
   * Clave AES-256 (32 bytes en base64) para cifrar las fichas clínicas.
   * Obligatoria en producción. Si se pierde, las fichas no se pueden leer.
   */
  @IsOptional()
  @IsString()
  @MinLength(43)
  RECORDS_ENCRYPTION_KEY?: string;

  /** API key de Resend. Sin ella, los correos se muestran en la consola de la API. */
  @IsOptional()
  @IsString()
  RESEND_API_KEY?: string;

  /** Remitente (dominio verificado en Resend). */
  @IsString()
  MAIL_FROM = 'uBook <notificaciones@ubook.pe>';

  /** URL de la app web para los enlaces de los correos. Por defecto, el primer CORS_ORIGIN. */
  @IsOptional()
  @IsString()
  APP_URL?: string;

  /** Datos para que los negocios paguen su suscripción (se muestran en "Plan y pagos"). */
  @IsOptional()
  @IsString()
  BILLING_YAPE?: string;

  @IsOptional()
  @IsString()
  BILLING_BANK?: string;

  @IsOptional()
  @IsString()
  BILLING_CONTACT?: string;

  /** API de WhatsApp de Unify. Sin API key, los mensajes se muestran en la consola. */
  @IsString()
  WHATSAPP_API_URL = 'https://api-ws-unify.rapi-almacen.shop/api';

  @IsOptional()
  @IsString()
  WHATSAPP_SESSION?: string;

  @IsOptional()
  @IsString()
  WHATSAPP_API_KEY?: string;

  /** Cloudflare R2 (bucket privado) para comprobantes. Sin esto, se guardan en LOCAL_UPLOADS_DIR. */
  @IsOptional()
  @IsString()
  R2_ACCOUNT_ID?: string;

  @IsOptional()
  @IsString()
  R2_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  R2_SECRET_ACCESS_KEY?: string;

  @IsOptional()
  @IsString()
  R2_BUCKET?: string;

  @IsString()
  LOCAL_UPLOADS_DIR = '.uploads';
}

export function validateEnv(config: Record<string, unknown>): Env {
  const env = plainToInstance(Env, config, { enableImplicitConversion: false });
  const errors = validateSync(env, { skipMissingProperties: false });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${details}`);
  }
  return env;
}
