/**
 * Funcionalidades que un plan puede incluir.
 * - flag:  activada o no.
 * - limit: número máximo; `null` = ilimitado.
 */
export const FEATURES = {
  max_branches: { type: 'limit', label: 'Sucursales' },
  max_professionals: { type: 'limit', label: 'Profesionales' },
  max_bookings_per_month: { type: 'limit', label: 'Reservas por mes' },

  public_booking_page: { type: 'flag', label: 'Página pública de reservas' },
  email_notifications: { type: 'flag', label: 'Notificaciones por email' },
  manual_payments: { type: 'flag', label: 'Registro de pagos' },
  client_records: { type: 'flag', label: 'Fichas clínicas / registros del cliente' },
  client_portal: { type: 'flag', label: 'Portal del cliente' },
  guardians: { type: 'flag', label: 'Responsables y beneficiarios' },
  resources: { type: 'flag', label: 'Recursos (salas, equipos)' },
  custom_roles: { type: 'flag', label: 'Roles y permisos personalizados' },
  custom_fields: { type: 'flag', label: 'Campos personalizados' },
  advanced_reports: { type: 'flag', label: 'Reportes completos' },
  branch_reports: { type: 'flag', label: 'Reportes por sucursal' },
  audit_log: { type: 'flag', label: 'Registro de auditoría' },
  branding: { type: 'flag', label: 'Marca propia (logo y colores)' },
  white_label: { type: 'flag', label: 'Sin marca uBook' },
  whatsapp: { type: 'flag', label: 'Notificaciones por WhatsApp' },
} as const satisfies Record<string, { type: 'flag' | 'limit'; label: string }>;

export type FeatureKey = keyof typeof FEATURES;
export type FeatureValue = boolean | number | null;
export type FeatureSet = Record<FeatureKey, FeatureValue>;

export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export function isFeatureKey(key: string): key is FeatureKey {
  return Object.prototype.hasOwnProperty.call(FEATURES, key);
}

export function isValidFeatureValue(key: FeatureKey, value: unknown): value is FeatureValue {
  return FEATURES[key].type === 'flag'
    ? typeof value === 'boolean'
    : value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

/** Valor que se asume si un plan no define la funcionalidad: desactivada / 0. */
export function defaultFeatureValue(key: FeatureKey): FeatureValue {
  return FEATURES[key].type === 'flag' ? false : 0;
}
