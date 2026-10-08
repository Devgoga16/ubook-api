import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';

export interface WhatsAppMessage {
  /** Celular en formato +51987654321. */
  to: string;
  text: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * Envío de WhatsApp por la API de Unify (sesión de WhatsApp vinculada).
 * - Con WHATSAPP_API_KEY y WHATSAPP_SESSION: envía de verdad.
 * - Sin ellos: muestra el mensaje en la consola. En pruebas: lo guarda en `outbox`.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger('WhatsApp');
  readonly outbox: WhatsAppMessage[] = [];

  constructor(private readonly config: ConfigService<Env, true>) {}

  /** ¿Hay una sesión configurada? (si no, los mensajes van a la consola). */
  get configured(): boolean {
    return !!this.config.get('WHATSAPP_API_KEY', { infer: true }) && !!this.config.get('WHATSAPP_SESSION', { infer: true });
  }

  private url(path: string): string {
    const base = this.config.get('WHATSAPP_API_URL', { infer: true }).replace(/\/+$/, '');
    return `${base}/sessions/${encodeURIComponent(this.config.get('WHATSAPP_SESSION', { infer: true })!)}${path}`;
  }

  private headers() {
    return { Authorization: `Bearer ${this.config.get('WHATSAPP_API_KEY', { infer: true })}`, 'Content-Type': 'application/json' };
  }

  /** Estado de la sesión: conectada o no, y el número que envía. */
  async status(): Promise<{ connected: boolean; phoneNumber: string | null; status: string }> {
    if (this.config.get('NODE_ENV', { infer: true }) === 'test' || !this.configured) {
      return { connected: false, phoneNumber: null, status: 'not_configured' };
    }
    try {
      const res = await fetch(this.url('/status'), { headers: this.headers(), signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return { connected: false, phoneNumber: null, status: `error_${res.status}` };
      const body = (await res.json()) as { status?: string; phoneNumber?: string | null };
      return { connected: body.status === 'connected', phoneNumber: body.phoneNumber ?? null, status: body.status ?? 'unknown' };
    } catch {
      return { connected: false, phoneNumber: null, status: 'unreachable' };
    }
  }

  async send(message: WhatsAppMessage): Promise<SendResult> {
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') {
      this.outbox.push(message);
      return { ok: true };
    }
    if (!this.configured) {
      this.logger.log(`\n💬 Para: ${message.to}\n\n${message.text}\n`);
      return { ok: true };
    }
    try {
      const res = await fetch(this.url('/send'), {
        method: 'POST',
        headers: this.headers(),
        // La API espera el número sin "+": 51987654321.
        body: JSON.stringify({ to: message.to.replace(/\D/g, ''), text: message.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        this.logger.error(`WhatsApp respondió ${res.status}: ${detail}`);
        return { ok: false, error: `WhatsApp ${res.status}` };
      }
      return { ok: true };
    } catch (error) {
      this.logger.error(`No se pudo enviar a ${message.to}: ${(error as Error).message}`);
      return { ok: false, error: (error as Error).message };
    }
  }
}
