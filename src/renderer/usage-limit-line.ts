// Pure helpers for the "usage limit until <time>" line of a provider (no DOM): the text and the delay until it should go away.

const pad = (value: number): string => String(value).padStart(2, "0");
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The time as the machine's local clock shows it, from Date getters so the text does not depend on the OS locale. */
const clock = (date: Date): string => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** `usage limit until 11:07` on the same local day, `usage limit until 2026-11-29 11:07` on another day; undefined when there is no valid future time. */
export function usageLimitLine(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined;
  const until = new Date(iso);
  if (Number.isNaN(until.getTime()) || until.getTime() <= now) return undefined;
  const today = new Date(now);
  const sameDay = until.getFullYear() === today.getFullYear() && until.getMonth() === today.getMonth() && until.getDate() === today.getDate();
  return sameDay ? `usage limit until ${clock(until)}` : `usage limit until ${until.getFullYear()}-${pad(until.getMonth() + 1)}-${pad(until.getDate())} ${clock(until)}`;
}

/** Milliseconds until the earliest future `exhaustedUntil` (capped at the largest timer delay); undefined when none is in the future. */
export function nextExpiryDelay(providers: Array<{ exhaustedUntil?: string }>, now: number): number | undefined {
  let next: number | undefined;
  for (const entry of providers) {
    const time = entry.exhaustedUntil ? new Date(entry.exhaustedUntil).getTime() : Number.NaN;
    if (Number.isNaN(time) || time <= now) continue;
    if (next === undefined || time < next) next = time;
  }
  return next === undefined ? undefined : Math.min(next - now, MAX_TIMER_MS);
}
