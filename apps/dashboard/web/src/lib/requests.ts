import type { ObsQuery } from './observability-query';

/**
 * The Requests mode (#1746): the request record's facets, how they live in the URL, and
 * the words the rows are drawn with. Pure, so the card and its tests read the same rules.
 *
 * A facet filter is a URL key holding a comma-separated list of alternatives
 * (`?op=acme/create,acme/assign`). The plane takes each facet as a repeated query key; the
 * mapping between the two is here and nowhere else. Values under one key are OR, keys are
 * AND — the facet panel's reading, and the plane's.
 */

/** The plane's facet keys, in the order the sidebar lists them: business facets first. */
export type RequestFacetKey = 'operation' | 'problemCode' | 'principalKind' | 'status' | 'surface' | 'level' | 'kind';
export const REQUEST_FACETS: { key: RequestFacetKey; url: keyof ObsQuery; label: string; mono: boolean }[] = [
  { key: 'operation', url: 'op', label: 'Operation', mono: true },
  { key: 'problemCode', url: 'code', label: 'Problem code', mono: true },
  { key: 'principalKind', url: 'pk', label: 'Who', mono: false },
  { key: 'status', url: 'status', label: 'Status', mono: true },
  { key: 'surface', url: 'surface', label: 'Surface', mono: true },
  { key: 'level', url: 'lvl', label: 'Level', mono: false },
  // #1901: a request, or work the app ran on its own — an event consumer, a schedule.
  { key: 'kind', url: 'kind', label: 'Kind', mono: false },
];

const facetOf = (key: RequestFacetKey) => REQUEST_FACETS.find((f) => f.key === key)!;

/** One facet's selected values, as the URL holds them. */
export function selected(q: ObsQuery, key: RequestFacetKey): string[] {
  const raw = q[facetOf(key).url];
  return raw ? raw.split(',').filter((v) => v.length > 0) : [];
}

/** Every facet filter the URL carries, keyed as the plane names them. */
export function whereOf(q: ObsQuery): Partial<Record<RequestFacetKey, string[]>> {
  const out: Partial<Record<RequestFacetKey, string[]>> = {};
  for (const f of REQUEST_FACETS) {
    const values = selected(q, f.key);
    if (values.length > 0) out[f.key] = values;
  }
  return out;
}

/** The URL patch that ticks or unticks one value. Unticking the last one removes the key. */
export function toggleFacet(q: ObsQuery, key: RequestFacetKey, value: string): Partial<ObsQuery> {
  const now = selected(q, key);
  const next = now.includes(value) ? now.filter((v) => v !== value) : [...now, value];
  return { [facetOf(key).url]: next.length > 0 ? next.join(',') : undefined };
}

/** The URL keys every request facet lives under — what `Clear` removes in this mode. */
export const REQUEST_URL_KEYS: (keyof ObsQuery)[] = REQUEST_FACETS.map((f) => f.url);

/** The query bar's chips for the Requests mode: one per facet, its values joined. */
export function requestChips(q: ObsQuery): { key: string; value: string; clears: (keyof ObsQuery)[] }[] {
  return REQUEST_FACETS.flatMap((f) => {
    const values = selected(q, f.key);
    if (values.length === 0) return [];
    const shown = values.map((v) => facetValueLabel(f.key, v));
    return [{ key: f.label.toLowerCase(), value: shown.join(' or '), clears: [f.url] }];
  });
}

/**
 * The query string for one request read: the window, the facet filters as repeated keys,
 * and the read's own knob. The window is the page's — the two instants when there is a
 * cursor, the hours preset otherwise, never both.
 */
export function requestReadQuery(
  q: ObsQuery,
  window: { since?: string; until?: string; hours?: number },
  extra: Record<string, string | number | readonly string[]> = {},
): URLSearchParams {
  const p = new URLSearchParams();
  if (window.since && window.until) {
    p.set('since', window.since);
    p.set('until', window.until);
  } else if (window.hours) {
    p.set('hours', String(window.hours));
  }
  for (const [key, values] of Object.entries(whereOf(q))) for (const v of values) p.append(key, v);
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) for (const x of v) p.append(k, String(x));
    else p.set(k, String(v));
  }
  return p;
}

