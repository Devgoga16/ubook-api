import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import type { Env } from '../../config/env.js';
import { MailService } from '../../core/mail/mail.service.js';

/**
 * Enlace para que el cliente gestione su cita sin cuenta: `<id>.<firma>`.
 * Firmado con HMAC, no se guarda nada: se puede volver a generar para los
 * recordatorios y no se puede adivinar el de otra cita.
 */
@Injectable()
export class BookingLinksService {
  private readonly key: Buffer;

  constructor(
    config: ConfigService<Env, true>,
    private readonly mail: MailService,
  ) {
    this.key = Buffer.from(hkdfSync('sha256', config.get('JWT_ACCESS_SECRET', { infer: true }), 'ubook', 'booking-manage-link', 32));
  }

  token(appointmentId: string): string {
    return `${appointmentId}.${this.sign(appointmentId)}`;
  }

  url(appointmentId: string): string {
    return this.mail.appUrl(`/reserva/${this.token(appointmentId)}`);
  }

  /** Devuelve el id de la cita si la firma es válida. */
  verify(token: string): string | null {
    const [id, signature] = token.split('.');
    if (!id || !signature || !Types.ObjectId.isValid(id)) return null;
    const expected = Buffer.from(this.sign(id));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
  }

  private sign(id: string): string {
    return createHmac('sha256', this.key).update(id).digest('base64url').slice(0, 32);
  }
}
