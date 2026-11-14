/** Small helpers that turn numbers and times into words. */

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `12:03:09` in this computer's time zone. */
export function clock(iso: string | undefined): string {
  if (!iso) return '        ';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '        ';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `2026-11-13 12:03` in this computer's time zone. */
export function dateTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `850 ms`, `12 s`, `3 min 12 s`, `1 h 4 min`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

/** `$0.25`; the figure is a lower bound when a price was missing. */
export function money(usd: number, known = true): string {
  const text = usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
  return known ? text : `at least ${text}`;
}

/** The text on one line, cut to `max` characters. */
export function oneLine(text: string | undefined, max = 100): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Rows as aligned columns, two spaces apart; the last column is not padded. */
export function table(header: string[], rows: string[][]): string[] {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  return all.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : (cell ?? '').padEnd(widths[i])))
      .join('  ')
      .trimEnd()
  );
}

/** A run's state in words a person would say. */
export function statusWords(status: string): string {
  const words: Record<string, string> = {
    queued: 'queued',
    leased: 'queued',
    preparing: 'starting',
    executing: 'running',
    verifying: 'checking the gates',
    publishing: 'publishing',
    awaiting_approval: 'waiting for approval',
    done: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  return words[status] ?? status;
}

export const FINISHED = new Set(['done', 'failed', 'cancelled']);
