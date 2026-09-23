export interface ObsQuery {
  app?: string;
  view?: string;
  type?: string;
  from?: string;
  to?: string;
  hours?: string;
  level?: string;
  search?: string;
  invocationId?: string;
  groupBy?: string;
  field?: string;
}
export const OBS_KEYS = [
  'app',
  'view',
  'type',
  'from',
  'to',
  'hours',
  'level',
  'search',
  'invocationId',
  'groupBy',
  'field',
] as const;
export function readObsQuery(search: string): ObsQuery {
  const p = new URLSearchParams(search);
  return Object.fromEntries(OBS_KEYS.flatMap((k) => (p.get(k) ? [[k, p.get(k)!]] : [])));
}
export function queryWindow(q: ObsQuery, now = Date.now()): { since: string; until: string } {
  if (!!q.from !== !!q.to) throw new Error('Enter both start and end timestamps.');
  if (q.from && q.to) {
    const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
    const start = Date.parse(q.from),
      end = Date.parse(q.to);
    const calendar = (s: string) =>
      Number.isFinite(Date.parse(s)) &&
      new Date(s.slice(0, 10) + 'T00:00:00Z').toISOString().slice(0, 10) === s.slice(0, 10);
    if (
      !iso.test(q.from) ||
      !iso.test(q.to) ||
      !calendar(q.from) ||
      !calendar(q.to) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      end - start > 72 * 3_600_000 ||
      end > now + 300_000
    )
      throw new Error(
        'Choose valid timezone-qualified timestamps, ordered within 72 hours and ending no later than five minutes from now.',
      );
    return { since: new Date(start).toISOString(), until: new Date(end).toISOString() };
  }
  const hours = Number(q.hours ?? 24);
  if (![1, 24, 72].includes(hours)) throw new Error('Choose a 1h, 24h or 3d range.');
  // Seconds are the telemetry store's timestamp precision.
  const end = Math.floor(now / 1000) * 1000;
  return { since: new Date(end - hours * 3_600_000).toISOString(), until: new Date(end).toISOString() };
}
export const exactTime = (iso: string) => new Date(iso).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
/** Coordinate selection is independent of bucket size: the backend queries partial edge buckets. */
export function dragWindow(a: number, b: number, width: number, window: { since: string; until: string }) {
  if (width <= 0 || Math.abs(b - a) < 5) return null;
  const start = Date.parse(window.since),
    span = Date.parse(window.until) - start;
  const at = (x: number) => Math.round((start + Math.max(0, Math.min(1, x / width)) * span) / 1000) * 1000;
  const from = Math.max(start, at(Math.min(a, b))),
    to = Math.min(start + span, at(Math.max(a, b)));
  return to > from ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() } : null;
}
