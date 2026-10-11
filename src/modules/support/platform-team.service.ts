import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import { Errors } from '../../core/common/errors.js';
import { MailService } from '../../core/mail/mail.service.js';
import { platformInviteEmail } from '../../core/mail/templates.js';
import type { Actor } from '../../core/tenancy/tenant-context.js';
import { PasswordResetService } from '../identity/password-reset.service.js';
import type { UserDocument } from '../identity/schemas/user.schema.js';
import { SessionsService } from '../identity/sessions.service.js';
import { UsersService } from '../identity/users.service.js';
import type { InvitePlatformUserDto, UpdatePlatformUserDto } from './support.dto.js';

/** La invitación vale una semana. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Equipo de plataforma (Unify Tec): el super admin invita agentes de soporte,
 * les cambia el rol o les quita el acceso.
 */
@Injectable()
export class PlatformTeamService {
  constructor(
    private readonly users: UsersService,
    private readonly passwordReset: PasswordResetService,
    private readonly sessions: SessionsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.users.listPlatformUsers();
  }

  async invite(actor: Actor, dto: InvitePlatformUserDto) {
    const role = dto.role ?? 'support';
    const user = await this.users.createPlatformUser({ email: dto.email, firstName: dto.firstName, lastName: dto.lastName, platformRole: role });
    await this.audit.log({ action: 'platform.team_invited', actorUserId: actor.userId, entityType: 'User', entityId: user.id as string, metadata: { email: user.email, role } });
    return { id: user.id as string, ...(await this.sendInvite(actor, user)) };
  }

  /** Enlace nuevo para quien aún no creó su contraseña. */
  async resend(actor: Actor, id: string) {
    const user = await this.find(id);
    if (user.passwordHash) throw Errors.conflict('ALREADY_ACTIVE', 'Esta persona ya creó su contraseña. Si la olvidó, puede usar "Olvidé mi contraseña".');
    return this.sendInvite(actor, user);
  }

  async update(actor: Actor, id: string, dto: UpdatePlatformUserDto) {
    const user = await this.find(id);
    const losesAdmin = user.platformRole === 'super_admin' && user.isActive && (dto.role === 'support' || dto.isActive === false);
    if (losesAdmin) {
      if (id === actor.userId) throw Errors.badRequest('CANNOT_DEMOTE_SELF', 'No puedes quitarte tu propio acceso de super admin');
      if ((await this.users.countActiveSuperAdmins()) <= 1) throw Errors.badRequest('LAST_SUPER_ADMIN', 'Debe quedar al menos un super admin activo');
    }
    if (dto.firstName) user.firstName = dto.firstName;
    if (dto.lastName) user.lastName = dto.lastName;
    if (dto.role) user.platformRole = dto.role;
    if (dto.isActive !== undefined) user.isActive = dto.isActive;
    await user.save();
    // Sin acceso: se cierran sus sesiones abiertas.
    if (dto.isActive === false) await this.sessions.revokeAllForUser(id);
    await this.audit.log({ action: 'platform.team_updated', actorUserId: actor.userId, entityType: 'User', entityId: id, metadata: { ...dto } });
    return (await this.list()).find((u) => u.id === id);
  }

  /** Cancela una invitación que nadie aceptó. A quien ya entró se le desactiva, no se le borra. */
  async remove(actor: Actor, id: string) {
    const user = await this.find(id);
    if (user.passwordHash) throw Errors.conflict('ALREADY_ACTIVE', 'Esta persona ya usó su cuenta. Desactívala en lugar de eliminarla.');
    await this.users.deleteById(id);
    await this.audit.log({ action: 'platform.team_invite_cancelled', actorUserId: actor.userId, entityType: 'User', entityId: id, metadata: { email: user.email } });
  }

  private async find(id: string): Promise<UserDocument> {
    const user = await this.users.findPlatformUser(id);
    if (!user) throw Errors.notFound('Persona');
    return user;
  }

  /** Devuelve también el enlace, por si el correo no llega y hay que pasarlo a mano. */
  private async sendInvite(actor: Actor, user: UserDocument) {
    const inviter = await this.users.findById(actor.userId);
    const { url, expiresAt } = await this.passwordReset.issueLink(user.id as string, INVITE_TTL_MS);
    const emailSent = await this.mail.send(
      platformInviteEmail({
        to: user.email,
        firstName: user.firstName,
        inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : 'El equipo de uBook',
        role: user.platformRole ?? 'support',
        url,
        expiresAt,
      }),
    );
    return { inviteUrl: url, expiresAt, emailSent };
  }
}
