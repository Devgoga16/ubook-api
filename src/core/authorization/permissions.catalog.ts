/**
 * Catálogo de permisos. Lo define el código y es estable: los negocios no
 * crean permisos, solo los combinan en roles y eligen el alcance.
 *
 * Alcance (scope):
 * - own:          solo lo propio (sus citas, los clientes que atiende).
 * - branch:       lo de las sucursales asignadas al miembro.
 * - organization: todo el negocio.
 */
export const SCOPES = ['own', 'branch', 'organization'] as const;
export type Scope = (typeof SCOPES)[number];

const ALL: Scope[] = ['own', 'branch', 'organization'];
const BRANCH_UP: Scope[] = ['branch', 'organization'];
const ORG: Scope[] = ['organization'];

interface PermissionDefinition {
  group: string;
  label: string;
  scopes: Scope[];
}

export const PERMISSIONS = {
  'organization.manage': { group: 'Negocio', label: 'Editar datos y ajustes del negocio', scopes: ORG },
  'subscription.manage': { group: 'Negocio', label: 'Gestionar la suscripción', scopes: ORG },
  'branch.manage': { group: 'Negocio', label: 'Crear y editar sucursales', scopes: ORG },
  'audit.read': { group: 'Negocio', label: 'Ver registro de auditoría', scopes: ORG },

  'member.read': { group: 'Equipo', label: 'Ver miembros del equipo', scopes: BRANCH_UP },
  'member.manage': { group: 'Equipo', label: 'Invitar y gestionar miembros', scopes: ORG },
  'role.read': { group: 'Equipo', label: 'Ver roles', scopes: ORG },
  'role.manage': { group: 'Equipo', label: 'Crear y editar roles', scopes: ORG },

  'professional.read': { group: 'Profesionales', label: 'Ver profesionales', scopes: BRANCH_UP },
  'professional.manage': { group: 'Profesionales', label: 'Gestionar profesionales', scopes: BRANCH_UP },

  'service.read': { group: 'Catálogo', label: 'Ver servicios', scopes: ORG },
  'service.manage': { group: 'Catálogo', label: 'Gestionar servicios', scopes: ORG },
  'resource.read': { group: 'Catálogo', label: 'Ver recursos', scopes: BRANCH_UP },
  'resource.manage': { group: 'Catálogo', label: 'Gestionar recursos', scopes: BRANCH_UP },

  'schedule.read': { group: 'Agenda', label: 'Ver horarios', scopes: ALL },
  'schedule.manage': { group: 'Agenda', label: 'Gestionar horarios y bloqueos', scopes: ALL },

  'booking.read': { group: 'Reservas', label: 'Ver reservas', scopes: ALL },
  'booking.create': { group: 'Reservas', label: 'Crear reservas', scopes: ALL },
  'booking.update': { group: 'Reservas', label: 'Modificar reservas', scopes: ALL },
  'booking.cancel': { group: 'Reservas', label: 'Cancelar reservas', scopes: ALL },

  'client.read': { group: 'Clientes', label: 'Ver clientes', scopes: ALL },
  'client.create': { group: 'Clientes', label: 'Registrar clientes', scopes: BRANCH_UP },
  'client.update': { group: 'Clientes', label: 'Editar clientes', scopes: ALL },
  'client.delete': { group: 'Clientes', label: 'Eliminar clientes', scopes: ORG },
  'client_record.read': { group: 'Fichas', label: 'Ver fichas clínicas', scopes: ['own', 'organization'] },
  'client_record.write': { group: 'Fichas', label: 'Escribir en fichas clínicas', scopes: ['own', 'organization'] },

  'payment.read': { group: 'Pagos', label: 'Ver pagos', scopes: ALL },
  'payment.create': { group: 'Pagos', label: 'Registrar pagos', scopes: BRANCH_UP },
  'payment.void': { group: 'Pagos', label: 'Anular pagos', scopes: ORG },

  'report.view': { group: 'Reportes', label: 'Ver reportes', scopes: BRANCH_UP },
} as const satisfies Record<string, PermissionDefinition>;

export type PermissionKey = keyof typeof PERMISSIONS;

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(key: string): key is PermissionKey {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, key);
}

export function isScopeAllowed(key: PermissionKey, scope: Scope): boolean {
  return (PERMISSIONS[key].scopes as readonly Scope[]).includes(scope);
}

export function broaderScope(a: Scope, b: Scope): Scope {
  return SCOPES.indexOf(a) >= SCOPES.indexOf(b) ? a : b;
}

export interface RolePermission {
  key: PermissionKey;
  scope: Scope;
}

function grant(scope: Scope, keys: PermissionKey[]): RolePermission[] {
  return keys.map((key) => ({
    key,
    scope: isScopeAllowed(key, scope) ? scope : (PERMISSIONS[key].scopes[0] as Scope),
  }));
}

export const OWNER_ROLE_KEY = 'owner';

/** Roles que se crean con cada organización. El negocio puede editarlos (salvo Dueño). */
export const DEFAULT_ROLE_TEMPLATES: Array<{
  key: string;
  name: string;
  description: string;
  permissions: RolePermission[];
}> = [
  {
    key: OWNER_ROLE_KEY,
    name: 'Dueño',
    description: 'Acceso total al negocio. No se puede editar ni eliminar.',
    permissions: grant('organization', PERMISSION_KEYS),
  },
  {
    key: 'admin',
    name: 'Administrador',
    description: 'Gestiona todo el negocio salvo la suscripción.',
    permissions: grant(
      'organization',
      PERMISSION_KEYS.filter((k) => k !== 'subscription.manage'),
    ),
  },
  {
    key: 'receptionist',
    name: 'Recepción',
    description: 'Agenda, clientes y cobros de sus sucursales.',
    permissions: grant('branch', [
      'professional.read',
      'service.read',
      'resource.read',
      'schedule.read',
      'booking.read',
      'booking.create',
      'booking.update',
      'booking.cancel',
      'client.read',
      'client.create',
      'client.update',
      'payment.read',
      'payment.create',
    ]),
  },
  {
    key: 'professional',
    name: 'Profesional',
    description: 'Ve y gestiona solo su agenda, sus clientes y sus fichas.',
    permissions: grant('own', [
      'service.read',
      'schedule.read',
      'schedule.manage',
      'booking.read',
      'booking.create',
      'booking.update',
      'client.read',
      'client_record.read',
      'client_record.write',
      'payment.read',
    ]),
  },
];
