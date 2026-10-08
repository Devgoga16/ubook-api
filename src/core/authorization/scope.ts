import { Errors } from '../common/errors.js';
import { TenantContext } from '../tenancy/tenant-context.js';
import type { PermissionKey, Scope } from './permissions.catalog.js';

/** Datos mínimos de un recurso para decidir si cae en el alcance del permiso. */
export interface ScopedTarget {
  /** Membresía "dueña" del recurso (p. ej. el profesional vinculado al usuario). */
  ownerMembershipId?: string | null;
  /** Sucursales a las que pertenece el recurso. */
  branchIds?: string[];
}

export function currentScope(permission: PermissionKey): Scope | undefined {
  return TenantContext.getAccess()?.permissions[permission];
}

/**
 * ¿El usuario puede aplicar `permission` sobre este recurso?
 * - organization: todo el negocio.
 * - branch: si comparte alguna sucursal (miembro sin sucursales = todas).
 * - own: solo lo vinculado a su membresía.
 */
export function canActOn(permission: PermissionKey, target: ScopedTarget): boolean {
  const access = TenantContext.getAccess();
  const scope = access?.permissions[permission];
  if (!access || !scope) return false;
  if (scope === 'organization') return true;
  if (scope === 'branch') {
    if (access.branchIds.length === 0) return true;
    return (target.branchIds ?? []).some((b) => access.branchIds.includes(b));
  }
  return !!target.ownerMembershipId && target.ownerMembershipId === access.membershipId;
}

export function assertCanActOn(permission: PermissionKey, target: ScopedTarget): void {
  if (!canActOn(permission, target)) throw Errors.forbidden();
}
