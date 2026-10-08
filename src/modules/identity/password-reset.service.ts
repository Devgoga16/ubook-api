import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import type { Model } from 'mongoose';
import { AppError } from '../../core/common/errors.js';
import { passwordResetEmail } from '../../core/mail/templates.js';
import { MailService } from '../../core/mail/mail.service.js';
import { PasswordReset } from './schemas/password-reset.schema.js';
import { SessionsService } from './sessions.service.js';
import { UsersService } from './users.service.js';

/** El enlace vence en una hora. */
const TTL_MS = 60 * 60 * 1000;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const invalidLink = () =>
  new AppError(HttpStatus.BAD_REQUEST, 'INVALID_RESET_LINK', 'El enlace venció o ya se usó. Pide uno nuevo.');

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger('PasswordReset');

  constructor(
    @InjectModel(PasswordReset.name) private readonly resets: Model<PasswordReset>,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly mail: MailService,
  ) {}

  /**
   * Envía el enlace si la cuenta existe y está activa. La respuesta es la misma
   * en todos los casos, para no revelar qué correos tienen cuenta.
   */
  async request(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user?.isActive) return;
    // Un enlace nuevo invalida los anteriores.
    await this.resets.updateMany({ userId: user._id, usedAt: null }, { usedAt: new Date() }).exec();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + TTL_MS);
    await this.resets.create({ userId: user._id, tokenHash: hashToken(token), expiresAt });
    const sent = await this.mail.send(
      passwordResetEmail({ to: user.email, firstName: user.firstName, url: this.mail.appUrl(`/restablecer/${token}`) }),
    );
    if (!sent) this.logger.error(`No se pudo enviar el enlace de contraseña a ${user.email}`);
  }

  /** Para la página del enlace: si sigue vigente y de quién es (sin revelar más). */
  async preview(token: string): Promise<{ email: string }> {
    const reset = await this.findValid(token);
    const user = await this.users.findById(reset.userId.toString());
    if (!user?.isActive) throw invalidLink();
    return { email: maskEmail(user.email) };
  }

  /** Cambia la contraseña y cierra todas las sesiones abiertas. */
  async reset(token: string, password: string): Promise<void> {
    const reset = await this.findValid(token);
    // Se marca usado primero: dos envíos simultáneos no pueden usar el mismo enlace.
    const claimed = await this.resets.updateOne({ _id: reset._id, usedAt: null }, { usedAt: new Date() }).exec();
    if (!claimed.modifiedCount) throw invalidLink();
    const userId = reset.userId.toString();
    await this.users.setPassword(userId, password);
    await this.sessions.revokeAllForUser(userId);
  }

  private async findValid(token: string) {
    const reset = token ? await this.resets.findOne({ tokenHash: hashToken(token) }).exec() : null;
    if (!reset || reset.usedAt || reset.expiresAt.getTime() <= Date.now()) throw invalidLink();
    return reset;
  }
}

/** "ana.perez@gmail.com" → "an•••@gmail.com" */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(3, local.length - 2))}@${domain}`;
}
