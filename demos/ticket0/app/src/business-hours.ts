/**
 * The desk's opening hours as the Settings form holds them (#1648).
 *
 * A leaf, for `sla.ts`'s reason: no imports, so the vertical's suite can reach the
 * translation without a DOM. The form is text a person types (`09:00–17:00` in a box per
 * weekday, one exception per line), and the desk stores a structured schedule
 * (`deskSettingsBlob.businessHours`); the translation between the two is where it can go
 * wrong, so it lives here.
 *
 * The desk judges the schedule again at the door (`businessHoursSchedule` in
 * `spec/model.ts`). This file judges it first only so the message can name the box.
 */

export const HOURS_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type HoursDay = (typeof HOURS_DAYS)[number];

export const HOURS_DAY_LABELS: Record<HoursDay, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

/** Restated from `spec/model.ts`, which is not browser code; `test/business-hours-form.test.ts` holds them equal. */
export const HOURS_WINDOWS_PER_DAY_MAX = 4;
export const HOURS_EXCEPTIONS_MAX = 366;

interface Window {
  open: string;
  close: string;
}

/** What `configure-desk` accepts under `settings.businessHours`. `null` clears it. */
export interface HoursSetting {
  timezone: string;
  weekly: Partial<Record<HoursDay, Window[]>>;
  exceptions?: { date: string; windows: Window[] }[];
}

/** The boxes, as typed. Every box empty is "no structured hours". */
export interface HoursForm {
  timezone: string;
  days: Record<HoursDay, string>;
  /** One per line: `2026-12-24 closed` or `2026-12-24 09:00–12:00`. */
  exceptions: string;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const windowsText = (ws: readonly Window[]) => ws.map((w) => `${w.open}–${w.close}`).join(', ');

export function emptyHoursForm(): HoursForm {
  return {
    timezone: '',
    days: { mon: '', tue: '', wed: '', thu: '', fri: '', sat: '', sun: '' },
    exceptions: '',
  };
}

/**
 * The form, from the desk's stored `settings` string. Lenient as the desk is: anything
 * that is not the shape it writes shows as empty boxes, which is also how the desk reads
 * it (no structured hours), so the form never displays hours the desk is not applying.
 */
export function hoursFormOf(settings: string | null): HoursForm {
  const form = emptyHoursForm();
  let raw: unknown;
  try {
    raw = settings ? (JSON.parse(settings) as Record<string, unknown>).businessHours : undefined;
  } catch {
    return form;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return form;
  const h = raw as Partial<HoursSetting>;
  const isWindows = (v: unknown): v is Window[] =>
    Array.isArray(v) && v.every((w) => w && typeof w.open === 'string' && typeof w.close === 'string');
  if (typeof h.timezone !== 'string' || h.weekly === null || typeof h.weekly !== 'object') return form;
  form.timezone = h.timezone;
  for (const d of HOURS_DAYS) {
    const ws = (h.weekly as Record<string, unknown>)[d];
    if (isWindows(ws)) form.days[d] = windowsText(ws);
  }
  if (Array.isArray(h.exceptions)) {
    form.exceptions = h.exceptions
      .filter((e) => e && typeof e.date === 'string' && isWindows(e.windows))
      .map((e) => `${e.date} ${e.windows.length === 0 ? 'closed' : windowsText(e.windows)}`)
      .join('\n');
  }
  return form;
}

/** `09:00–17:00, 13:00–15:00` → windows, or the reason it is not that. Empty is closed. */
function parseWindows(text: string): Window[] | string {
  const t = text.trim();
  if (t === '') return [];
  const out: Window[] = [];
  for (const part of t.split(',')) {
    const m = /^\s*(\d{2}:\d{2})\s*[–-]\s*(\d{2}:\d{2})\s*$/.exec(part);
    if (!m) return `"${part.trim()}" is not a window - write 09:00–17:00`;
    const [open, close] = [m[1]!, m[2]!];
    if (!TIME.test(open) || !TIME.test(close) || open === '24:00') return `"${part.trim()}": times run 00:00–24:00`;
    if (minutes(open) >= minutes(close)) return `"${part.trim()}" closes before it opens`;
    const last = out[out.length - 1];
    if (last && minutes(last.close) > minutes(open)) return 'windows must be in order and must not overlap';
    out.push({ open, close });
  }
  if (out.length > HOURS_WINDOWS_PER_DAY_MAX) return `at most ${HOURS_WINDOWS_PER_DAY_MAX} windows a day`;
  return out;
}

const isDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
};

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const isEmpty = (form: HoursForm) =>
  form.timezone.trim() === '' && HOURS_DAYS.every((d) => form.days[d].trim() === '') && form.exceptions.trim() === '';

/**
 * The schedule Save sends, or the reason it cannot: `{ setting }` or `{ error }`. Every box
 * empty is `{ setting: null }`, which the desk reads as "no structured hours" and the
 * widget answers with the free-text note.
 */
export function hoursPayloadOf(form: HoursForm): { setting: HoursSetting | null } | { error: string } {
  if (isEmpty(form)) return { setting: null };
  const timezone = form.timezone.trim();
  if (timezone === '') return { error: 'Timezone: required once any hours are set, such as Europe/Stockholm.' };
  if (!isTimeZone(timezone)) return { error: `Timezone: "${timezone}" is not one - try Europe/Stockholm.` };
  const weekly: Partial<Record<HoursDay, Window[]>> = {};
  for (const d of HOURS_DAYS) {
    const ws = parseWindows(form.days[d]);
    if (typeof ws === 'string') return { error: `${HOURS_DAY_LABELS[d]}: ${ws}.` };
    if (ws.length > 0) weekly[d] = ws;
  }
  if (Object.keys(weekly).length === 0) return { error: 'Open on at least one day of the week.' };
  const exceptions: { date: string; windows: Window[] }[] = [];
  for (const line of form.exceptions.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [date = '', ...rest] = line.split(/\s+/);
    const what = rest.join(' ');
    if (!isDate(date)) return { error: `Exception "${line}": start with a date, 2026-12-24.` };
    if (exceptions.some((e) => e.date === date)) return { error: `Exception ${date}: listed twice.` };
    const ws = what.toLowerCase() === 'closed' ? [] : parseWindows(what);
    if (typeof ws === 'string') return { error: `Exception ${date}: ${ws}, or "closed".` };
    if (what.trim() === '') return { error: `Exception ${date}: say "closed" or give the hours.` };
    exceptions.push({ date, windows: ws });
  }
  if (exceptions.length > HOURS_EXCEPTIONS_MAX) return { error: `At most ${HOURS_EXCEPTIONS_MAX} exceptions.` };
  return { setting: { timezone, weekly, ...(exceptions.length > 0 ? { exceptions } : {}) } };
}