/**
 * Who a request ran as, in the design's words. The kinds are the stub's subject kinds; an
 * unknown one is shown as itself rather than guessed at.
 */
export function principalKindLabel(kind: string): string {
  switch (kind) {
    case 'principal':
      return 'person';
    case 'system':
      return 'scheduled job';
    case 'connection':
      return 'connector';
    case 'capability':
      return 'shared link';
    case 'vertical':
      return 'another app';
    default:
      return kind;
  }
}

/** How a facet value reads in the sidebar. */
export function facetValueLabel(key: RequestFacetKey, value: string | number): string {
  if (key === 'principalKind') return principalKindLabel(String(value));
  if (key === 'kind') return kindLabel(String(value));
  return String(value);
}

/** #1901: what kind of work a row is, in the page's words. */
export function kindLabel(kind: string): string {
  return kind === 'consumer' ? 'event consumer' : kind;
}

/**
 * What a row names: the operation a request ran (or its method and path), the consumer and
 * the event it was handed, or the schedule (#1901).
 */
export function rowLabel(r: {
  kind?: string;
  operation: string | null;
  method: string | null;
  path: string | null;
  eventType?: string | null;
}): string {
  if (r.kind === 'consumer') return `${r.operation ?? '—'} ← ${r.eventType ?? '?'}`;
  return r.operation ?? (r.method && r.path ? `${r.method} ${r.path}` : '—');
}

/** The level colours the histogram stacks and the rows mark with — the design's. */
export const LEVEL_COLORS: Record<'info' | 'warn' | 'error' | 'unrecorded', string> = {
  info: 'var(--text-tertiary)',
  warn: 'var(--status-warning-fg)',
  error: 'var(--status-danger-fg)',
  unrecorded: 'var(--border-strong)',
};

/**
 * A request's result, as its row says it: the status and the problem code when there is
 * one (`409 conflict`), `threw` for an escaped crash. `tone` picks the colour.
 */
export function resultLabel(r: {
  status: number | null;
  threw: boolean;
  problemCode: string | null;
  kind?: string;
  outcome?: string | null;
  level?: string | null;
  attempt?: number | null;
}): {
  text: string;
  tone: 'ok' | 'warn' | 'error';
} {
  // #1901: async work answered no caller, so it has no status: its outcome is the result,
  // and its level says how loud — `inert` and a dead letter are warnings, a throw an error.
  if (r.kind && r.kind !== 'request') {
    const outcome = r.outcome ?? '—';
    const retried = r.attempt && r.attempt > 1 ? ` #${r.attempt}` : '';
    const text = `${outcome}${retried}${r.problemCode ? ` ${r.problemCode}` : ''}`;
    return { text, tone: r.level === 'error' ? 'error' : r.level === 'warn' ? 'warn' : 'ok' };
  }
  if (r.threw || r.status === null) return { text: 'threw', tone: 'error' };
  const text = r.problemCode ? `${r.status} ${r.problemCode}` : r.status < 400 ? `${r.status} ok` : String(r.status);
  if (r.status >= 500) return { text, tone: 'error' };
  if (r.status >= 400 || r.problemCode) return { text, tone: 'warn' };
  return { text, tone: 'ok' };
}

/** A duration as a row says it: ms below a second, seconds from there. */
export function durationLabel(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

/** A bucket width as the histogram's caption says it: "2 min", "30 s", "1 h". */
export function bucketWidthLabel(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

/**
 * A time-axis end as the histogram labels it, in UTC like every clock on these pages. A
 * window of half a day or more carries the date: two bare clocks a day apart read the same.
 */
export function axisLabel(t: number, spanMs: number): string {
  const iso = new Date(t).toISOString();
  return spanMs >= 12 * 3_600_000 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 19);
}
