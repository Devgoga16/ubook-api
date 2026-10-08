import type { DaySchedule, TimeRange } from '../../core/scheduling/weekly-schedule.js';
import { weekdayOf, zonedToUtc } from '../../core/scheduling/zoned-time.js';

/**
 * Motor de disponibilidad (puro, sin base de datos). Un horario se ofrece si:
 * - el profesional trabaja ese día en esa sede,
 * - la sede está abierta (horario de atención o excepción del día),
 * - no hay una ausencia aprobada que lo cruce,
 * - el bloque con tiempos antes/después no choca con otra cita,
 * - respeta la anticipación mínima y la ventana de reserva.
 */
export interface Interval {
  start: Date;
  end: Date;
}

export interface DayAvailabilityInput {
  /** Fecha local de la sede, "YYYY-MM-DD". */
  date: string;
  timezone: string;
  /** Horario de atención de la sede. Vacío = sin definir (no restringe). */
  branchHours: DaySchedule[];
  /** Feriado o día especial de la sede. */
  exception?: { type: 'closed' | 'custom_hours'; intervals: TimeRange[] } | null;
  /** Horario del profesional en esta sede. */
  professionalDays: DaySchedule[];
  /** Ausencias aprobadas. */
  timeOff: Interval[];
  /** Bloques ocupados por otras citas (ya incluyen sus tiempos antes/después). */
  busy: Interval[];
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Cada cuánto se ofrece un horario. */
  stepMinutes: number;
  /** No ofrecer antes de este instante (ahora + anticipación mínima). */
  notBefore?: Date;
  /** No ofrecer después de este instante (ahora + ventana de reserva). */
  notAfter?: Date;
}

export interface Slot {
  start: Date;
  end: Date;
  /** `false` = ocupado por otra cita (se muestra tachado). */
  available: boolean;
}

const MINUTE = 60_000;

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Intersección de dos listas de rangos (en minutos). */
export function intersectRanges(a: TimeRange[], b: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

/** Ventanas de trabajo del día en minutos locales (antes de mirar citas). */
export function workingWindows(input: Pick<DayAvailabilityInput, 'date' | 'branchHours' | 'exception' | 'professionalDays'>): TimeRange[] {
  const weekday = weekdayOf(input.date);
  const professional = input.professionalDays.find((d) => d.weekday === weekday)?.intervals ?? [];
  if (professional.length === 0) return [];

  if (input.exception?.type === 'closed') return [];
  let branch: TimeRange[] | null = null;
  if (input.exception?.type === 'custom_hours') branch = input.exception.intervals;
  else if (input.branchHours.length > 0) branch = input.branchHours.find((d) => d.weekday === weekday)?.intervals ?? [];

  return branch ? intersectRanges(professional, branch) : [...professional].sort((p, q) => p.start - q.start);
}

/** Bloque que ocupa una cita en la agenda, con sus tiempos antes y después. */
export function blockedRange(start: Date, durationMinutes: number, before: number, after: number): Interval {
  return {
    start: new Date(start.getTime() - before * MINUTE),
    end: new Date(start.getTime() + (durationMinutes + after) * MINUTE),
  };
}

export function daySlots(input: DayAvailabilityInput): Slot[] {
  const slots: Slot[] = [];
  for (const window of workingWindows(input)) {
    for (let t = window.start; t + input.durationMinutes <= window.end; t += input.stepMinutes) {
      const start = zonedToUtc(input.date, t, input.timezone);
      const end = new Date(start.getTime() + input.durationMinutes * MINUTE);
      if (input.notBefore && start < input.notBefore) continue;
      if (input.notAfter && start > input.notAfter) continue;
      if (input.timeOff.some((off) => overlaps(off, { start, end }))) continue;
      const block = blockedRange(start, input.durationMinutes, input.bufferBeforeMinutes, input.bufferAfterMinutes);
      slots.push({ start, end, available: !input.busy.some((b) => overlaps(b, block)) });
    }
  }
  return slots;
}

/** Recurso que una cita ocupa además del profesional (sala, camilla, equipo). */
export interface ResourceLoad {
  id: string;
  /** Citas que puede atender al mismo tiempo. */
  capacity: number;
  busy: Interval[];
}

/** Máximo de citas simultáneas dentro del bloque (barrido de inicios y fines). */
export function peakOverlap(block: Interval, busy: Interval[]): number {
  const events: Array<[number, number]> = [];
  for (const b of busy) {
    if (!overlaps(b, block)) continue;
    events.push([Math.max(b.start.getTime(), block.start.getTime()), 1]);
    events.push([Math.min(b.end.getTime(), block.end.getTime()), -1]);
  }
  // Un fin y un inicio en el mismo instante no se superponen: primero los fines.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

/** Primer recurso con espacio para el bloque, o `null` si todos están llenos. */
export function pickResource(block: Interval, resources: ResourceLoad[]): string | null {
  return resources.find((r) => peakOverlap(block, r.busy) < r.capacity)?.id ?? null;
}
