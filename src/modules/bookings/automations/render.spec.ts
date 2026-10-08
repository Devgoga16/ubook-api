import { DEFAULT_MESSAGES, renderMessage, unknownVariables } from './render.js';

describe('Mensajes de automatizaciones', () => {
  it('reemplaza variables y limpia las que no tienen valor', () => {
    expect(renderMessage('Hola {{cliente.nombre}}, tu cita es a las {{ cita.hora }}.', { 'cliente.nombre': 'Ana', 'cita.hora': '15:00' })).toBe(
      'Hola Ana, tu cita es a las 15:00.',
    );
    expect(renderMessage('Hola {{cliente.nombre}} {{cupon}} .', { 'cliente.nombre': 'Ana' })).toBe('Hola Ana.');
  });

  it('detecta variables mal escritas', () => {
    expect(unknownVariables('Hola {{cliente.nombre}} {{cliente.apellido}} {{cita.hora}}')).toEqual(['cliente.apellido'])
    for (const text of Object.values(DEFAULT_MESSAGES)) expect(unknownVariables(text)).toEqual([])
  });
});
