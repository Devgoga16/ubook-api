import type { FlowKey } from './automation.schemas.js';

/** Variables disponibles en los mensajes. */
export const VARIABLES = [
  'cliente.nombre',
  'negocio',
  'servicio',
  'profesional',
  'cita.fecha',
  'cita.hora',
  'sucursal',
  'sucursal.direccion',
  'link.gestionar',
  'link.reservar',
  'link.resena',
  'cupon',
] as const;
export type Variable = (typeof VARIABLES)[number];
export type MessageVars = Partial<Record<Variable, string>>;

/** Mensajes por defecto (cálidos, cortos y en español de Perú). */
export const DEFAULT_MESSAGES: Record<FlowKey, string> = {
  reminder:
    'Hola {{cliente.nombre}}, te recordamos tu cita de {{servicio}} el {{cita.fecha}} a las {{cita.hora}} con {{profesional}} en {{sucursal.direccion}}. Si necesitas cambiarla: {{link.gestionar}}',
  confirmation:
    'Hola {{cliente.nombre}}, tu cita de {{servicio}} quedó agendada para el {{cita.fecha}} a las {{cita.hora}} con {{profesional}}. Te esperamos en {{negocio}}. Ver o cambiar: {{link.gestionar}}',
  review:
    '¡Gracias por visitarnos, {{cliente.nombre}}! ¿Nos ayudas con una reseña? Nos toma un minuto leerla y a otros clientes les ayuda mucho: {{link.resena}}',
  reactivation:
    'Hola {{cliente.nombre}}, ¡te extrañamos en {{negocio}}! Reserva tu próxima cita cuando quieras: {{link.reservar}}',
  birthday: '¡Feliz cumpleaños, {{cliente.nombre}}! 🎉 Todo el equipo de {{negocio}} te desea un gran día.',
  noShow:
    'Hola {{cliente.nombre}}, te esperábamos hoy a las {{cita.hora}} para tu cita de {{servicio}}. ¿Quieres reprogramarla? {{link.reservar}}',
};

/** Texto extra cuando el flujo ofrece un cupón. */
export const PROMO_SUFFIX = ' Usa el cupón {{cupon}} en tu próxima reserva: {{link.reservar}}';

/** Reemplaza {{variable}}; una variable sin valor queda vacía y se limpian espacios dobles. */
export function renderMessage(template: string, vars: MessageVars): string {
  return template
    .replace(/\{\{\s*([a-z.]+)\s*\}\}/gi, (_, name: string) => vars[name as Variable] ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}

/** Variables que el texto usa y no existen (para avisar en el editor). */
export function unknownVariables(template: string): string[] {
  const used = [...template.matchAll(/\{\{\s*([a-z.]+)\s*\}\}/gi)].map((m) => m[1]!);
  return [...new Set(used.filter((v) => !(VARIABLES as readonly string[]).includes(v)))];
}
