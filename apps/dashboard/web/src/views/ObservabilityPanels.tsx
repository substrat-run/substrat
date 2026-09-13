import { useEffect, useState } from 'react';
import { Button, Input, Select } from '@substrat-run/ui';
import { type EventFacetResult, api, ApiError, type ObservabilityLogEvent, type TenantMetricsRow } from '../lib/api';
import { DEV_MOCK, MOCK_INSTALLED_APP_SCOPE, MOCK_OBSERVABILITY_LOGS, MOCK_TENANT_METRICS } from '../lib/mock';
import { GridTable, Row } from '../components/layout';
import { card, MonoTag } from '../components/ui';
import { LogList } from '../components/LogList';
import { navigate, teamPath } from '../lib/router';

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
  const t = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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
export function TenantTrafficTable({ scopeId, hours, nonce }: { scopeId: string; hours: number; nonce: number }) {
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
        const r = DEV_MOCK ? MOCK_TENANT_METRICS : await api.appTenantMetrics(scopeId, hours);
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
  }, [scopeId, hours, nonce]);

  if (state === 'absent') {
    return (
      <div style={{ padding: '24px 0', color: 'var(--text-tertiary)', fontSize: 13 }}>
        Observability is not configured on this platform.
      </div>
    );
  }

  const fleetPath = owned === true && slug ? `/verticals/${encodeURIComponent(slug)}` : null;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          What the router dispatched to this app in the {windowLabel(hours)}, by the surface that answered.
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
  scopeId,
  hours,
  nonce,
  hadTraffic,
  window: cursor,
}: {
  scopeId: string;
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
}) {
  const [level, setLevel] = useState(LEVELS[0]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
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
  }, [scopeId, level, search, hours, nonce, cursor?.from, cursor?.to]);

  return (
    <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>Logs</span>
        <MonoTag>this app</MonoTag>
        <Select
          aria-label="Level"
          options={LEVELS}
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          style={{ width: 110 }}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim());
          }}
          style={{ display: 'flex', gap: 8, flex: 1, minWidth: 220 }}
        >
          <Input
            aria-label="Search messages"
            placeholder="Filter messages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1 }}
          />
          {/* No explicit type: the native default inside a form is `submit`. */}
          <Button variant="ghost" size="sm">
            Search
          </Button>
        </form>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {cursor ? `around ${cursorLabel(cursor)}` : `${windowLabel(hours)}, newest 100`}
        </span>
      </div>
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
        <LogList events={logs} />
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
  scopeId,
  hours,
  focusEventType,
  window: cursor,
}: {
  scopeId: string;
  hours: number;
  focusEventType?: string;
  /** The page's time cursor. Its facet read already spoke in two instants, so this is
   *  only a question of WHICH two — and of the header naming the one it answered. */
  window?: { from: string; to: string };
}) {
  const [groupBy, setGroupBy] = useState('type');
  const [field, setField] = useState('');
  // Seeded from the flow map's deep link when there is one. A type arriving this way is
  // ALREADY applied — the reader asked for it by following the link, so making them press
  // Group again would be asking the same question twice.
  const [type, setType] = useState(focusEventType ?? '');
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
    groupBy: 'type',
    field: '',
    type: focusEventType ?? '',
    hours,
    ...facetWindow(hours, cursor),
  }));
  const submit = () =>
    setApplied({
      groupBy,
      field: field.trim(),
      type: type.trim(),
      hours,
      ...facetWindow(hours, cursor),
    });

  // A second link followed while the panel is open changes the prop and nothing else —
  // without this the controls would update and the counts would stay the first type's.
  useEffect(() => {
    if (focusEventType === undefined) return;
    setType(focusEventType);
    setApplied((a) => (a.type === focusEventType ? a : { ...a, type: focusEventType, field: '' }));
  }, [focusEventType]);

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
    api
      .appFacets(scopeId, {
        groupBy: applied.field ? undefined : applied.groupBy,
        field: applied.field || undefined,
        type: applied.type || undefined,
        since: applied.since,
        until: applied.until,
      })
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
  }, [scopeId, applied]);

  const widest = Math.max(1, ...(result?.buckets ?? []).map((b) => b.count));

  /**
   * The card stays and says what is missing, rather than hiding: a page one row shorter
   * with nothing accounting for the gap reads as a page that failed to load. What it
   * does NOT do is keep the controls — a query nothing can answer is not a query, and
   * relaying the vertical's own refusal ("… does not implement GET /internal/facets")
   * described the transport where the reader needed the fact about their app.
   */
  if (absent) {
    return (
      <div style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Events</h3>
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          This app publishes no event stream, so there is nothing to group. An app that is
          not built on the kernel keeps no event spine &mdash; an auth server holds accounts,
          not an outbox &mdash; and an app last pushed before the explorer shipped answers the
          same way, which a newer push fixes.
        </p>
      </div>
    );
  }

  return (
    <div style={{ ...card, padding: 14, display: 'grid', gap: 10 }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 15 }}>Events</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Group this app&rsquo;s events by a dimension or a payload field, and count them.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Select
          aria-label="Group by dimension"
          options={[
            { value: 'type', label: 'Event type' },
            { value: 'operation', label: 'Operation' },
            { value: 'actor', label: 'Actor' },
            { value: 'version', label: 'Version' },
            { value: 'entityType', label: 'Entity type' },
            { value: 'piiClass', label: 'PII class' },
          ]}
          value={groupBy}
          // Choosing a dimension CLEARS the payload field, because submit gives the field
          // precedence: leaving both set would group by the old field while the select
          // showed the new dimension, and the header would agree with the select.
          onChange={(e) => {
            setGroupBy(e.target.value);
            setField('');
          }}
          style={{ width: 150 }}
        />
        <Input
          mono
          aria-label="Group by payload field"
          value={field}
          onChange={(e) => setField(e.target.value)}
          placeholder="…or a top-level payload field"
          style={{ width: 190 }}
        />
        <Input
          mono
          aria-label="Narrow to one event type"
          value={type}
          onChange={(e) => setType(e.target.value)}
          placeholder="event type (optional)"
          style={{ width: 200 }}
        />
        <Button size="sm" variant="ghost" onClick={submit}>
          Group
        </Button>
      </div>

      {err && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>{err}</div>}

      {loading && !err && <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Grouping…</div>}

      {result && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {result.total.toLocaleString()} event{result.total === 1 ? '' : 's'} matched{' '}
            {applied.cursored
              ? `around ${cursorLabel({ from: applied.since, to: applied.until })}`
              : `in the ${windowLabel(applied.hours)}`}
            {result.erased > 0 && (
              <span style={{ color: 'var(--status-warning-fg)' }}>
                {' '}· {result.erased.toLocaleString()} with an erased payload, counted apart and not grouped
              </span>
            )}
            {result.truncated && <span> · showing the largest buckets only</span>}
          </div>
          {result.buckets.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
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
            <div style={{ display: 'grid', gap: 4 }}>
              {result.buckets.map((b) => (
                <div key={b.value ?? '\u0000null'} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', minWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: b.value === null ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                    {/* "No value extracted", which is weaker than absent: SQLite returns
                        the same null for a missing key and for an explicit JSON null.
                        What it is NOT is erased — that count is above, and the two are
                        different answers. */}
                    {b.value ?? 'no value'}
                  </span>
                  <span style={{ flex: 1, height: 6, background: 'var(--surface-inset)', borderRadius: 3, overflow: 'hidden' }}>
                    <span style={{ display: 'block', width: `${(b.count / widest) * 100}%`, height: '100%', background: 'var(--brand-500)' }} />
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)', minWidth: 56, textAlign: 'right' }}>
                    {b.count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
