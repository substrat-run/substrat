import type { RequestFacets, RequestRecord, RequestVolume } from './api';
import { REQUEST_FACETS, type RequestFacetKey } from './requests';

/**
 * DEV_MOCK fixtures for the Logs › Requests mode (#1746). Preview-only — nothing outside
 * `VITE_DEV_MOCK` reads this file.
 *
 * One deterministic set of requests, and all three answers computed from it the way the
 * plane computes them: the window and every facet filter apply, a facet is counted with
 * its own filter left out, and the histogram counts per level per bucket. So the preview's
 * counts, bars and rows agree with each other, which is the property the mode is built on.
 *
 * The story is the one the design tells: an assignment guard ships and `ticket0/assign`
 * starts answering 409 for part of the traffic from then on.
 */

/** [operation, weight, principal kind, surface] */
const OPS: [string, number, string, string][] = [
  ['ticket0/reply', 30, 'principal', 'app'],
  ['ticket0/list-tickets', 26, 'principal', 'app'],
  ['ticket0/assign', 14, 'principal', 'app'],
  ['ticket0/ingest-mail', 12, 'connection', 'inbound'],
  ['ticket0/assistant-answer', 8, 'principal', 'mcp'],
  ['ticket0/wake-snoozed', 6, 'system', 'app'],
  ['ticket0/csat', 4, 'capability', 'public'],
];

/** How many requests the fixture holds per hour of its span. */
const PER_HOUR = 90;
/** How far back the fixture reaches. */
const SPAN_MS = 72 * 3_600_000;

/** A small seeded generator, so the preview draws the same requests on every load. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

let cache: { anchor: number; rows: RequestRecord[] } | null = null;

/** The fixture's requests, newest first, anchored to the current hour. */
function fixture(now = Date.now()): RequestRecord[] {
  const anchor = Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;
  if (cache?.anchor === anchor) return cache.rows;
  const next = rng(1746);
  const total = OPS.reduce((n, o) => n + o[1], 0);
  // The guard ships two hours before the anchor; from then on some assignments conflict.
  const deploy = anchor - 2 * 3_600_000;
  const rows: RequestRecord[] = [];
  const count = Math.round((SPAN_MS / 3_600_000) * PER_HOUR);
  for (let i = 0; i < count; i++) {
    const t = anchor - Math.floor(next() * SPAN_MS);
    let pick = next() * total;
    const op = OPS.find((o) => (pick -= o[1]) < 0) ?? OPS[0]!;
    const [operation, , principalKind, surface] = op;
    const conflict = operation === 'ticket0/assign' && t >= deploy && next() < 0.45;
    const refused = !conflict && next() < 0.02;
    const failed = !conflict && !refused && next() < 0.006;
    const status = conflict ? 409 : refused ? 403 : failed ? 502 : 200;
    const problemCode = conflict ? 'conflict' : refused ? 'permission_denied' : failed ? 'unavailable' : null;
    const reads = operation.includes('list');
    const eventCount = status === 200 && !reads ? 1 + Math.floor(next() * 2) : 0;
    const id = `T${String(i).padStart(4, '0')}`;
    rows.push({
      timestamp: t,
      invocationId: `01J8Z${String(i).padStart(21, '0')}`,
      scopeId: null,
      vertical: 'ticket0',
      surface,
      method: reads ? 'GET' : 'POST',
      path: `/api/${operation.split('/')[1]}`,
      status,
      threw: false,
      durationMs: Math.round(40 + next() * (operation === 'ticket0/assistant-answer' ? 2400 : 320)),
      // The oldest day predates the level field: a version not re-pushed since #1746.
      level: t < anchor - 48 * 3_600_000 ? null : status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      operation,
      problemCode,
      principalKind,
      eventCount: t < anchor - 48 * 3_600_000 ? null : eventCount,
      eventTypes: eventCount > 0 ? [operation === 'ticket0/reply' ? 'ticket.replied' : 'ticket.updated'] : [],
      entities: eventCount > 0 ? [`ticket:${id}`] : [],
      versionId: t >= deploy ? 'ticket0@2.15.0' : 'ticket0@2.14.3',
    });
  }
  rows.sort((a, b) => b.timestamp! - a.timestamp!);
  cache = { anchor, rows };
  return rows;
}

type Where = Partial<Record<RequestFacetKey, string[]>>;

/** The row's value for a facet, as the plane would group it. */
function valueOf(r: RequestRecord, key: RequestFacetKey): string | null {
  const v = r[key];
  return v === null || v === undefined ? null : String(v);
}

function matches(r: RequestRecord, where: Where, window: { from: number; to: number }, omit?: RequestFacetKey): boolean {
  if (r.timestamp === null || r.timestamp < window.from || r.timestamp >= window.to) return false;
  for (const [key, values] of Object.entries(where) as [RequestFacetKey, string[]][]) {
    if (key === omit || values.length === 0) continue;
    const v = valueOf(r, key);
    if (v === null || !values.includes(v)) return false;
  }
  return true;
}

export function mockRequestVolume(where: Where, window: { from: number; to: number }, buckets: number): RequestVolume {
  const width = Math.max(1000, Math.round((window.to - window.from) / buckets / 1000) * 1000);
  const byStart = new Map<number, RequestVolume['buckets'][number]>();
  for (const r of fixture()) {
    if (!matches(r, where, window)) continue;
    const start = window.from + Math.floor((r.timestamp! - window.from) / width) * width;
    const b = byStart.get(start) ?? { start: new Date(start).toISOString(), info: 0, warn: 0, error: 0, unrecorded: 0 };
    const level = r.level === 'info' || r.level === 'warn' || r.level === 'error' ? r.level : 'unrecorded';
    b[level] += 1;
    byStart.set(start, b);
  }
  return { bucketMs: width, buckets: [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start)), estimated: false };
}

export function mockRequestFacets(where: Where, window: { from: number; to: number }): RequestFacets {
  const rows = fixture();
  const facets: RequestFacets['facets'] = {};
  for (const { key } of REQUEST_FACETS) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      if (!matches(r, where, window, key)) continue;
      const v = valueOf(r, key);
      if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    facets[key] = [...counts.entries()]
      .map(([value, count]) => ({ value: key === 'status' ? Number(value) : value, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }
  return { total: rows.filter((r) => matches(r, where, window)).length, facets, estimated: false };
}

export function mockRequests(where: Where, window: { from: number; to: number }, limit: number): RequestRecord[] {
  return fixture()
    .filter((r) => matches(r, where, window))
    .slice(0, limit);
}

/** One request of the fixture, by its call id — what the slide-over's preview opens (#1752 §7a). */
export function mockRequestById(invocationId: string): RequestRecord | null {
  return fixture().find((r) => r.invocationId === invocationId) ?? null;
}
