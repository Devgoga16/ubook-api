import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { PermissionKey } from '../authorization/permissions.catalog.js';
import type { FeatureKey } from '../../modules/platform/features.catalog.js';
import { TenantContext, type Actor, type AuthContextType, type PlatformRole } from '../tenancy/tenant-context.js';

export const IS_PUBLIC = 'auth:isPublic';
export const ALLOWED_CONTEXTS = 'auth:contexts';
export const PLATFORM_ROLES = 'auth:platformRoles';
export const REQUIRED_PERMISSION = 'access:permission';
export const REQUIRED_FEATURE = 'access:feature';
export const ALLOW_WHEN_READ_ONLY = 'access:allowReadOnly';

/** Endpoint sin autenticación. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Contextos de sesión aceptados. Por defecto solo `staff`
 * (usuario operando dentro de una organización).
 */
export const AllowContexts = (...contexts: AuthContextType[]) =>
  SetMetadata(ALLOWED_CONTEXTS, contexts);

/** Endpoint exclusivo del equipo de plataforma (Unify Tec). */
export const PlatformOnly = (...roles: PlatformRole[]) =>
  SetMetadata(PLATFORM_ROLES, roles.length ? roles : ['super_admin']);

export const RequirePermission = (permission: PermissionKey) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/** Requiere que el plan del negocio incluya la funcionalidad. */
export const RequireFeature = (feature: FeatureKey) => SetMetadata(REQUIRED_FEATURE, feature);

/** Permite escrituras aunque la suscripción esté vencida (p. ej. renovar). */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_WHEN_READ_ONLY, true);

export const CurrentActor = createParamDecorator(
  (_data: unknown, _ctx: ExecutionContext): Actor => {
    const actor = TenantContext.getActor();
    if (!actor) throw new Error('CurrentActor usado en un endpoint público');
    return actor;
  },
);
