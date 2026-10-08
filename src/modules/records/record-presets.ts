import { fieldKey, type FieldType, type RecordField } from './record-fields.js';

/** Plantillas listas para usar. El negocio las copia y luego las adapta. */
type PresetField = [label: string, type: FieldType, opts?: { required?: boolean; options?: string[]; helpText?: string }];

function build(fields: PresetField[]): RecordField[] {
  return fields.map(([label, type, o = {}]) => ({
    key: fieldKey(label),
    label,
    type,
    required: o.required ?? false,
    options: o.options ?? [],
    helpText: o.helpText,
  }));
}

export const RECORD_PRESETS: Array<{ key: string; name: string; description: string; fields: RecordField[] }> = [
  {
    key: 'general',
    name: 'Ficha general',
    description: 'Para cualquier servicio: motivo, observaciones y recomendaciones.',
    fields: build([
      ['Motivo de la visita', 'textarea', { required: true }],
      ['Observaciones', 'textarea'],
      ['Recomendaciones', 'textarea'],
      ['Próximo control', 'date'],
    ]),
  },
  {
    key: 'beauty',
    name: 'Ficha de belleza',
    description: 'Barbería, salón o uñas: tipo de cabello, químicos, alergias y fórmulas.',
    fields: build([
      ['Tipo de cabello', 'select', { options: ['Liso', 'Ondulado', 'Rizado', 'Afro'] }],
      ['Alergias o sensibilidades', 'textarea', { required: true, helpText: 'Escribe "Ninguna" si no tiene' }],
      ['Tratamientos químicos previos', 'textarea'],
      ['Fórmula de color', 'text', { helpText: 'Ej.: 7.1 + 20 vol, 35 min' }],
      ['Productos usados', 'text'],
      ['Resultado y observaciones', 'textarea'],
    ]),
  },
  {
    key: 'psychology',
    name: 'Nota de sesión (psicología)',
    description: 'Registro clínico por sesión: tema, estado, intervenciones y riesgo.',
    fields: build([
      ['Tema de la sesión', 'textarea', { required: true }],
      ['Estado de ánimo', 'select', { options: ['Muy bajo', 'Bajo', 'Neutral', 'Bueno', 'Muy bueno'] }],
      ['Intervenciones realizadas', 'textarea'],
      ['Observaciones clínicas', 'textarea'],
      ['Tareas para la próxima sesión', 'textarea'],
      ['Nivel de riesgo', 'select', { required: true, options: ['Sin riesgo', 'Bajo', 'Moderado', 'Alto'] }],
    ]),
  },
  {
    key: 'dental',
    name: 'Odontología',
    description: 'Motivo, piezas tratadas, procedimiento e indicaciones.',
    fields: build([
      ['Motivo de consulta', 'textarea', { required: true }],
      ['Piezas tratadas', 'text', { helpText: 'Ej.: 1.6, 2.4' }],
      ['Procedimiento', 'textarea'],
      ['Se aplicó anestesia', 'checkbox'],
      ['Indicaciones post-tratamiento', 'textarea'],
      ['Próximo control', 'date'],
    ]),
  },
];
