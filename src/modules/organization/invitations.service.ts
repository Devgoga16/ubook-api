import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import type { Model } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { OWNER_ROLE_KEY } from '../../core/authorization/permissions.catalog.js';
import { AppError, Errors } from '../../core/common/errors.js';
import { MailService } from '../../core/mail/mail.service.js';
import { invitationEmail } from '../../core/mail/templates.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { User } from '../identity/schemas/user.schema.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import type { AcceptInvitationDto, CreateInvitationDto } from './dto/invitation.dto.js';
import { OrganizationsService } from './organizations.service.js';
import { Branch } from './schemas/branch.schema.js';
import { Invitation, type InvitationDocument } from './schemas/invitation.schema.js';
import { Membership } from './schemas/membership.schema.js';
import { Organization } from './schemas/organization.schema.js';
import { Role } from './schemas/role.schema.js';

const VALID_DAYS = 7;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
/** Mínimo 10 caracteres con letras y números (igual que el registro). */
const STRONG_PASSWORD = /^(?=.*[A-Za-z])(?=.*\d).{10,}$/;

export interface InvitationCreated {
  invitation: InvitationDocument;
  /** Enlace para compartir también por WhatsApp. Solo se entrega al crear o reenviar. */
  inviteUrl: string;
  emailSent: boolean;
}

@Injectable()
export class InvitationsService {
  constructor(
    @InjectModel(Invitation.name) private readonly invitations: Model<Invitation>,
    @InjectModel(Membership.name) private readonly memberships: Model<Membership>,
    @InjectModel(Role.name) private readonly roles: Model<Role>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly orgs: OrganizationsService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  /* ---------- Dentro del negocio ---------- */

  listPending(): Promise<InvitationDocument[]> {
    return this.invitations.find({ status: 'pending' }).sort({ createdAt: -1 }).exec();
  }

  async create(dto: CreateInvitationDto): Promise<InvitationCreated> {
    await this.assertRoles(dto.roleIds);
    if (dto.branchIds?.length && (await this.branches.countDocuments({ _id: { $in: dto.branchIds } })) !== dto.branchIds.length) {
      throw Errors.badRequest('INVALID_BRANCH', 'Sucursal inválida');
    }
    if (dto.professionalId) {
      const pro = await this.professionals.findById(dto.professionalId).select('membershipId').exec();
      if (!pro) throw Errors.badRequest('INVALID_PROFESSIONAL', 'Profesional inválido');
      if (pro.membershipId) throw Errors.conflict('PROFESSIONAL_HAS_ACCESS', 'Ese profesional ya tiene acceso');
    }

    const user = await this.users.findOne({ email: dto.email }).select('_id').exec();
    if (user) {
      const member = await this.memberships.findOne({ userId: user._id }).exec();
      if (member?.status === 'active') throw Errors.conflict('ALREADY_MEMBER', 'Esa persona ya es parte del equipo');
      if (member?.status === 'suspended') {
        throw Errors.conflict('MEMBER_SUSPENDED', 'Esa persona está suspendida: reactívala desde su perfil en Equipo');
      }
    }

    // Invitar de nuevo al mismo correo reemplaza la invitación anterior.
    await this.invitations.updateMany({ email: dto.email, status: 'pending' }, { status: 'revoked' }).exec();

    const token = randomBytes(32).toString('base64url');
    const invitation = await this.invitations.create({
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName ?? '',
      roleIds: dto.roleIds,
      branchIds: dto.branchIds ?? [],
      professionalId: dto.professionalId ?? null,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + VALID_DAYS * 86_400_000),
      invitedByUserId: TenantContext.getActor()!.userId,
    });
    await this.audit.log({
      action: 'invitation.created',
      entityType: 'Invitation',
      entityId: invitation.id as string,
      metadata: { email: dto.email, roleIds: dto.roleIds },
    });
    return { invitation, ...(await this.deliver(invitation, token)) };
  }

  /** Nuevo enlace y nueva fecha de vencimiento; el enlace anterior deja de servir. */
  async resend(id: string): Promise<InvitationCreated> {
    const invitation = await this.invitations.findOne({ _id: id, status: 'pending' }).exec();
    if (!invitation) throw Errors.notFound('Invitación');
    const token = randomBytes(32).toString('base64url');
    invitation.tokenHash = hashToken(token);
    invitation.expiresAt = new Date(Date.now() + VALID_DAYS * 86_400_000);
    await invitation.save();
    await this.audit.log({ action: 'invitation.resent', entityType: 'Invitation', entityId: id });
    return { invitation, ...(await this.deliver(invitation, token)) };
  }

  async revoke(id: string): Promise<void> {
    const res = await this.invitations.updateOne({ _id: id, status: 'pending' }, { status: 'revoked' }).exec();
    if (res.matchedCount === 0) throw Errors.notFound('Invitación');
    await this.audit.log({ action: 'invitation.revoked', entityType: 'Invitation', entityId: id });
  }

  /* ---------- Página pública de la invitación ---------- */

  async preview(token: string) {
    const invitation = await this.findUsable(token);
    return TenantContext.runForOrganization(invitation.organizationId.toString(), async () => {
      const [org, roles, account] = await Promise.all([
        this.organizations.findById(invitation.organizationId).select('name').exec(),
        this.roles.find({ _id: { $in: invitation.roleIds } }).select('name').exec(),
        this.users.exists({ email: invitation.email }),
      ]);
      return {
        organizationName: org?.name ?? '',
        email: invitation.email,
        firstName: invitation.firstName,
        lastName: invitation.lastName,
        roleNames: roles.map((r) => r.name),
        expiresAt: invitation.expiresAt,
        accountExists: !!account,
      };
    });
  }

