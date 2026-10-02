const TZ = 'Asia/Kolkata';

/** Returns YYYY-MM-DD in IST for the given date (defaults to now). */
export function istDateStr(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Returns a Date object set to midnight IST today. */
export function istMidnight(d: Date = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);

  const y = parts.find(p => p.type === 'year')!.value;
  const m = parts.find(p => p.type === 'month')!.value;
  const day = parts.find(p => p.type === 'day')!.value;

  return new Date(`${y}-${m}-${day}T00:00:00+05:30`);
}

/** Returns YYYY-MM-DD in IST for N days ago. */
export function istDaysAgo(days: number): string {
  return istDateStr(new Date(Date.now() - days * 86_400_000));
}

/**
 * Minutes elapsed since IST midnight (0-1439).
 *
 * Use this rather than hand-rolling `(getUTCHours() + 5) % 24`, which both
 * mishandles the minute carry (producing hour 24) and forces callers into
 * exact "HH:MM" string comparisons that silently miss if a timer tick drifts
 * past the target minute.
 */
export function istMinutesSinceMidnight(d: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);

  const h = Number(parts.find(p => p.type === 'hour')!.value);
  const m = Number(parts.find(p => p.type === 'minute')!.value);
  return h * 60 + m;
}

/** Hour of the day (0–23) in IST. Use this, not Date#getHours(): the server runs on UTC. */
export function istHour(d: Date = new Date()): number {
  return Math.floor(istMinutesSinceMidnight(d) / 60);
}

/** Day of the week (0 = Sunday) in IST. */
export function istDayOfWeek(d: Date = new Date()): number {
  return new Date(`${istDateStr(d)}T00:00:00Z`).getUTCDay();
}

/** Parses "HH:MM" into minutes since midnight. Returns null if malformed. */
export function parseHHMM(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}
