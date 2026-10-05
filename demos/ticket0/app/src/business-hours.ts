/**
 * The desk's opening hours as the Settings form holds them (#1648).
 *
 * A leaf, for `sla.ts`'s reason: nothing that drags `api.ts` in, so the vertical's suite
 * can reach the translation without a DOM. Its one import is `src/business-time.ts`, which
 * imports nothing itself, so a time, a date and a timezone mean here what they mean to the
 * desk's clock. The form is text a person types (`09:00–17:00` in a box per
 * weekday, one exception per line), and the desk stores a structured schedule
 * (`deskSettingsBlob.businessHours`); the translation between the two is where it can go
 * wrong, so it lives here.
 *
 * The desk judges the schedule again at the door (`businessHoursSchedule` in
 * `spec/model.ts`). This file judges it first only so the message can name the box.
 */

import { dayNumberOf, isTimeZone, minutesOf, WALL_CLOCK_TIME } from '../../src/business-time.js';

export const HOURS_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type HoursDay = (typeof HOURS_DAYS)[number];

export const HOURS_DAY_LABELS: Record<HoursDay, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

/** Restated from `spec/model.ts`, which is not browser code; `test/sla-business-hours.test.ts` holds them equal. */
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
    if (!WALL_CLOCK_TIME.test(open) || !WALL_CLOCK_TIME.test(close) || open === '24:00') return `"${part.trim()}": times run 00:00–24:00`;
    if (minutesOf(open) >= minutesOf(close)) return `"${part.trim()}" closes before it opens`;
    const last = out[out.length - 1];
    if (last && minutesOf(last.close) > minutesOf(open)) return 'windows must be in order and must not overlap';
    out.push({ open, close });
  }
  if (out.length > HOURS_WINDOWS_PER_DAY_MAX) return `at most ${HOURS_WINDOWS_PER_DAY_MAX} windows a day`;
  return out;
}

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
    if (Number.isNaN(dayNumberOf(date))) return { error: `Exception "${line}": start with a date, 2026-12-24.` };
    if (exceptions.some((e) => e.date === date)) return { error: `Exception ${date}: listed twice.` };
    if (what === '') return { error: `Exception ${date}: say "closed" or give the hours.` };
    const ws = what.toLowerCase() === 'closed' ? [] : parseWindows(what);
    if (typeof ws === 'string') return { error: `Exception ${date}: ${ws}, or "closed".` };
    exceptions.push({ date, windows: ws });
  }
  if (exceptions.length > HOURS_EXCEPTIONS_MAX) return { error: `At most ${HOURS_EXCEPTIONS_MAX} exceptions.` };
  return { setting: { timezone, weekly, ...(exceptions.length > 0 ? { exceptions } : {}) } };
}
