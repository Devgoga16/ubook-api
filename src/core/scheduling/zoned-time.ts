/**
 * Conversión entre hora "de pared" de una sede (fecha local + minutos desde
 * la medianoche) e instantes UTC. Usa Intl, así que respeta cambios de
 * horario donde existan (Perú no tiene).
 */

const DAY_MS = 86_400_000;

/** Desfase en minutos de la zona en ese instante (Lima → -300). */
export function offsetMinutes(at: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name ?? '');
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/** "2026-10-08" + 540 min (09:00) en Lima → 2026-10-08T14:00:00Z. */
export function zonedToUtc(date: string, minutes: number, timeZone: string): Date {
  const naive = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  // Dos pasadas por si el desfase cambia entre la hora estimada y la real.
  let utc = naive - offsetMinutes(new Date(naive), timeZone) * 60_000;
  utc = naive - offsetMinutes(new Date(utc), timeZone) * 60_000;
  return new Date(utc);
}

/** Instante UTC → fecha local, minutos desde la medianoche y día ISO (1–7). */
export function utcToZoned(at: Date, timeZone: string): { date: string; minutes: number; weekday: number } {
  const local = new Date(at.getTime() + offsetMinutes(at, timeZone) * 60_000);
  const date = local.toISOString().slice(0, 10);
  return { date, minutes: local.getUTCHours() * 60 + local.getUTCMinutes(), weekday: weekdayOf(date) };
}

/** Día ISO de una fecha local: 1 = lunes … 7 = domingo. */
export function weekdayOf(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function isValidDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`));
}
