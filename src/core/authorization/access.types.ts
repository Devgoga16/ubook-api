import { PERMISSION_KEYS, type PermissionKey, type Scope } from './permissions.catalog.js';

/** Permisos efectivos de un miembro del staff en la petición actual. */
export interface StaffAccess {
  membershipId: string;
  userId: string;
  organizationId: string;
  isOwner: boolean;
  /** Sucursales asignadas; vacío = todas. */
  branchIds: string[];
  permissions: Partial<Record<PermissionKey, Scope>>;
}

/** Membresía ficticia de la vista de soporte: no coincide con ninguna real. */
export const SUPPORT_VIEW_MEMBERSHIP_ID = '000000000000000000000000';

/** Lo que nunca ve soporte, ni en solo lectura: el contenido de las fichas clínicas. */
const SUPPORT_VIEW_HIDDEN: PermissionKey[] = ['client_record.read', 'client_record.write'];

/**
 * Acceso de un agente de Unify Tec que entra a un negocio para dar soporte.
 * Ve todo el negocio salvo las fichas clínicas; las escrituras las bloquea AccessGuard.
 */
export function supportViewAccess(userId: string, organizationId: string): StaffAccess {
  const permissions: Partial<Record<PermissionKey, Scope>> = {};
  for (const key of PERMISSION_KEYS) {
    if (!SUPPORT_VIEW_HIDDEN.includes(key)) permissions[key] = 'organization';
  }
  return { membershipId: SUPPORT_VIEW_MEMBERSHIP_ID, userId, organizationId, isOwner: false, branchIds: [], permissions };
}
