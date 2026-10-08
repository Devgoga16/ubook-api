/**
 * Campos de una plantilla de ficha y su validación. Genérico: sirve para una
 * ficha de belleza, una nota de sesión de psicología o una de odontología.
 */
export const FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'multiselect', 'checkbox', 'date'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface RecordField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
  helpText?: string;
}

export type RecordValues = Record<string, string | number | boolean | string[] | null>;

const MAX_TEXT = 500;
const MAX_TEXTAREA = 10_000;

/** "Alergias o sensibilidades" → "alergias_o_sensibilidades". */
export function fieldKey(label: string): string {
  return (
    label
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'campo'
  );
}

/** Problemas en la definición de la plantilla (claves repetidas, listas sin opciones…). */
export function validateFields(fields: RecordField[]): string | null {
  if (fields.length === 0) return 'La plantilla necesita al menos un campo';
  const keys = new Set<string>();
  for (const f of fields) {
    if (keys.has(f.key)) return `Hay dos campos con la clave "${f.key}"`;
    keys.add(f.key);
    if ((f.type === 'select' || f.type === 'multiselect') && f.options.length < 2) {
      return `"${f.label}" necesita al menos dos opciones`;
    }
  }
  return null;
}

/**
 * Valida y limpia los valores contra los campos. Devuelve los valores
 * normalizados o un error por campo.
 */
export function validateValues(
  fields: RecordField[],
  input: Record<string, unknown>,
  { requireAll }: { requireAll: boolean },
): { values: RecordValues; errors: Record<string, string> } {
  const values: RecordValues = {};
  const errors: Record<string, string> = {};
  const known = new Set(fields.map((f) => f.key));
  for (const key of Object.keys(input)) if (!known.has(key)) errors[key] = 'Campo desconocido';

  for (const f of fields) {
    const v = input[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required && requireAll && f.type !== 'checkbox') errors[f.key] = 'Obligatorio';
      values[f.key] = f.type === 'checkbox' ? false : null;
      continue;
    }
    switch (f.type) {
      case 'text':
      case 'textarea': {
        const max = f.type === 'text' ? MAX_TEXT : MAX_TEXTAREA;
        if (typeof v !== 'string') errors[f.key] = 'Debe ser texto';
        else if (v.length > max) errors[f.key] = `Máximo ${max} caracteres`;
        else values[f.key] = v.trim();
        break;
      }
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) errors[f.key] = 'Debe ser un número';
        else values[f.key] = v;
        break;
      case 'checkbox':
        if (typeof v !== 'boolean') errors[f.key] = 'Debe ser sí o no';
        else values[f.key] = v;
        break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[f.key] = 'Fecha inválida';
        else values[f.key] = v;
        break;
      case 'select':
        if (typeof v !== 'string' || !f.options.includes(v)) errors[f.key] = 'Opción inválida';
        else values[f.key] = v;
        break;
      case 'multiselect':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !f.options.includes(x))) errors[f.key] = 'Opción inválida';
        else values[f.key] = [...new Set(v as string[])];
        break;
    }
  }
  return { values, errors };
}
