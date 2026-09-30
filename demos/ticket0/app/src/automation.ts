/**
 * The desk's three newer behaviours as the Settings form holds them (#1083): auto-close,
 * no-reply notify and auto-tag.
 *
 * A leaf, for `sla.ts`'s reason: no imports at all, so the vertical's own suite can import
 * it without dragging `api.ts` (and `location` with it) into a program that has no DOM.
 * The form's whole job is translation between the keys the desk stores under `settings`
 * and a few boxes a person types into, and the translation is where it can go wrong.
 *
 * Off is an empty box, and it is sent as `null`: the desk sets each of these keys whole,
 * and `null` is how it hears "switched off".
 */

/**
 * The bounds the desk enforces, restated because `spec/model.ts` is not browser code.
 * `test/automation-form.test.ts` asserts each still equals the model's, so this is a
 * second reader of one bound, not a second bound.
 */
export const AUTO_CLOSE_MIN_DAYS = 1;
export const AUTO_CLOSE_MAX_DAYS = 365;
export const NO_REPLY_MIN_HOURS = 1;
export const NO_REPLY_MAX_HOURS = 720;
export const AUTO_TAG_RULES_MAX = 20;
export const AUTO_TAG_TEXT_MAX = 100;

export type RulePlace = 'subject' | 'body' | 'either';

export const RULE_PLACES: readonly { value: RulePlace; label: string }[] = [
  { value: 'subject', label: 'the subject' },
  { value: 'body', label: 'the first message' },
  { value: 'either', label: 'either' },
];

/** One auto-tag rule as typed. A row with both boxes empty is nothing, not an error. */
export interface RuleRow {
  in: RulePlace;
  contains: string;
  tag: string;
}

export interface AutomationForm {
  /** Days, as typed. Empty is off. */
  autoCloseDays: string;
  /** Hours, as typed. Empty is off. */
  noReplyHours: string;
  rules: RuleRow[];
}

export interface AutomationSettings {
  autoClose: { afterDays: number } | null;
  noReplyNotify: { afterHours: number } | null;
  autoTag: { rules: RuleRow[] } | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const whole = (v: unknown, min: number, max: number): string =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? String(v) : '';

/**
 * The form, from the desk's stored `settings` string.
 *
 * Lenient where the desk is: a value that is not usable shows as an empty box, which is
 * also how the desk reads it (off), so the form cannot display a behaviour the desk is not
 * applying.
 */
export function automationFormOf(settings: string | null): AutomationForm {
  const form: AutomationForm = { autoCloseDays: '', noReplyHours: '', rules: [] };
  let stored: unknown;
  try {
    stored = settings ? JSON.parse(settings) : undefined;
  } catch {
    return form;
  }
  if (!isObject(stored)) return form;
  if (isObject(stored.autoClose))
    form.autoCloseDays = whole(stored.autoClose.afterDays, AUTO_CLOSE_MIN_DAYS, AUTO_CLOSE_MAX_DAYS);
  if (isObject(stored.noReplyNotify))
    form.noReplyHours = whole(stored.noReplyNotify.afterHours, NO_REPLY_MIN_HOURS, NO_REPLY_MAX_HOURS);
  if (isObject(stored.autoTag) && Array.isArray(stored.autoTag.rules)) {
    for (const r of stored.autoTag.rules.slice(0, AUTO_TAG_RULES_MAX)) {
      if (
        isObject(r) &&
        (r.in === 'subject' || r.in === 'body' || r.in === 'either') &&
        typeof r.contains === 'string' &&
        typeof r.tag === 'string'
      )
        form.rules.push({ in: r.in, contains: r.contains, tag: r.tag });
    }
  }
  return form;
}

const isBlank = (r: RuleRow): boolean => r.contains.trim() === '' && r.tag.trim() === '';

/** Why one window box cannot be saved, or null: empty is off, and everything else is a whole number in bounds. */
function windowProblem(raw: string, label: string, unit: string, min: number, max: number): string | null {
  const text = raw.trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isInteger(n)) return `${label}: whole ${unit}s only.`;
  if (n < min) return `${label}: at least ${min} ${unit}${min === 1 ? '' : 's'}. Leave it empty to switch it off.`;
  if (n > max) return `${label}: at most ${max} ${unit}s.`;
  return null;
}

/**
 * Why the form cannot be saved, or null when it can — judged here as well as at the
 * door, because a refusal from the desk names no field. This names the box.
 */
export function automationErrorOf(form: AutomationForm): string | null {
  const windowError =
    windowProblem(form.autoCloseDays, 'Auto-close', 'day', AUTO_CLOSE_MIN_DAYS, AUTO_CLOSE_MAX_DAYS) ??
    windowProblem(form.noReplyHours, 'No-reply notice', 'hour', NO_REPLY_MIN_HOURS, NO_REPLY_MAX_HOURS);
  if (windowError) return windowError;
  const rules = form.rules.filter((r) => !isBlank(r));
  if (rules.length > AUTO_TAG_RULES_MAX) return `Auto-tag: at most ${AUTO_TAG_RULES_MAX} rules.`;
  for (const [i, r] of rules.entries()) {
    if (r.contains.trim() === '') return `Auto-tag rule ${i + 1}: say what to look for.`;
    if (r.tag.trim() === '') return `Auto-tag rule ${i + 1}: say which tag to put on.`;
    if (r.contains.trim().length > AUTO_TAG_TEXT_MAX || r.tag.trim().length > AUTO_TAG_TEXT_MAX)
      return `Auto-tag rule ${i + 1}: at most ${AUTO_TAG_TEXT_MAX} characters a box.`;
  }
  return null;
}

/**
 * What Save sends under `settings`: each behaviour whole, and `null` for one whose
 * boxes are empty. A form whose rule rows are all blank is a desk with no rules, which the
 * desk hears as `autoTag: null` — never an empty list, which it refuses.
 */
export function automationPayloadOf(form: AutomationForm): AutomationSettings {
  const rules = form.rules
    .filter((r) => !isBlank(r))
    .map((r) => ({ in: r.in, contains: r.contains.trim(), tag: r.tag.trim() }));
  // `Number('')` is 0, so empty is tested first: an empty box is off, never a window of zero.
  const num = (text: string): number | null => (text.trim() === '' ? null : Number(text));
  const days = num(form.autoCloseDays);
  const hours = num(form.noReplyHours);
  return {
    autoClose: days === null ? null : { afterDays: days },
    noReplyNotify: hours === null ? null : { afterHours: hours },
    autoTag: rules.length === 0 ? null : { rules },
  };
}

/** `Last fired 3h ago, on 2 conversations.`, or `Has not fired yet.` — what a switch that may have stopped matching needs to say. */
export interface BehaviourRun {
  behaviour: string;
  last_fired_at: string;
  last_count: number;
}

export function lastFiredLabel(
  runs: readonly BehaviourRun[],
  behaviour: string,
  now: number,
): string {
  const run = runs.find((r) => r.behaviour === behaviour);
  if (!run) return 'Has not fired yet.';
  const ms = now - Date.parse(run.last_fired_at);
  const what = run.last_count === 1 ? '1 conversation' : `${run.last_count} conversations`;
  if (!Number.isFinite(ms) || ms < 60_000) return `Last fired just now, on ${what}.`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `Last fired ${mins}m ago, on ${what}.`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Last fired ${hours}h ago, on ${what}.`;
  return `Last fired ${Math.floor(hours / 24)}d ago, on ${what}.`;
}
