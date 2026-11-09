/**
 * How values read on screen: relative times with the exact time on hover,
 * money with its currency, durations and tokens with units.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toDate(at: string | number | Date): Date {
  return at instanceof Date ? at : new Date(at);
}

/** "2 min ago", "in 3 h", "just now", "yesterday", or a date for anything further off. */
export function relativeTime(
  at: string | number | Date | null | undefined,
  now = Date.now()
): string {
  if (at === null || at === undefined || at === '') return '—';
  const t = toDate(at).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = t - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  const say = (n: number, unit: string) => (future ? `in ${n} ${unit}` : `${n} ${unit} ago`);
  if (abs < 45_000) return future ? 'in a moment' : 'just now';
  if (abs < HOUR) return say(Math.max(1, Math.round(abs / MINUTE)), 'min');
  if (abs < DAY) return say(Math.round(abs / HOUR), 'h');
  if (abs < 2 * DAY) return future ? 'tomorrow' : 'yesterday';
  if (abs < 7 * DAY) return say(Math.round(abs / DAY), 'days');
  return shortDate(t);
}

/** "Mon 9 Nov, 08:00". */
export function exactTime(at: string | number | Date | null | undefined): string {
  if (at === null || at === undefined || at === '') return '';
  const d = toDate(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortDate(at: string | number | Date): string {
  return toDate(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function clockTime(at: string | number | Date): string {
  return toDate(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "$4.20"; small amounts keep enough digits to be non-zero. */
export function money(usd: number | null | undefined, opts: { atLeast?: boolean } = {}): string {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return '—';
  const digits = usd !== 0 && Math.abs(usd) < 0.01 ? 4 : 2;
  return `${opts.atLeast ? '≥ ' : ''}$${usd.toFixed(digits)}`;
}

/** "850 ms", "12 s", "4 min 10 s", "1 h 05 min". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

/** "1,204 tokens" or "12.4k tokens". */
export function tokens(n: number | null | undefined, unit = true): string {
  if (n === null || n === undefined) return '—';
  const v = n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US');
  return unit ? `${v} tokens` : v;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function percent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return '—';
  return `${Math.round(fraction * 100)}%`;
}

/** The message of a failure, preferring the gateway's own wording. */
export function errorMessage(e: unknown): string {
  const body = (e as { body?: Record<string, unknown> } | null)?.body;
  if (body && typeof body.message === 'string') return body.message;
  if (body && typeof body.error === 'string' && !/_/.test(body.error)) return body.error;
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) {
    return "OpenClerq's background service isn't responding.";
  }
  return e instanceof Error ? e.message.replace(/^Gateway \d+: /, '') : String(e);
}

/** True when the failure is the background service being unreachable, not a refusal. */
export function isOffline(e: unknown): boolean {
  return e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(String(e));
}
