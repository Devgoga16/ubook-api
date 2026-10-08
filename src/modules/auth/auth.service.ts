import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service.js';
import { Errors } from '../../core/common/errors.js';
import { TenantContext, type Actor } from '../../core/tenancy/tenant-context.js';
import {
  SessionsService,
  type ClientInfo,
  type IssuedTokens,
  type SessionContext,
} from '../identity/sessions.service.js';
import { UsersService } from '../identity/users.service.js';
import { AccessControlService } from '../organization/access-control.service.js';
import type { AcceptInvitationDto } from '../organization/dto/invitation.dto.js';
import { InvitationsService } from '../organization/invitations.service.js';
import { OrganizationsService } from '../organization/organizations.service.js';
import { EntitlementsService } from '../platform/entitlements.service.js';
import type { CreateOrganizationDto } from '../organization/dto/organization.dto.js';
import type { LoginDto, RegisterDto } from './dto/auth.dto.js';

export interface AuthResult {
  tokens: IssuedTokens;
  context: SessionContext;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly organizations: OrganizationsService,
    private readonly accessControl: AccessControlService,
    private readonly entitlements: EntitlementsService,
    private readonly invitations: InvitationsService,
    private readonly audit: AuditService,
  ) {}

  async register(dto: RegisterDto, client: ClientInfo): Promise<AuthResult> {
    const { user, organization, membership } = await this.organizations.transaction(async (session) => {
      const user = await this.users.create(dto, session);
      const created = await this.organizations.createWithOwner(user.id as string, dto.organization, session);
      return { user, ...created };
    });

    const context: SessionContext = {
      ctx: 'staff',
      organizationId: organization.id as string,
      membershipId: membership.id as string,
    };
    const tokens = await this.sessions.start(user.id as string, context, client);
    return { tokens, context };
  }

  /**
   * - Equipo de plataforma → sesión `platform`.
   * - Staff de un solo negocio → entra directo a ese negocio.
   * - Varios negocios o ninguno → sesión `account` (elige o crea negocio).
   */
  async login(dto: LoginDto, client: ClientInfo): Promise<AuthResult> {
    const user = await this.users.verifyCredentials(dto.email, dto.password);
    if (!user) {
      await this.audit.log({ action: 'auth.login_failed', metadata: { email: dto.email, ip: client.ip } });
      throw Errors.invalidCredentials();
    }

    let context: SessionContext = { ctx: 'account' };
    if (user.platformRole) {
      context = { ctx: 'platform' };
    } else {
      const orgs = await this.accessControl.listUserOrganizations(user.id as string);
      if (orgs.length === 1) {
        context = { ctx: 'staff', organizationId: orgs[0].organizationId, membershipId: orgs[0].membershipId };
      }
    }

    const tokens = await this.sessions.start(user.id as string, context, client);
    await this.users.touchLogin(user.id as string);
    await this.audit.log({
      action: 'auth.login',
      actorUserId: user.id as string,
      organizationId: context.organizationId,
      metadata: { ctx: context.ctx, ip: client.ip },
    });
    return { tokens, context };
  }

  /** Acepta una invitación y entra directo al negocio que invitó. */
  async acceptInvitation(dto: AcceptInvitationDto, client: ClientInfo): Promise<AuthResult> {
    const { userId, organizationId, membershipId } = await this.invitations.accept(dto);
    const context: SessionContext = { ctx: 'staff', organizationId, membershipId };
    const tokens = await this.sessions.start(userId, context, client);
    await this.users.touchLogin(userId);
    return { tokens, context };
  }

  async refresh(refreshToken: string, client: ClientInfo): Promise<AuthResult> {
    const { tokens, context } = await this.sessions.rotate(refreshToken, client);
    return { tokens, context };
  }

  logout(refreshToken: string): Promise<void> {
    return this.sessions.revoke(refreshToken);
  }

  /** Cambia la sesión actual a otro negocio donde el usuario es staff. */
  async switchOrganization(
    actor: Actor,
    organizationId: string,
    refreshToken: string,
    client: ClientInfo,
  ): Promise<AuthResult> {
    const membership = await this.accessControl.findActiveMembership(actor.userId, organizationId);
    if (!membership) throw Errors.forbidden('No perteneces a ese negocio');

    const context: SessionContext = {
      ctx: 'staff',
      organizationId,
      membershipId: membership.id as string,
    };
    const { userId, tokens } = await this.sessions.rotate(refreshToken, client, context);
    if (userId !== actor.userId) throw Errors.unauthorized();
    return { tokens, context };
  }

  /** Crea otro negocio para un usuario ya registrado y entra en él. */
  async createOrganization(
    actor: Actor,
    dto: CreateOrganizationDto,
    refreshToken: string,
    client: ClientInfo,
  ): Promise<AuthResult> {
    const { organization } = await this.organizations.transaction((session) =>
      this.organizations.createWithOwner(actor.userId, dto, session),
    );
    return this.switchOrganization(actor, organization.id as string, refreshToken, client);
  }

  /** Datos para iniciar el frontend: usuario, negocios, permisos y plan. */
  async me(actor: Actor) {
    const user = await this.users.findById(actor.userId);
    if (!user) throw Errors.unauthorized();
    const organizations = await this.accessControl.listUserOrganizations(actor.userId);

    const base = {
      user,
      context: { ctx: actor.ctx, organizationId: actor.organizationId ?? null },
      organizations,
    };
    if (actor.ctx !== 'staff' || !actor.organizationId) return base;

    const access = TenantContext.getAccess();
    const [organization, entitlements] = await Promise.all([
      this.organizations.currentView(),
      this.entitlements.get(actor.organizationId),
    ]);
    return {
      ...base,
      organization,
      access: access && {
        membershipId: access.membershipId,
        isOwner: access.isOwner,
        branchIds: access.branchIds,
        permissions: access.permissions,
      },
      subscription: entitlements,
    };
  }
}
