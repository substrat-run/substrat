/** Absolute telemetry windows are half-open [since, until); legacy hours end at now. */
export interface ObservabilityWindowInput {
  hours: number;
  since?: string;
  until?: string;
}
export interface ObservabilityWindow {
  since: string;
  until: string;
}
export function resolveObservabilityWindow(input: ObservabilityWindowInput, now = Date.now()): ObservabilityWindow {
  if ((input.since === undefined) !== (input.until === undefined)) throw new RangeError('Supply both since and until');
  const valid = (s: string) =>
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === s.slice(0, 10);
  if (input.since !== undefined && (!valid(input.since) || !valid(input.until!)))
    throw new RangeError('Use ISO timestamps with a timezone');
  const end = input.until === undefined ? now : Date.parse(input.until);
  const start = input.since === undefined ? end - input.hours * 3_600_000 : Date.parse(input.since);
  if (!Number.isFinite(start) || start >= end || end - start > 72 * 3_600_000)
    throw new RangeError('Choose an ordered window of at most 72 hours');
  if (end > now + 5 * 60_000) throw new RangeError('The window cannot end more than five minutes in the future');
  return { since: new Date(start).toISOString(), until: new Date(end).toISOString() };
}
export function observabilityBucketMinutes(window: ObservabilityWindow): number {
  return Date.parse(window.until) - Date.parse(window.since) <= 6 * 3_600_000 ? 15 : 60;
}