  /**
   * Acepta la invitación: crea la cuenta (o verifica la contraseña de la
   * existente) y la membresía. El correo ya quedó verificado por el enlace.
   */
  async accept(dto: AcceptInvitationDto): Promise<{ userId: string; organizationId: string; membershipId: string }> {
    const invitation = await this.findUsable(dto.token);
    const organizationId = invitation.organizationId.toString();

    const existing = await this.users.findOne({ email: invitation.email }).select('+passwordHash isActive').exec();
    if (existing) {
      const ok = existing.isActive && !!existing.passwordHash && (await argon2.verify(existing.passwordHash, dto.password));
      if (!ok) throw Errors.invalidCredentials();
    } else {
      const fields: Record<string, string[]> = {};
      if (!STRONG_PASSWORD.test(dto.password)) fields.password = ['Mínimo 10 caracteres, con letras y números'];
      if (!(dto.firstName ?? invitation.firstName)) fields.firstName = ['Escribe tu nombre'];
      if (!(dto.lastName ?? invitation.lastName)) fields.lastName = ['Escribe tu apellido'];
      if (Object.keys(fields).length) throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_ERROR', 'Revisa los datos', { fields });
    }

    const result = await this.orgs.transaction((session) =>
      TenantContext.runForOrganization(organizationId, async () => {
        const user =
          existing ??
          (
            await this.users.create(
              [
                {
                  email: invitation.email,
                  firstName: dto.firstName ?? invitation.firstName,
                  lastName: dto.lastName ?? invitation.lastName,
                  passwordHash: await argon2.hash(dto.password, { type: argon2.argon2id }),
                },
              ],
              { session },
            )
          )[0]!;

        // Marcar primero: si dos pestañas aceptan a la vez, solo una pasa.
        const claimed = await this.invitations
          .updateOne(
            { _id: invitation._id, status: 'pending' },
            { status: 'accepted', acceptedAt: new Date(), acceptedByUserId: user._id },
            { session },
          )
          .exec();
        if (claimed.modifiedCount === 0) throw Errors.badRequest('INVITATION_INVALID', 'Esta invitación ya no es válida');

        let membership = await this.memberships.findOne({ userId: user._id }).session(session).exec();
        if (membership?.status === 'suspended') {
          throw Errors.forbidden('Tu acceso a este negocio está suspendido');
        }
        if (!membership) {
          [membership] = await this.memberships.create(
            [{ userId: user._id, roleIds: invitation.roleIds, branchIds: invitation.branchIds, status: 'active' }],
            { session },
          );
        }
        if (invitation.professionalId) {
          await this.professionals
            .updateOne({ _id: invitation.professionalId, membershipId: null }, { membershipId: membership!._id }, { session })
            .exec();
        }
        return { userId: user.id as string, membershipId: membership!.id as string };
      }),
    );

    await TenantContext.runForOrganization(organizationId, () =>
      this.audit.log({
        action: 'invitation.accepted',
        actorUserId: result.userId,
        entityType: 'Invitation',
        entityId: invitation.id as string,
        metadata: { newAccount: !existing },
      }),
    );
    return { ...result, organizationId };
  }

  /* ---------- Internos ---------- */

  private async findUsable(token: string): Promise<InvitationDocument> {
    const invitation = await TenantContext.runAsSystem(() => this.invitations.findOne({ tokenHash: hashToken(token) }).exec());
    if (!invitation || invitation.status !== 'pending') {
      throw Errors.badRequest('INVITATION_INVALID', 'Esta invitación ya no es válida. Pide que te inviten de nuevo.');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw Errors.badRequest('INVITATION_EXPIRED', 'Esta invitación venció. Pide que te la reenvíen.');
    }
    return invitation;
  }

  /** Solo el Dueño puede invitar a otro Dueño. */
  private async assertRoles(roleIds: string[]): Promise<void> {
    const roles = await this.roles.find({ _id: { $in: roleIds } }).select('templateKey').exec();
    if (roles.length !== roleIds.length) throw Errors.badRequest('INVALID_ROLE', 'Rol inválido');
    if (roles.some((r) => r.templateKey === OWNER_ROLE_KEY) && !TenantContext.getAccess()?.isOwner) {
      throw Errors.forbidden('Solo el Dueño puede invitar a otro Dueño');
    }
  }

  private async deliver(invitation: InvitationDocument, token: string): Promise<{ inviteUrl: string; emailSent: boolean }> {
    const inviteUrl = this.mail.appUrl(`/invitacion/${token}`);
    const [org, roles, inviter] = await Promise.all([
      this.organizations.findById(invitation.organizationId).select('name').exec(),
      this.roles.find({ _id: { $in: invitation.roleIds } }).select('name').exec(),
      this.users.findById(TenantContext.getActor()!.userId).select('firstName lastName').exec(),
    ]);
    const emailSent = await this.mail.send(
      invitationEmail({
        to: invitation.email,
        firstName: invitation.firstName,
        organizationName: org?.name ?? 'uBook',
        inviterName: inviter ? `${inviter.firstName} ${inviter.lastName}`.trim() : 'Tu equipo',
        roleName: roles.map((r) => r.name).join(', '),
        url: inviteUrl,
        expiresAt: invitation.expiresAt,
      }),
    );
    return { inviteUrl, emailSent };
  }
}
