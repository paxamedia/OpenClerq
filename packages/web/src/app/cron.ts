/**
 * Cron lines as the interface needs them: the next firings, in this computer's
 * time zone, and the schedule in words. The gateway decides when a run starts;
 * this only previews it, and is used where the gateway gives no firing times.
 */

export interface CronFields {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  /** Both day fields restricted: a day matches either, as in standard cron. */
  dayOr: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = [
  'Sundays',
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function parseField(spec: string, lo: number, hi: number, names?: string[]): number[] | null {
  const out = new Set<number>();
  const value = (s: string): number => {
    const named = names?.indexOf(s.toLowerCase().slice(0, 3)) ?? -1;
    if (named >= 0 && /^[a-z]+$/i.test(s)) return named + (names === MONTHS ? 1 : 0);
    return /^\d+$/.test(s) ? Number(s) : NaN;
  };
  for (const part of spec.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let a: number;
    let b: number;
    if (range === '*') {
      a = lo;
      b = hi;
    } else if (range.includes('-')) {
      const [x, y] = range.split('-');
      a = value(x);
      b = value(y);
    } else {
      a = value(range);
      b = stepText === undefined ? a : hi;
    }
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

/** The fields of a five-field cron line (a leading seconds field is ignored), or null. */
export function parseCron(line: string): CronFields | null {
  let parts = line.trim().split(/\s+/);
  if (parts.length === 6) parts = parts.slice(1);
  if (parts.length !== 5) return null;
  const [mi, ho, da, mo, wd] = parts;
  const minutes = parseField(mi, 0, 59);
  const hours = parseField(ho, 0, 23);
  const days = parseField(da, 1, 31);
  const months = parseField(mo, 1, 12, MONTHS);
  const weekdaysRaw = parseField(wd, 0, 7, WEEKDAYS);
  if (!minutes || !hours || !days || !months || !weekdaysRaw) return null;
  const weekdays = [...new Set(weekdaysRaw.map((d) => d % 7))].sort((x, y) => x - y);
  return { minutes, hours, days, months, weekdays, dayOr: da !== '*' && wd !== '*' };
}

function dayMatches(f: CronFields, d: Date): boolean {
  const dom = f.days.includes(d.getDate());
  const dow = f.weekdays.includes(d.getDay());
  if (f.dayOr) return dom || dow;
  return dom && dow;
}

/** The next `count` firings after `from`, in local time. Empty for an invalid line. */
export function nextFirings(line: string, count: number, from: Date = new Date()): Date[] {
  const f = parseCron(line);
  if (!f) return [];
  const out: Date[] = [];
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  // Day by day, then the hours and minutes inside a matching day: at most a few years of days.
  for (let guard = 0; out.length < count && guard < 366 * 5; guard++) {
    if (f.months.includes(t.getMonth() + 1) && dayMatches(f, t)) {
      for (const h of f.hours) {
        if (h < t.getHours()) continue;
        for (const m of f.minutes) {
          if (h === t.getHours() && m < t.getMinutes()) continue;
          const at = new Date(t.getFullYear(), t.getMonth(), t.getDate(), h, m);
          // A clock change can skip or repeat an hour; keep the times in order.
          if (at.getHours() !== h || (out.length && at <= out[out.length - 1])) continue;
          out.push(at);
          if (out.length === count) return out;
        }
      }
    }
    t.setDate(t.getDate() + 1);
    t.setHours(0, 0, 0, 0);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * The schedule in words: "Mondays at 08:00", "Every day at 09:00 and 17:00",
 * "Every 15 minutes". Falls back to the line itself when it has no short wording.
 */
export function describeCron(line: string): string {
  const f = parseCron(line);
  if (!f) return line;
  const allMinutes = f.minutes.length === 60;
  const allHours = f.hours.length === 24;
  const allDays = f.days.length === 31;
  const allMonths = f.months.length === 12;
  const allWeekdays = f.weekdays.length === 7;

  let when: string;
  if (allMinutes && allHours) when = 'Every minute';
  else if (allHours && f.minutes.length > 1) {
    const step = f.minutes[1] - f.minutes[0];
    const even = f.minutes[0] === 0 && f.minutes.every((m, i) => m === i * step);
    when = even && 60 % step === 0 ? `Every ${step} minutes` : `${f.minutes.length} times an hour`;
  } else if (allHours)
    when = f.minutes[0] === 0 ? 'Every hour' : `Every hour at :${pad(f.minutes[0])}`;
  else if (f.hours.length * f.minutes.length > 4) {
    when = `${f.hours.length * f.minutes.length} times a day`;
  } else {
    const times = f.hours.flatMap((h) => f.minutes.map((m) => `${pad(h)}:${pad(m)}`));
    when = `at ${joinWords(times)}`;
  }

  let days = '';
  if (!allWeekdays && allDays) {
    const set = f.weekdays.join(',');
    days =
      set === '1,2,3,4,5'
        ? 'Weekdays'
        : set === '0,6'
          ? 'Weekends'
          : joinWords(f.weekdays.map((d) => DAY_NAMES[d]));
  } else if (!allDays && allWeekdays) {
    days = `On the ${joinWords(f.days.map(ordinal))}`;
  } else if (!allDays) {
    days = `On the ${joinWords(f.days.map(ordinal))} or ${joinWords(f.weekdays.map((d) => DAY_NAMES[d]))}`;
  }
  const months = allMonths ? '' : ` in ${joinWords(f.months.map((m) => MONTH_NAMES[m - 1]))}`;

  if (!days) {
    const daily = when.startsWith('at ') ? `Every day ${when}` : when;
    return `${daily}${months}`;
  }
  const lead = when.startsWith('at ') ? `${days} ${when}` : `${days}, ${when.toLowerCase()}`;
  return `${lead}${months}`;
}

/** What the schedule picker can write: given weekdays (0 = Sunday) at one time. */
export interface SimpleSchedule {
  weekdays: number[];
  hour: number;
  minute: number;
}

/** The picker's reading of a line, or null when the line says more than days and a time. */
export function simpleSchedule(line: string): SimpleSchedule | null {
  const f = parseCron(line);
  if (!f || f.hours.length !== 1 || f.minutes.length !== 1) return null;
  if (f.days.length !== 31 || f.months.length !== 12) return null;
  return { weekdays: f.weekdays, hour: f.hours[0], minute: f.minutes[0] };
}

export function cronFromSimple(s: SimpleSchedule): string {
  const days = [...new Set(s.weekdays)].sort((a, b) => a - b);
  const field = days.length === 7 || days.length === 0 ? '*' : days.join(',');
  return `${s.minute} ${s.hour} * * ${field}`;
}
