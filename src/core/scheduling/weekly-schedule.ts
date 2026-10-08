/**
 * Horario semanal. Las horas se guardan como minutos desde la medianoche en
 * la hora local de la sucursal (9:30 → 570). Día ISO: 1 = lunes … 7 = domingo.
 */
export interface TimeRange {
  start: number;
  end: number;
}

export interface DaySchedule {
  weekday: number;
  intervals: TimeRange[];
}

export interface BranchSchedule {
  branchId: string;
  days: DaySchedule[];
}

export const MINUTE_STEP = 5;
export const MIN_BLOCK = 15;

/** Devuelve el primer problema encontrado, o `null` si el horario es válido. */
export function validateDays(days: DaySchedule[]): string | null {
  const seen = new Set<number>();
  for (const day of days) {
    if (!Number.isInteger(day.weekday) || day.weekday < 1 || day.weekday > 7) return 'Día inválido';
    if (seen.has(day.weekday)) return 'Un día aparece dos veces';
    seen.add(day.weekday);

    const sorted = [...day.intervals].sort((a, b) => a.start - b.start);
    for (const [i, r] of sorted.entries()) {
      if (r.start < 0 || r.end > 24 * 60 || r.start % MINUTE_STEP || r.end % MINUTE_STEP) {
        return `Las horas deben ir de 00:00 a 24:00 en pasos de ${MINUTE_STEP} minutos`;
      }
      if (r.end - r.start < MIN_BLOCK) return `Cada bloque debe durar al menos ${MIN_BLOCK} minutos`;
      const prev = sorted[i - 1];
      if (prev && r.start < prev.end) return 'Hay bloques que se cruzan en el mismo día';
    }
  }
  return null;
}

/** Ordena bloques y quita días vacíos. */
export function normalizeDays(days: DaySchedule[]): DaySchedule[] {
  return days
    .filter((d) => d.intervals.length > 0)
    .map((d) => ({ weekday: d.weekday, intervals: [...d.intervals].sort((a, b) => a.start - b.start) }))
    .sort((a, b) => a.weekday - b.weekday);
}

/** Un profesional no puede estar en dos sedes a la misma hora. */
export function findCrossBranchOverlap(schedules: BranchSchedule[]): { weekday: number } | null {
  for (let i = 0; i < schedules.length; i++) {
    for (let j = i + 1; j < schedules.length; j++) {
      for (const a of schedules[i]!.days) {
        const b = schedules[j]!.days.find((d) => d.weekday === a.weekday);
        if (!b) continue;
        const clash = a.intervals.some((x) => b.intervals.some((y) => x.start < y.end && y.start < x.end));
        if (clash) return { weekday: a.weekday };
      }
    }
  }
  return null;
}

export const WEEKDAY_NAMES = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
