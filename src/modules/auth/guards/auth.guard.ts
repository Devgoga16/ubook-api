import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import {
  ALLOWED_CONTEXTS,
  IS_PUBLIC,
  PLATFORM_ROLES,
} from '../../../core/auth/decorators.js';
import { Errors } from '../../../core/common/errors.js';
import {
  TenantContext,
  type AuthContextType,
  type PlatformRole,
} from '../../../core/tenancy/tenant-context.js';
import type { AccessTokenPayload } from '../../identity/sessions.service.js';
import { UsersService } from '../../identity/users.service.js';

/**
 * Valida el access token, carga el actor y la organización en el contexto
 * de la petición y verifica que el tipo de sesión sea el que pide el endpoint.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const token = extractBearer(context.switchToHttp().getRequest<Request>());
    if (!token) throw Errors.unauthorized();

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw Errors.unauthorized('Sesión expirada');
    }

    const allowed = this.reflector.getAllAndOverride<AuthContextType[]>(ALLOWED_CONTEXTS, targets) ?? [
      'staff',
    ];
    if (!allowed.includes(payload.ctx)) throw Errors.wrongContext();

    let platformRole: PlatformRole | null = null;
    if (payload.ctx === 'platform') {
      // El rol de plataforma se lee siempre de la BD para que una revocación sea inmediata.
      const user = await this.users.findById(payload.sub);
      if (!user?.isActive || !user.platformRole) throw Errors.unauthorized();
      platformRole = user.platformRole;
    }

    const requiredPlatformRoles = this.reflector.getAllAndOverride<PlatformRole[]>(PLATFORM_ROLES, targets);
    if (requiredPlatformRoles && (!platformRole || !requiredPlatformRoles.includes(platformRole))) {
      throw Errors.forbidden();
    }

    TenantContext.setActor({
      userId: payload.sub,
      sessionId: payload.sid,
      ctx: payload.ctx,
      organizationId: payload.org,
      membershipId: payload.mid,
      platformRole,
    });
    if (payload.ctx === 'staff' && payload.org) TenantContext.setOrganizationId(payload.org);
    return true;
  }
}

function extractBearer(request: Request): string | undefined {
  const [type, token] = request.headers.authorization?.split(' ') ?? [];
  return type === 'Bearer' && token ? token : undefined;
}
