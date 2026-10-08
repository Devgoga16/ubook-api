import type { PermissionKey, Scope } from './permissions.catalog.js';

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
