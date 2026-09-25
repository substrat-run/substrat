import { exactTime, type ObsQuery } from '../lib/observability-query';
import { useEffect, useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import { type EventFacetResult, api, ApiError, type ObservabilityLogEvent, type TenantMetricsRow } from '../lib/api';
import { DEV_MOCK, MOCK_INSTALLED_APP_SCOPE, MOCK_OBSERVABILITY_LOGS, MOCK_TENANT_METRICS } from '../lib/mock';
import { GridTable, Row } from '../components/layout';
import { card, MonoTag } from '../components/ui';
import { LogList } from '../components/LogList';
import { navigate, teamPath } from '../lib/router';
import { EVENT_GROUPS, bucketRows, dimensionLabel, type BucketRow, type EventGroup } from '../lib/log-stream';
import { mockEventFacets } from '../lib/mock-events';

/**
 * The panels the team Observability page composes for ONE app (#1447) — its traffic per
 * surface, its logs, and the event explorer.
 *
 * Each takes the page's window rather than carrying a time control of its own. Three
 * clocks on one screen was what the app tab got wrong, and a shared axis is the whole
 * reason these moved onto one page.
 *
 * All three are the TENANT grain. The builder's per-version numbers used to live beside
 * them here and no longer do: a script serves every team that installed the vertical, so
 * those are a fact about the code and they belong on the Vertical page, where the fleet
 * question is already asked. The traffic panel links up to it for an owned vertical.
 */

const LEVELS = ['All levels', 'error', 'warn', 'info', 'log', 'debug'];

/** The page's window, as a panel's own header says it. Capped at 72h by the plane. */
function windowLabel(hours: number): string {
  if (hours === 1) return 'last hour';
  if (hours % 24 === 0) return `last ${hours / 24 === 1 ? 'day' : `${hours / 24} days`}`;
  return `last ${hours} hours`;
}

/**
 * The time cursor's window, as a panel's header says it (#1447 step 3c) — the two
 * instants rather than a duration, because "the last day" and "10:05–10:15" are different
 * claims and a panel answering the second must not caption itself with the first.
 */
function cursorLabel(w: { from: string; to: string }): string {
  const t = exactTime;
  return `${t(w.from)}–${t(w.to)}`;
}

/**
 * One installed app's traffic, split by the surface that answered — the tenant grain
 * (observability.md §3 view 4).
 *
 * This is narrower than the fleet numbers a vertical's builder reads, and more accurate
 * here for exactly that reason: it is keyed on this installation rather than on a script
 * shared with every other team that installed the same vertical. Two teams running the
 * same vertical see two different tables.
 *
 * What is deliberately absent is the per-version breakdown. A version is a fact about the
 * code — for an app running someone else's vertical the code is not this team's, and for
 * one this team publishes the link below goes where that question is already answered.
 */
export function TenantTrafficTable({ scopeId, hours, nonce, window }: { scopeId: string; hours: number; nonce: number; window?: { since: string; until: string } }) {
  const [rows, setRows] = useState<TenantMetricsRow[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'absent' | 'error'>('loading');
  // `false` only when the per-app deployments read says the vertical is someone else's.
  // That is what decides whether there is a fleet view to offer at all.
  const [owned, setOwned] = useState<boolean | null>(null);
  const [slug, setSlug] = useState<string | null>(null);

  useEffect(() => {
    if (DEV_MOCK) {
      // Fixture-driven rather than a flat `true`: one mock scope runs another team's
      // vertical (`MOCK_INSTALLED_APP_SCOPE`), which is the only way the dev preview can
      // show this panel both with and without its fleet link.
      setOwned(scopeId !== MOCK_INSTALLED_APP_SCOPE);
      setSlug('acme/helpdesk');
      return;
    }
    let live = true;
    setOwned(null);
    setSlug(null);
    api
      .appDeployments(scopeId)
      .then((d) => {
        if (!live) return;
        setOwned(d.owned !== false);
        setSlug(d.slug);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [scopeId]);

  useEffect(() => {
    let live = true;
    setState('loading');
    // Cleared with the state, not left in place: the loader only shows over an EMPTY
    // table, so keeping the old rows would leave one app's totals on screen under the
    // heading of another until the new read lands — the misreading this page exists
    // to prevent.
    setRows(null);
    void (async () => {
      try {
        const r = DEV_MOCK ? MOCK_TENANT_METRICS : await api.appTenantMetrics(scopeId, hours, window);
        if (!live) return;
        setRows(r);
        setState('ready');
      } catch (e) {
        if (!live) return;
        setState(e instanceof ApiError && e.status === 501 ? 'absent' : 'error');
      }
    })();
    return () => {
      live = false;
    };
  }, [scopeId, hours, nonce, window?.since, window?.until]);

  if (state === 'absent') {
    return (
      <div style={{ padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
        Traffic queries are not available on this platform for this window.
      </div>
    );
  }

  const fleetPath = owned === true && slug ? `/verticals/${encodeURIComponent(slug)}` : null;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          What the router dispatched to this app in {window ? `${exactTime(window.since)} – ${exactTime(window.until)}` : windowLabel(hours)}, by the surface that answered. P50 is median latency; P95 is the 95th percentile. These are sampled estimates.
        </span>
        <div style={{ flex: 1 }} />
        {fleetPath && (
          // The builder's question — how is the CODE doing across every team that installed
          // it — is answered on the vertical, not here. This page is one installation, for
          // its publisher too; the link is what makes that a narrowing rather than a loss.
          <a
            href={teamPath(fleetPath)}
            onClick={(e) => {
              e.preventDefault();
              navigate(fleetPath);
            }}
            style={{ color: 'var(--text-brand)', fontSize: 12.5, whiteSpace: 'nowrap' }}
          >
            ↑ Fleet view on the vertical
          </a>
        )}
      </div>

      {state === 'error' ? (
        <div style={{ padding: '12px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
          Traffic data is unavailable right now.
        </div>
      ) : state === 'loading' && rows === null ? (
        <div style={{ padding: '12px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</div>
      ) : rows && rows.length === 0 ? (
        <div style={{ padding: '12px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
          No traffic recorded in this window.
        </div>
      ) : (
        <GridTable
          columns="0.8fr 1fr 0.8fr 0.9fr 0.9fr 0.9fr"
          header={['Surface', 'Requests', 'Errors', 'Error rate', 'P50', 'P95']}
        >
          {(rows ?? []).map((r, i) => (
            <Row key={`${r.scopeId}:${r.surface}`} columns="0.8fr 1fr 0.8fr 0.9fr 0.9fr 0.9fr" last={i === (rows ?? []).length - 1}>
              <MonoTag>{r.surface ?? '—'}</MonoTag>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{r.requests.toLocaleString('en-US')}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: r.errors > 0 ? 'var(--status-danger-fg)' : undefined }}>
                {r.errors.toLocaleString('en-US')}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
                {r.requests === 0 ? '—' : `${((r.errors / r.requests) * 100).toFixed(2)}%`}
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{Math.round(r.durationP50)} ms</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{Math.round(r.durationP95)} ms</span>
            </Row>
          ))}
        </GridTable>
      )}
    </div>
  );
}

/**
 * One installed app's log lines, level- and text-filtered, newest first.
 *
 * At script grain the lines belong to the vertical's builder and still do. What this
 * shows is the subset written while serving THIS app, which is the viewing team's to read.
 */
export function TenantLogs({
  filters, onFilters,
  scopeId,
  hours,
  nonce,
  hadTraffic,
  window: cursor,
  embedded = false,
}: {
  scopeId: string;
  filters?: ObsQuery;
  onFilters?: (filters: Partial<ObsQuery>) => void;
  hours: number;
  nonce: number;
  /** Whether the page's chart saw any request for this app in the window. It decides
   *  which of two very different empty states this panel shows; undefined means the
   *  chart could not say, and then the panel claims neither. */
  hadTraffic?: boolean;
  /** The page's time cursor. The window this panel reads is the cursor's when there is
   *  one and the page's range when there is not — never both, since `hours` can only
   *  end at now and would silently overrule an instant in the past. */
  window?: { from: string; to: string };
  /** Drawn as the Lines mode of the Logs stream card (#1767): the card and its tab
   *  already say what this is, so the panel drops its own frame and title. */
  embedded?: boolean;
}) {
  const [localLevel, setLevel] = useState(LEVELS[0]);
  const level = filters ? (filters.level || LEVELS[0]) : localLevel;
  const [query, setQuery] = useState('');
  const [localSearch, setSearch] = useState('');
  const search = filters ? (filters.search ?? '') : localSearch;
  const [invocation, setInvocation] = useState(filters?.invocationId ?? '');
  useEffect(() => { setQuery(search); setInvocation(filters?.invocationId ?? ''); }, [search, filters?.invocationId]);
  const [logs, setLogs] = useState<ObservabilityLogEvent[] | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLogs(null);
    setLogsError(null);
    void (async () => {
      try {
        const events = DEV_MOCK
          ? MOCK_OBSERVABILITY_LOGS.filter(
              (l) =>
                (level === LEVELS[0] || l.level === level) &&
                (!search || (l.message ?? '').includes(search)) &&
                // The preview narrows too, so a bar click visibly does something without
                // a plane behind it.
                (!cursor ||
                  (l.timestamp !== null &&
                    l.timestamp >= Date.parse(cursor.from) &&
                    l.timestamp <= Date.parse(cursor.to))),
            )
          : await api.appTenantLogs(scopeId, {
              level: level === LEVELS[0] ? undefined : level,
              search: search || undefined,
              // The cursor's window REPLACES the range; sending both would let `hours`,
              // which always ends at now, overrule the instant the reader clicked on.
              ...(cursor ? { since: cursor.from, until: cursor.to } : { hours }),
              limit: 100,
              invocationId: filters?.invocationId,
            });
        if (live) setLogs(events);
      } catch (e) {
        if (!live) return;
        // Surface WHY, not a blanket "unavailable" — the plane's status is the whole
        // signal (501 = not configured, 5xx = an upstream/query failure worth reporting).
        // The plane returns sanitized bodies, so `e.message` is safe to show.
        setLogsError(
          e instanceof ApiError
            ? e.status === 501
              ? 'Log streaming is not configured on this platform.'
              : `Logs are unavailable (${e.status}): ${e.message}`
            : 'Logs are unavailable right now.',
        );
      }
    })();
    return () => {
      live = false;
    };
  }, [scopeId, level, search, hours, nonce, cursor?.from, cursor?.to, filters?.invocationId]);

  return (
    <div style={embedded ? {} : { ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
        {!embedded && <span style={{ fontSize: 13, fontWeight: 600 }}>Logs</span>}
        {!embedded && <MonoTag>this app</MonoTag>}
        <Select
          ariaLabel="Level"
          options={LEVELS}
          value={level}
          onChange={(e) => onFilters ? onFilters({ level: e.target.value === LEVELS[0] ? undefined : e.target.value }) : setLevel(e.target.value)}
          style={{ width: 110 }}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (onFilters) onFilters({ search: query.trim() || undefined, invocationId: invocation.trim() || undefined });
            else setSearch(query.trim());
          }}
          style={{ display: 'flex', gap: 8, flex: 1, minWidth: 220 }}
        >
          <Input
            ariaLabel="Search messages"
            placeholder="Message contains (case-sensitive)…"
            maxLength={200}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1 }}
          />
          {onFilters && <Input ariaLabel="Invocation ID" placeholder="Invocation ULID (optional)" pattern="[0-7][0-9A-HJKMNP-TV-Z]{25}" value={invocation} onChange={(e) => setInvocation(e.target.value)} />}
          {/* No explicit type: the native default inside a form is `submit`. */}
          <Button variant="ghost" size="sm">
            Search
          </Button>
        </form>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {cursor ? `around ${cursorLabel(cursor)}` : `${windowLabel(hours)}, newest 100`}
        </span>
      </div>
      <p style={{ padding: '0 14px', fontSize: 12 }}>Up to 100 recent lines from bounded invocation discovery (40 invocations, normally 20 lines each). Filters search that bounded coverage, not an exhaustive log archive. Empty results do not establish that no matching event occurred. Retention and sampling depend on the backend.</p>
      {onFilters && <button style={{ margin: '0 14px 10px' }} onClick={() => onFilters({ level: undefined, search: undefined, invocationId: undefined })}>Clear log filters</button>}
      {logsError ? (
        <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>{logsError}</div>
      ) : logs === null ? (
        <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading…</div>
      ) : logs.length === 0 ? (
        <div style={{ padding: 14, fontSize: 13, color: 'var(--text-tertiary)' }}>
          {/* Two very different reasons for an empty list, and conflating them sent the
              last reader looking in the wrong place. Traffic with no lines means the
              version serving this app predates the stamped invocation line, so there is
              nothing to correlate — a re-push fixes it. No traffic means no traffic. */}
          {/* Under a cursor the hint is withheld, not because it stopped being true but
              because `hadTraffic` is a fact about the page's whole RANGE: attaching it to
              a ten-minute window would answer a question about minutes with evidence
              about days. */}
          {hadTraffic && !cursor
            ? 'No log events in this window. If this app’s version was deployed before per-request logging, its lines are not attributed to your team yet — a new deploy of the vertical starts that.'
            : 'No log events in this window.'}
        </div>
      ) : (
        <LogList events={logs} onFilter={onFilters} />
      )}
    </div>
  );
}

/**
 * A window's two bounds, both derived from ONE instant — ISO 8601 text, the way the
 * spine stores time, never epoch ms.
 *
 * Closing the window at submit time is what makes the counts reproducible: an open
 * upper bound means a re-run of the same question answers about a slightly different
 * slice, and the difference shows up as a count that moved for no reason the reader
 * can see.
 *
 * The explorer's own window select went with the shared axis (#1447) — the page has one
 * time range and every panel answers about the same slice. "All time" went with it: a
 * count over everything the scope still holds is a different claim from a count over the
 * page's window, and one axis cannot caption both.
 */
function facetWindow(
  hours: number,
  cursor?: { from: string; to: string },
): Pick<AppliedFacet, 'since' | 'until' | 'cursored'> {
  // A cursor already IS two closed instants, so it needs no closing of its own — and
  // taking it verbatim is what makes this panel and the log panel beside it answer about
  // the same minutes rather than two windows that merely started together.
  if (cursor) return { since: cursor.from, until: cursor.to, cursored: true };
  const until = Date.now();
  return {
    since: new Date(until - hours * 3_600_000).toISOString(),
    until: new Date(until).toISOString(),
    cursored: false,
  };
}

/** The submitted query — what the counts on screen are an answer to. */
interface AppliedFacet {
  groupBy: string;
  field: string;
  type: string;
  since: string;
  until: string;
  /** The window as it was at SUBMIT, carried so the header names the window the counts
   *  answer about rather than whatever the page's range shows now. */
  hours: number;
  /** Whether that window came from the time cursor. It decides how the header SAYS the
   *  window, and "the last 3 days" over a ten-minute count is the one caption that would
   *  make the number a lie. */
  cursored: boolean;
}

/**
 * The event explorer (#1239 stage 1): narrow this app's outbox, group it, count.
 *
 * A payload grouping is by a TOP-LEVEL field. Nested paths are a deliberate v1
 * omission (`eventFacetGroupBy`), not an oversight — one level answers "which
 * currency", and deeper paths want their own thought about arrays.
 * "Which operation emits most of this?", "which version were these under?" —
 * the questions nobody predicted, answered on what the spine already holds.
 *
 * Two things the UI is careful to say rather than imply:
 *
 * **An erased payload is not a missing value.** Grouping by a payload field over
 * a shredded event yields the same null a never-present key does, so the reader
 * counts them apart and this shows the erased count beside the buckets. Without
 * it a distribution over redacted history looks complete.
 *
 * **A truncated result says so.** Buckets are capped; a tail that exists and is
 * not shown must not read as a tail that does not exist.
 */
export function EventExplorer({
  nonce = 0, query, onQuery,
  scopeId,
  hours,
  focusEventType,
  window: cursor,
  embedded = false,
}: {
  scopeId: string;
  hours: number;
  focusEventType?: string;
  /** Drawn as the Events mode of the Logs stream card (#1767), which supplies the frame. */
  embedded?: boolean;
  nonce?: number;
  query?: ObsQuery;
  onQuery?: (q: Partial<ObsQuery>) => void;
  /** The page's time cursor. Its facet read already spoke in two instants, so this is
   *  only a question of WHICH two — and of the header naming the one it answered. */
  window?: { from: string; to: string };
}) {
  const [groupBy, setGroupBy] = useState(query?.groupBy ?? 'type');
  const [field, setField] = useState(query?.field ?? '');
  const [result, setResult] = useState<EventFacetResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /**
   * The app serves no event reads at all — a 501 from its own deployment, which is a
   * fact about the app and not a failure of this query. Kept apart from `err` because
   * the two want opposite screens: an error invites a retry, and there is nothing here
   * to retry. Not every installed app is a kernel vertical (an auth server holds
   * accounts, not an outbox), and an app deployed before the explorer existed answers
   * the same way, so this states the absence rather than relaying the refusal.
   */
  const [absent, setAbsent] = useState(false);

  // The whole query is applied on submit rather than per keystroke: each one is a scope
  // read, and a half-typed field name is a query nobody asked for. `since` is resolved
  // HERE, at submit, so the window is the one the reader chose and not one that slides
  // out from under the answer on the next render.
  const [applied, setApplied] = useState<AppliedFacet>(() => ({
    groupBy: query?.groupBy ?? 'type',
    field: query?.field ?? '',
    // Seeded from the flow map's deep link when there is one. A type arriving this way is
    // ALREADY applied — the reader asked for it by following the link, so making them press
    // Group again would be asking the same question twice.
    type: query?.type ?? focusEventType ?? '',
    hours,
    ...facetWindow(hours, cursor),
  }));
  /**
   * "Payload field" picked but no field named yet. Kept apart from `field` because a
   * half-chosen grouping is not a query: the bars stay on the last answer until a field
   * is submitted, and the header keeps saying which grouping they answer.
   */
  const [fieldMode, setFieldMode] = useState(false);
  // Every change to the question lands in the URL, so a grouping is a link like any other
  // view. The window is re-resolved here for the reason `facetWindow` gives.
  const apply = (next: { groupBy: string; field: string; type: string }) => {
    onQuery?.({ groupBy: next.groupBy, field: next.field || undefined, type: next.type || undefined });
    setGroupBy(next.groupBy);
    setField(next.field);
    setApplied({ ...next, hours, ...facetWindow(hours, cursor) });
  };
  const submitField = () => {
    const f = field.trim();
    if (f) apply({ groupBy, field: f, type: applied.type });
  };
  useEffect(() => {
    const nextType = query?.type ?? focusEventType ?? '';
    const nextGroupBy = query?.groupBy ?? 'type';
    const nextField = query?.field ?? '';
    setGroupBy(nextGroupBy); setField(nextField); setFieldMode(false);
    setApplied((a) => a.type === nextType && a.groupBy === nextGroupBy && a.field === nextField
      ? a : { ...a, type: nextType, groupBy: nextGroupBy, field: nextField });
  }, [query?.type, query?.groupBy, query?.field, focusEventType]);

  // The page's range moved, so the standing question is re-asked over the new window
  // rather than left captioned with the old one: a range control and a count on the same
  // screen have to be a question and its answer. Under a cursor the range is not the
  // window, so `hours` is recorded and the instants are left alone.
  useEffect(() => {
    setApplied((a) => (a.hours === hours ? a : { ...a, hours, ...facetWindow(hours, cursor) }));
  }, [hours]);

  // The cursor moved (another bar, another marker, or the × that clears it) — the same
  // rule, from the other direction. No cursor and none applied is the mount case and must
  // change nothing: recomputing the trailing window there would re-run the read the
  // initial state had already asked, with a `Date.now()` a few milliseconds later.
  useEffect(() => {
    setApplied((a) => {
      if (!cursor) return a.cursored ? { ...a, ...facetWindow(hours) } : a;
      return a.since === cursor.from && a.until === cursor.to ? a : { ...a, ...facetWindow(hours, cursor) };
    });
  }, [cursor?.from, cursor?.to]);

  useEffect(() => {
    let live = true;
    setErr(null);
    setAbsent(false);
    // The previous answer is dropped before the new one is asked for. A facet can scan a
    // lot of history, so leaving it on screen labels one query's counts with another
    // query's controls for as long as the read takes — and those counts look exactly
    // like an answer.
    setResult(null);
    setLoading(true);
    const facetQuery = {
      groupBy: applied.field ? undefined : applied.groupBy,
      field: applied.field || undefined,
      type: applied.type || undefined,
      since: applied.since,
      until: applied.until,
    };
    (DEV_MOCK ? Promise.resolve(mockEventFacets(facetQuery)) : api.appFacets(scopeId, facetQuery))
      .then((r) => live && (setResult(r), setLoading(false)))
      .catch(
        (e) =>
          live &&
          (setLoading(false),
          e instanceof ApiError && e.status === 501
            ? setAbsent(true)
            : setErr(e instanceof Error ? e.message : String(e))),
      );
    return () => {
      live = false;
    };
  }, [scopeId, applied, nonce]);

  const group: EventGroup = fieldMode || applied.field ? 'field' : (groupBy as EventGroup);
  const rows = result ? bucketRows(result, applied.field ? 'field' : (applied.groupBy as EventGroup)) : [];
  const frame = embedded ? {} : { ...card, overflow: 'hidden' as const };

  /**
   * The card stays and says what is missing, rather than hiding: a page one row shorter
   * with nothing accounting for the gap reads as a page that failed to load. What it
   * does NOT do is keep the controls — a query nothing can answer is not a query, and
   * relaying the vertical's own refusal ("… does not implement GET /internal/facets")
   * described the transport where the reader needed the fact about their app.
   */
  if (absent) {
    return (
      <div style={{ ...frame, padding: 16, display: 'grid', gap: 10 }}>
        {!embedded && <h3 style={{ margin: 0, fontSize: 15 }}>Events</h3>}
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          This app publishes no event stream, so there is nothing to group. An app that is
          not built on the kernel keeps no event spine &mdash; an auth server holds accounts,
          not an outbox &mdash; and an app last pushed before the explorer shipped answers the
          same way, which a newer push fixes.
        </p>
      </div>
    );
  }

  const columns = 'minmax(0,1fr) 72px 220px 168px';
  const windowText = applied.cursored
    ? cursorLabel({ from: applied.since, to: applied.until })
    : `The ${windowLabel(applied.hours)}`;

  return (
    <div style={frame}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Group by</span>
        <div role="group" aria-label="Group by" style={{ display: 'flex', gap: 2, padding: 2, border: '1px solid var(--border-default)', borderRadius: 8, background: 'var(--surface-inset)' }}>
          {EVENT_GROUPS.map((g) => {
            const on = group === g.value;
            return (
              <button
                key={g.value}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  if (g.value === 'field') {
                    setFieldMode(true);
                    return;
                  }
                  // A dimension CLEARS the payload field, because the read gives the
                  // field precedence: leaving both set would group by the old field while
                  // the control showed the new dimension.
                  setFieldMode(false);
                  apply({ groupBy: g.value, field: '', type: applied.type });
                }}
                style={{
                  height: 24,
                  padding: '0 9px',
                  border: 0,
                  borderRadius: 6,
                  font: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  background: on ? 'var(--surface-card)' : 'transparent',
                  boxShadow: on ? 'var(--shadow-xs)' : 'none',
                }}
              >
                {g.label}
              </button>
            );
          })}
        </div>
        {group === 'field' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitField();
            }}
            style={{ display: 'flex', gap: 6, alignItems: 'center' }}
          >
            <Input
              mono
              size="sm"
              ariaLabel="Group by payload field"
              value={field}
              onChange={(e) => setField(e.target.value)}
              placeholder="top-level field"
              style={{ width: 150 }}
            />
            <Button size="sm" variant="ghost">
              Group
            </Button>
          </form>
        )}
        {applied.type && (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 4px 0 8px', borderRadius: 999, background: 'var(--surface-brand-subtle)', border: '1px solid var(--border-brand)', fontSize: 12 }}
          >
            <span style={{ color: 'var(--text-tertiary)' }}>type</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{applied.type}</span>
            <button
              type="button"
              aria-label="Clear event type"
              title="Remove filter"
              onClick={() => apply({ groupBy: applied.groupBy, field: applied.field, type: '' })}
              style={{ width: 16, height: 16, border: 0, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1 }}
            >
              ×
            </button>
          </span>
        )}
        <span style={{ flex: 1 }} />
        {result && (
          <span data-event-totals style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{result.total.toLocaleString('en-US')}</span>{' '}
            event{result.total === 1 ? '' : 's'} ·{' '}
            {/* Erased is only ever non-zero under a payload grouping: an envelope
                dimension survives an erasure, so it is always 0 there and says so. */}
            <span style={{ fontFamily: 'var(--font-mono)', color: result.erased > 0 ? 'var(--status-warning-fg)' : undefined }}>
              {result.erased.toLocaleString('en-US')}
            </span>{' '}
            erased
            {result.truncated && <> · largest buckets only</>}
          </span>
        )}
      </div>
      {group === 'field' && (
        // Any top-level field is accepted today. Restricting this to fields the model does
        // not class as personal data is #1762; until then the note says only what holds.
        <div style={{ padding: '6px 16px', fontSize: 11.5, color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
          Groups by the value of one top-level payload field. Events whose payload was erased are counted apart, never as &ldquo;no value&rdquo;.
        </div>
      )}

      {err && <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{err}</div>}
      {loading && !err && <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>Grouping…</div>}

      {result && (
        <>
          <div
            style={{ display: 'grid', gridTemplateColumns: columns, gap: '0 12px', alignItems: 'center', height: 28, padding: '0 16px', fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}
          >
            <span>{dimensionLabel(applied.field ? 'field' : (applied.groupBy as EventGroup), applied.field)}</span>
            <span style={{ textAlign: 'right' }}>Events</span>
            <span />
            <span style={{ textAlign: 'right' }}>Last seen</span>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              {/* Empty buckets over a non-empty match is a different answer from no match
                  at all, and saying "nothing matched" under a line reading "N events
                  matched" is how a reader concludes the page is broken. Events that
                  matched and produced no bucket are the erased ones — this is the whole
                  erased-vs-absent distinction, seen from the degenerate end. */}
              {result.total === 0
                ? 'No events matched this filter.'
                : result.erased === result.total
                  ? 'Every matching event had its payload erased, so there is nothing left to group by.'
                  : 'The matching events produced no groupable value.'}
            </div>
          ) : (
            rows.map((b) => (
              <BucketLine
                key={b.key}
                row={b}
                columns={columns}
                onNarrow={
                  b.narrow
                    ? () => apply({ groupBy: b.narrow!.groupBy!, field: '', type: b.narrow!.type! })
                    : undefined
                }
              />
            ))
          )}
        </>
      )}

      <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-tertiary)' }}>
        {windowText} · erased = payload removed by an erasure request, counted apart and never grouped
        {result?.truncated ? ' · the tail beyond the largest buckets exists and is not shown' : ''}
      </div>
    </div>
  );
}

/**
 * One bucket: its value, count, a bar against the largest, and when it last fired. A
 * bucket that can be narrowed to is a button; one that cannot is plain text, since a
 * row that looks clickable and does nothing is a dead end.
 */
function BucketLine({ row, columns, onNarrow }: { row: BucketRow; columns: string; onNarrow?: () => void }) {
  const [hover, setHover] = useState(false);
  const style = {
    display: 'grid',
    gridTemplateColumns: columns,
    gap: '0 12px',
    alignItems: 'center',
    width: '100%',
    height: 34,
    padding: '0 16px',
    boxSizing: 'border-box' as const,
    border: 0,
    borderBottom: '1px solid var(--border-subtle)',
    background: onNarrow && hover ? 'var(--surface-hover)' : 'transparent',
    color: 'var(--text-primary)',
    font: 'inherit',
    textAlign: 'left' as const,
    cursor: onNarrow ? 'pointer' : 'default',
  };
  const cells = (
    <>
      {/* "no value" is the extraction-null bucket, which is weaker than absent: SQLite
          returns the same null for a missing key and an explicit JSON null. What it is
          NOT is erased — that count is in the header, and the two are different answers. */}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: row.isNull ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
        {row.label}
      </span>
      <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{row.count.toLocaleString('en-US')}</span>
      <span style={{ height: 8, borderRadius: 2, background: 'var(--surface-inset)', position: 'relative' }}>
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: row.width, borderRadius: 2, background: 'var(--brand-400)' }} />
      </span>
      <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }} title={row.lastSeen ?? undefined}>
        {row.lastSeen ? `${row.lastSeen.slice(5, 16).replace('T', ' ')} UTC` : '—'}
      </span>
    </>
  );
  if (!onNarrow) return <div style={style}>{cells}</div>;
  return (
    <button
      type="button"
      title={`Narrow to ${row.label} and group it by operation`}
      onClick={onNarrow}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={style}
    >
      {cells}
    </button>
  );
}
