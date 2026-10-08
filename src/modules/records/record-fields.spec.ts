import { fieldKey, validateFields, validateValues, type RecordField } from './record-fields.js';
import { RECORD_PRESETS } from './record-presets.js';

const fields: RecordField[] = [
  { key: 'tema', label: 'Tema', type: 'textarea', required: true, options: [] },
  { key: 'animo', label: 'Ánimo', type: 'select', required: false, options: ['Bajo', 'Bueno'] },
  { key: 'tags', label: 'Etiquetas', type: 'multiselect', required: false, options: ['A', 'B'] },
  { key: 'anestesia', label: 'Anestesia', type: 'checkbox', required: true, options: [] },
  { key: 'control', label: 'Control', type: 'date', required: false, options: [] },
  { key: 'dosis', label: 'Dosis', type: 'number', required: false, options: [] },
];

describe('Campos de fichas', () => {
  it('genera claves estables desde la etiqueta', () => {
    expect(fieldKey('Alergias o sensibilidades')).toBe('alergias_o_sensibilidades');
    expect(fieldKey('Próximo control')).toBe('proximo_control');
  });

  it('valida la definición de la plantilla', () => {
    expect(validateFields([])).toMatch(/al menos un campo/);
    expect(validateFields([fields[0]!, fields[0]!])).toMatch(/dos campos/);
    expect(validateFields([{ ...fields[1]!, options: ['Uno'] }])).toMatch(/dos opciones/);
    for (const p of RECORD_PRESETS) expect(validateFields(p.fields)).toBeNull();
  });

  it('valida y normaliza valores', () => {
    const ok = validateValues(fields, { tema: '  Ansiedad  ', animo: 'Bajo', tags: ['A', 'A'], anestesia: true, dosis: 2 }, { requireAll: true });
    expect(ok.errors).toEqual({});
    expect(ok.values).toEqual({ tema: 'Ansiedad', animo: 'Bajo', tags: ['A'], anestesia: true, control: null, dosis: 2 });

    const bad = validateValues(fields, { animo: 'Feliz', tags: ['C'], control: '12/10/2026', dosis: 'dos', extra: 1 }, { requireAll: true });
    expect(Object.keys(bad.errors).sort()).toEqual(['animo', 'control', 'dosis', 'extra', 'tags', 'tema'].sort());
  });

  it('en borrador no exige obligatorios', () => {
    expect(validateValues(fields, {}, { requireAll: false }).errors).toEqual({});
  });
});
