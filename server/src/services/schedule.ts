// When a routine falls due, carried over from JAOA Pragati's routine rules.
//
// Days are plain 'YYYY-MM-DD' strings in the community's own time zone; times are 'HH:MM'.
// A schedule version applies from its effective date until the next version starts, so changing a
// routine from next month never changes how past days are judged.

export type Frequency = 'once' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'annually';
export type Schedule = {
  effective_from: string;
  frequency: Frequency;
  every: number;
  weekdays: number[];      // 0 = Sunday
  month_days: number[];    // 31 = the last day of any month
  starts_on: string;
  ends_on: string | null;
  start_time: string | null;
  end_time: string | null;
  paused: boolean;
  remarks: 'optional' | 'required' | 'exception';
  reading_label: string | null;
  reading_unit: string | null;
  photo_required: boolean;
  reference_required: boolean;
};

export type CheckStatus = 'done' | 'skipped' | 'blocked' | 'in_progress';
export type DayStatus = CheckStatus | 'missed' | 'due' | 'upcoming';

const DAY = 86_400_000;
const ms = (day: string) => Date.parse(day + 'T00:00:00Z');
export const addDays = (day: string, n: number) => new Date(ms(day) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((ms(to) - ms(from)) / DAY);
const MONTH_STEP: Partial<Record<Frequency, number>> = { quarterly: 3, half_yearly: 6, annually: 12 };

// Postgres returns dates and times in its own formats; these keep them as plain strings.
export const asDay = (v: unknown): string => v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v).slice(0, 10);
export const asTime = (v: unknown): string | null => v ? String(v).slice(0, 5) : null;

export function normalise(row: any): Schedule {
  return { ...row, effective_from: asDay(row.effective_from), starts_on: asDay(row.starts_on),
    ends_on: row.ends_on ? asDay(row.ends_on) : null, start_time: asTime(row.start_time), end_time: asTime(row.end_time),
    weekdays: (row.weekdays ?? []).map(Number), month_days: (row.month_days ?? []).map(Number), every: Number(row.every ?? 1) };
}

// The version in force on a day; versions may come in any order.
export function versionOn(versions: Schedule[], day: string): Schedule | null {
  let best: Schedule | null = null;
  for (const v of versions) if (v.effective_from <= day && (!best || v.effective_from > best.effective_from)) best = v;
  return best;
}

export function occursOn(s: Schedule, day: string): boolean {
  if (s.paused || day < s.starts_on || (s.ends_on && day > s.ends_on)) return false;
  const elapsed = daysBetween(s.starts_on, day);
  const every = Math.max(1, s.every || 1);
  switch (s.frequency) {
    case 'once': return day === s.starts_on;
    case 'daily': return elapsed % every === 0;
    case 'weekly': {
      // Weeks run Monday to Sunday; "every 2 weeks" counts weeks from the week the routine starts.
      const weekday = new Date(ms(day)).getUTCDay();
      const offset = (new Date(ms(s.starts_on)).getUTCDay() + 6) % 7;
      return Math.floor((elapsed + offset) / 7) % every === 0 && s.weekdays.includes(weekday);
    }
    default: {
      const [y, m, d] = day.split('-').map(Number);
      const [sy, sm] = s.starts_on.split('-').map(Number);
      const months = (y - sy) * 12 + (m - sm);
      const step = MONTH_STEP[s.frequency] ?? every;
      const monthEnd = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return months % step === 0 && s.month_days.some(n => Math.min(n, monthEnd) === d);
    }
  }
}

// The status of one scheduled day, from its check (if any) and the community's current day and time.
export function dayStatus(s: Schedule, day: string, check: { status: CheckStatus } | null, now: { day: string; minute: string }): DayStatus {
  if (check) return check.status;
  if (day < now.day) return 'missed';
  if (day > now.day) return 'upcoming';
  if (s.end_time && now.minute >= s.end_time) return 'missed';
  if (!s.start_time || now.minute >= s.start_time) return 'due';
  return 'upcoming';
}

// Work recorded after the window closed, or on a later day, is late.
export function isLate(s: Schedule, day: string, performed: { day: string; minute: string }): boolean {
  if (performed.day > day) return true;
  return !!s.end_time && performed.day === day && performed.minute >= s.end_time;
}

// Plain-English summary, used in lists: "Daily, 06:00 to 07:00", "Mondays and Thursdays", "Monthly on the last day".
const WEEKDAY = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const ordinal = (n: number) => n === 31 ? 'the last day' : `the ${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const list = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
export function describe(s: Schedule): string {
  const days = list([...s.month_days].sort((a, b) => a - b).map(ordinal));
  let what: string;
  switch (s.frequency) {
    case 'once': what = `Once, on ${s.starts_on}`; break;
    case 'daily': what = s.every === 1 ? 'Daily' : `Every ${s.every} days`; break;
    case 'weekly': what = `${s.every === 1 ? '' : `Every ${s.every} weeks, `}${list([...s.weekdays].sort().map(d => WEEKDAY[d]))}`; break;
    case 'monthly': what = `${s.every === 1 ? 'Monthly' : `Every ${s.every} months`} on ${days}`; break;
    case 'quarterly': what = `Quarterly on ${days}`; break;
    case 'half_yearly': what = `Every six months on ${days}`; break;
    default: what = `Yearly on ${days}`;
  }
  if (s.start_time) what += s.end_time ? `, ${s.start_time} to ${s.end_time}` : `, from ${s.start_time}`;
  return s.paused ? `Paused (${what.charAt(0).toLowerCase()}${what.slice(1)})` : what;
}

// ---------- the community's own clock ----------
const fmt = new Map<string, Intl.DateTimeFormat>();
function parts(at: Date, tz: string) {
  let f = fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    fmt.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minute: `${p.hour}:${p.minute}` };
}
export const localNow = (tz: string, at = new Date()) => parts(at, tz);

// The instant a local day and time names in a time zone (for India, a fixed +05:30).
export function zonedInstant(day: string, minute: string, tz: string): Date {
  const guess = new Date(`${day}T${minute}:00Z`);
  const seen = parts(guess, tz);
  const drift = Date.parse(`${seen.day}T${seen.minute}:00Z`) - guess.getTime();
  return new Date(guess.getTime() - drift);
}
