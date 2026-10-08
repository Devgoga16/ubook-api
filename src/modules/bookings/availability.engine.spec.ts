import { addDays, utcToZoned, weekdayOf, zonedToUtc } from '../../core/scheduling/zoned-time.js';
import { blockedRange, daySlots, intersectRanges, peakOverlap, pickResource, workingWindows, type DayAvailabilityInput } from './availability.engine.js';

const h = (hh: number, mm = 0) => hh * 60 + mm;
const TZ = 'America/Lima';
// 2026-10-12 es lunes.
const MONDAY = '2026-10-12';

const base: DayAvailabilityInput = {
  date: MONDAY,
  timezone: TZ,
  branchHours: [],
  exception: null,
  professionalDays: [{ weekday: 1, intervals: [{ start: h(9), end: h(13) }, { start: h(14), end: h(16) }] }],
  timeOff: [],
  busy: [],
  durationMinutes: 45,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  stepMinutes: 15,
};

const times = (input: DayAvailabilityInput, onlyAvailable = true) =>
  daySlots(input)
    .filter((s) => !onlyAvailable || s.available)
    .map((s) => {
      const m = utcToZoned(s.start, TZ).minutes;
      return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    });

describe('Hora local', () => {
  it('convierte entre Lima y UTC', () => {
    expect(zonedToUtc(MONDAY, h(9), TZ).toISOString()).toBe('2026-10-12T14:00:00.000Z');
    expect(utcToZoned(new Date('2026-10-13T04:30:00Z'), TZ)).toEqual({ date: '2026-10-12', minutes: h(23, 30), weekday: 1 });
    expect(weekdayOf(MONDAY)).toBe(1);
    expect(weekdayOf('2026-10-18')).toBe(7);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('Ventanas de trabajo', () => {
  it('cruza el horario del profesional con el de la sede', () => {
    expect(intersectRanges([{ start: h(9), end: h(19) }], [{ start: h(10), end: h(13) }, { start: h(15), end: h(20) }])).toEqual([
      { start: h(10), end: h(13) },
      { start: h(15), end: h(19) },
    ]);
    expect(workingWindows({ ...base, branchHours: [{ weekday: 1, intervals: [{ start: h(10), end: h(20) }] }] })).toEqual([
      { start: h(10), end: h(13) },
      { start: h(14), end: h(16) },
    ]);
  });

  it('sede cerrada ese día, feriado o día especial', () => {
    expect(workingWindows({ ...base, branchHours: [{ weekday: 2, intervals: [{ start: h(9), end: h(18) }] }] })).toEqual([]);
    expect(workingWindows({ ...base, exception: { type: 'closed', intervals: [] } })).toEqual([]);
    expect(workingWindows({ ...base, exception: { type: 'custom_hours', intervals: [{ start: h(9), end: h(11) }] } })).toEqual([
      { start: h(9), end: h(11) },
    ]);
  });

  it('el profesional no trabaja ese día', () => {
    expect(workingWindows({ ...base, date: addDays(MONDAY, 1) })).toEqual([]);
  });
});

describe('Horarios ofrecidos', () => {
  it('genera horarios cada 15 minutos que caben completos en cada bloque', () => {
    expect(times(base)).toEqual([
      '9:00', '9:15', '9:30', '9:45', '10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:30', '11:45', '12:00', '12:15',
      '14:00', '14:15', '14:30', '14:45', '15:00', '15:15',
    ]);
  });

  it('marca como ocupados los que chocan con otra cita, considerando la limpieza', () => {
    const busy = [blockedRange(zonedToUtc(MONDAY, h(10), TZ), 30, 0, 10)]; // 10:00–10:40
    const input = { ...base, busy, bufferAfterMinutes: 10 };
    const all = daySlots(input);
    const taken = all.filter((s) => !s.available).map((s) => utcToZoned(s.start, TZ).minutes / 60);
    // Una cita de 45 + 10 que empiece a las 9:15 terminaría 10:10 → choca. 10:45 queda libre.
    expect(taken).toEqual([9.25, 9.5, 9.75, 10, 10.25, 10.5]);
    expect(times(input)).toContain('10:45');
    expect(times(input)).toContain('9:00');
  });

  it('respeta ausencias, anticipación mínima y ventana de reserva', () => {
    const timeOff = [{ start: zonedToUtc(MONDAY, h(14), TZ), end: zonedToUtc(MONDAY, h(23), TZ) }];
    expect(times({ ...base, timeOff }).at(-1)).toBe('12:15');

    const notBefore = zonedToUtc(MONDAY, h(11), TZ);
    expect(times({ ...base, notBefore })[0]).toBe('11:00');

    const notAfter = zonedToUtc(MONDAY, h(9, 30), TZ);
    expect(times({ ...base, notAfter })).toEqual(['9:00', '9:15', '9:30']);
  });
});

describe('Recursos (salas, camillas, equipos)', () => {
  const at = (hh: number, mm = 0) => zonedToUtc(MONDAY, h(hh, mm), TZ);
  const block = { start: at(10), end: at(11) };

  it('cuenta las citas que de verdad coinciden, no todas las que tocan el bloque', () => {
    // 10:00–10:30 y 10:30–11:00 no se pisan entre sí: el pico es 1.
    expect(peakOverlap(block, [{ start: at(10), end: at(10, 30) }, { start: at(10, 30), end: at(11) }])).toBe(1);
    // 9:30–10:45 y 10:15–11:30 sí coinciden de 10:15 a 10:45: el pico es 2.
    expect(peakOverlap(block, [{ start: at(9, 30), end: at(10, 45) }, { start: at(10, 15), end: at(11, 30) }])).toBe(2);
    expect(peakOverlap(block, [{ start: at(8), end: at(10) }])).toBe(0);
  });

  it('elige el primer recurso con espacio según su capacidad', () => {
    const busy = [{ start: at(10), end: at(11) }]
    expect(pickResource(block, [{ id: 'sala', capacity: 1, busy }, { id: 'sala-2', capacity: 1, busy: [] }])).toBe('sala-2');
    expect(pickResource(block, [{ id: 'mesa', capacity: 2, busy }])).toBe('mesa');
    expect(pickResource(block, [{ id: 'mesa', capacity: 2, busy: [...busy, ...busy] }])).toBeNull();
  });
});
