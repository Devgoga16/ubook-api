import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  /** Versión en texto plano (clientes de correo sin HTML y la consola). */
  text: string;
}

/**
 * Envío de correos.
 * - Con RESEND_API_KEY: los envía por Resend.
 * - Sin ella (desarrollo): los muestra en la consola de la API.
 * - En pruebas: los guarda en `outbox`.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  /** Correos enviados durante las pruebas. */
  readonly outbox: MailMessage[] = [];

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** URL de la app web, para armar enlaces. */
  appUrl(path = ''): string {
    const base =
      this.config.get('APP_URL', { infer: true }) ?? this.config.get('CORS_ORIGIN', { infer: true }).split(',')[0]!.trim();
    return `${base.replace(/\/+$/, '')}${path}`;
  }

  /** Devuelve si el correo salió. Un fallo no debe romper la operación que lo originó. */
  async send(message: MailMessage): Promise<boolean> {
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') {
      this.outbox.push(message);
      return true;
    }
    const apiKey = this.config.get('RESEND_API_KEY', { infer: true });
    if (!apiKey) {
      this.logger.log(`\n✉  Para: ${message.to}\n   Asunto: ${message.subject}\n\n${message.text}\n`);
      return true;
    }
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: this.config.get('MAIL_FROM', { infer: true }),
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.logger.error(`Resend respondió ${res.status}: ${await res.text()}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`No se pudo enviar el correo a ${message.to}: ${(error as Error).message}`);
      return false;
    }
  }
}
