/**
 * The desk's service levels as the Settings form holds them (#1082).
 *
 * A leaf, for `staff.ts`'s reason: no imports at all, so the vertical's own suite can
 * import it without dragging `api.ts` (and `location` with it) into a program that has
 * no DOM. The form's whole job is translation, between the `sla` key the desk stores and
 * six boxes a person types minutes into. The translation is where it can go wrong, so it
 * lives here, where a test can reach it.
 */

export type SlaPriority = 'urgent' | 'normal' | 'low';

/** Rows in the order a support manager reads them: the tightest promise first. */
export const SLA_PRIORITIES: readonly SlaPriority[] = ['urgent', 'normal', 'low'];

/**
 * The longest target the desk accepts, in minutes: a year.
 *
 * Restated rather than imported, because `spec/model.ts` is not browser code.
 * `test/sla.test.ts` asserts that this still equals `SLA_TARGET_MAX_MINUTES`, so this is a
 * second reader of one bound, not a second bound.
 */
export const SLA_MAX_MINUTES = 525_600;

type Targets = Partial<Record<SlaPriority, number>>;

/** What `configure-desk` accepts under `settings.sla`. `null` switches service levels off. */
export interface SlaSetting {
  firstResponseMinutes?: Targets;
  resolutionMinutes?: Targets;
}

/** The six boxes, as typed. An empty string is "no target", never zero. */
export interface SlaForm {
  firstResponse: Record<SlaPriority, string>;
  resolution: Record<SlaPriority, string>;
}

const blank = (): Record<SlaPriority, string> => ({ urgent: '', normal: '', low: '' });

/**
 * The form, from the desk's stored `settings` string.
 *
 * Lenient where the desk is: a value that is not a whole number in bounds shows as an
 * empty box, which is also how the desk reads it (no target). The form then cannot
 * display a target the desk is not applying.
 */
export function slaFormOf(settings: string | null): SlaForm {
  const form: SlaForm = { firstResponse: blank(), resolution: blank() };
  let sla: unknown;
  try {
    sla = settings ? (JSON.parse(settings) as Record<string, unknown>).sla : undefined;
  } catch {
    return form;
  }
  if (sla === null || typeof sla !== 'object' || Array.isArray(sla)) return form;
  const fill = (into: Record<SlaPriority, string>, from: unknown) => {
    if (from === null || typeof from !== 'object' || Array.isArray(from)) return;
    for (const p of SLA_PRIORITIES) {
      const v = (from as Record<string, unknown>)[p];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= SLA_MAX_MINUTES) into[p] = String(v);
    }
  };
  fill(form.firstResponse, (sla as Record<string, unknown>).firstResponseMinutes);
  fill(form.resolution, (sla as Record<string, unknown>).resolutionMinutes);
  return form;
}

/**
 * Why the form cannot be saved, or null when it can.
 *
 * Judged here as well as at the door, for the reason the reaping window is: `min` and
 * `max` on a number box are advice to the browser, and a refusal from the desk names no
 * field. This names the box.
 */
export function slaErrorOf(form: SlaForm): string | null {
  for (const [label, row] of [
    ['First response', form.firstResponse],
    ['Resolution', form.resolution],
  ] as const) {
    for (const p of SLA_PRIORITIES) {
      const raw = row[p].trim();
      if (raw === '') continue;
      const n = Number(raw);
      if (!Number.isInteger(n)) return `${label}, ${p}: whole minutes only.`;
      if (n < 1) return `${label}, ${p}: at least 1 minute. Leave it empty for no target.`;
      if (n > SLA_MAX_MINUTES) return `${label}, ${p}: at most ${SLA_MAX_MINUTES} minutes (a year).`;
    }
  }
  return null;
}

/**
 * What Save sends under `settings.sla`: only the boxes that hold a number, and `null`
 * when none do.
 *
 * `null` rather than an empty object, and that is the point: the desk reads `null` as
 * "service levels off", and a form with six empty boxes is a desk that promises nothing.
 * Sent whole every time, because the desk sets this key whole. The form shows every
 * target there is, so it never overwrites one it did not display.
 */
export function slaPayloadOf(form: SlaForm): SlaSetting | null {
  const targets = (row: Record<SlaPriority, string>): Targets | undefined => {
    const out: Targets = {};
    for (const p of SLA_PRIORITIES) if (row[p].trim() !== '') out[p] = Number(row[p].trim());
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const firstResponseMinutes = targets(form.firstResponse);
  const resolutionMinutes = targets(form.resolution);
  if (!firstResponseMinutes && !resolutionMinutes) return null;
  return {
    ...(firstResponseMinutes ? { firstResponseMinutes } : {}),
    ...(resolutionMinutes ? { resolutionMinutes } : {}),
  };
}

/** `90` → `1 h 30 min`, `2880` → `2 d`: a box's minutes, read back as a duration. */
export function formatMinutes(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  return [d ? `${d} d` : '', h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min';
}

/**
 * What an inbox row says about a conversation's service levels, or null when there is
 * nothing to say.
 *
 * Read from the breach stamps alone, never from a due instant and the browser's clock.
 * The desk records a breach at one moment and on one definition (the sweep, or the late
 * reply that met it). A row that did its own arithmetic would call a conversation late a
 * few minutes before the desk did, or on a machine whose clock is wrong, and then two
 * screens would disagree about one promise.
 */
export function slaMissedLabel(c: {
  first_response_breached_at: string | null;
  resolution_breached_at: string | null;
}): string | null {
  const first = c.first_response_breached_at !== null;
  const resolution = c.resolution_breached_at !== null;
  if (first && resolution) return 'missed both targets';
  if (first) return 'missed first-response target';
  if (resolution) return 'missed resolution target';
  return null;
}
