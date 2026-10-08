import { findCrossBranchOverlap, normalizeDays, validateDays } from './weekly-schedule.js';

const h = (hh: number, mm = 0) => hh * 60 + mm;

describe('Horario semanal', () => {
  it('acepta bloques con descanso entre medio', () => {
    expect(validateDays([{ weekday: 1, intervals: [{ start: h(9), end: h(13) }, { start: h(14), end: h(19) }] }])).toBeNull();
  });

  it('rechaza cruces, días repetidos, horas fuera de rango y bloques cortos', () => {
    expect(validateDays([{ weekday: 1, intervals: [{ start: h(9), end: h(13) }, { start: h(12), end: h(15) }] }])).toMatch(/cruzan/);
    expect(validateDays([{ weekday: 1, intervals: [] }, { weekday: 1, intervals: [] }])).toMatch(/dos veces/);
    expect(validateDays([{ weekday: 8, intervals: [] }])).toMatch(/Día/);
    expect(validateDays([{ weekday: 2, intervals: [{ start: h(9), end: h(25) }] }])).toMatch(/24:00/);
    expect(validateDays([{ weekday: 2, intervals: [{ start: h(9, 2), end: h(10) }] }])).toMatch(/pasos/);
    expect(validateDays([{ weekday: 2, intervals: [{ start: h(9), end: h(9, 10) }] }])).toMatch(/al menos/);
  });

  it('ordena bloques y quita días vacíos', () => {
    expect(
      normalizeDays([
        { weekday: 3, intervals: [{ start: h(14), end: h(18) }, { start: h(9), end: h(12) }] },
        { weekday: 1, intervals: [] },
      ]),
    ).toEqual([{ weekday: 3, intervals: [{ start: h(9), end: h(12) }, { start: h(14), end: h(18) }] }]);
  });

  it('detecta el mismo horario en dos sedes', () => {
    const miraflores = { branchId: 'a', days: [{ weekday: 1, intervals: [{ start: h(9), end: h(13) }] }] };
    const surco = { branchId: 'b', days: [{ weekday: 1, intervals: [{ start: h(12), end: h(18) }] }] };
    const surcoTarde = { branchId: 'b', days: [{ weekday: 1, intervals: [{ start: h(14), end: h(18) }] }] };
    expect(findCrossBranchOverlap([miraflores, surco])).toEqual({ weekday: 1 });
    expect(findCrossBranchOverlap([miraflores, surcoTarde])).toBeNull();
  });
});
