import type { OpsFailureEntry, Scope } from '@substrat-run/contracts';
import type { Deployment } from './deployments.js';

/**
 * One version as a RELEASE (#1236): the version becomes the axis every other
 * fact is read against — Sentry releases / Datadog deployment tracking, on the
 * facts the tier-1 plumbing already stamps. Nothing here is newly recorded:
 * push instants are `vertical_versions.created_at`, go-live moments are the
 * channel history, adoption is the scopes' version pins, and the health facts
 * arrive version-stamped (#1231). This view is the join that did not exist.
 */
export interface ReleaseRow {
  versionId: string;
  version: string;
  pushedAt: string;
  /** Where the push came from (`git` CI vs `cli`) — null for a pre-tracking push. */
  origin: string | null;
  /** Updating to this version crosses a migration boundary (#286). */
  schemaChange: boolean;
  /** The newest prod go-live instant for this version, null if never promoted. */
  wentLiveAt: string | null;
  /** The prod channel points here now. */
  isProd: boolean;
  /** What was last actually uploaded onto the serving script — may trail prod mid-serve. */
  isServing: boolean;
  /** Scopes PINNED to this version (excludes archived). */
  scopesPinned: number;
  /** Failure rows stamped with this version, within the record's 90-day window. */
  failures: number;
  /** 24h traffic under this version, summed across its scripts. Null = metrics unavailable. */
  requests: number | null;
  errors: number | null;
}

export interface ReleasesView {
  releases: ReleaseRow[];
  /**
   * Scopes with no version pin — they track the prod channel, so they belong to
   * whatever `isProd` points at. Kept separate rather than folded into that
   * row's count: "pinned here" and "following prod" are different operational
   * facts when deciding whether anyone is still on the broken one.
   */
  scopesTrackingProd: number;
  /** Metrics joined (false = the plane's observability is unconfigured or refused). */
  metricsAvailable: boolean;
}

/** A metrics row as the authority's version join delivers it. */
export interface ReleaseMetricsRow {
  versionId: string | null;
  requests: number;
  errors: number;
}

export function deriveReleases(input: {
  deployment: Deployment;
  /** Newest first. Structurally what the authority's history read answers — only the join's two fields are needed. */
  prodHistory: Array<{ versionId: string; at: string }>;
  scopes: Scope[];
  failures: OpsFailureEntry[];
  /** Null = the metrics read was unavailable — rendered as unknown, never as zero traffic. */
  metrics: ReleaseMetricsRow[] | null;
}): ReleasesView {
  const { deployment, prodHistory, scopes, failures, metrics } = input;
  const prod = deployment.channels.find((c) => c.channel === 'prod');

  // Newest go-live per version: history arrives newest first, first hit wins.
  const wentLive = new Map<string, string>();
  for (const h of prodHistory) {
    if (!wentLive.has(h.versionId)) wentLive.set(h.versionId, h.at);
  }

  const pinned = new Map<string, number>();
  let tracking = 0;
  for (const s of scopes) {
    if (s.archivedAt !== null) continue;
    if (s.verticalVersionId === null || s.verticalVersionId === undefined) tracking += 1;
    else pinned.set(s.verticalVersionId, (pinned.get(s.verticalVersionId) ?? 0) + 1);
  }

  const failureCounts = new Map<string, number>();
  for (const f of failures) {
    if (f.version !== null) failureCounts.set(f.version, (failureCounts.get(f.version) ?? 0) + 1);
  }

  // A version can run as several scripts at once (its archive plus the serving
  // script mid-adoption) — traffic sums across them.
  const traffic = metrics === null ? null : new Map<string, { requests: number; errors: number }>();
  if (metrics !== null && traffic !== null) {
    for (const m of metrics) {
      if (m.versionId === null) continue;
      const t = traffic.get(m.versionId) ?? { requests: 0, errors: 0 };
      t.requests += m.requests;
      t.errors += m.errors;
      traffic.set(m.versionId, t);
    }
  }

  // Newest first, owned here: the panel slices the top eight as "the latest
  // pushes", and that must not hinge on how a caller happened to order its
  // versions (`shape()` does sort, but the ledger is the one that depends on it).
  // Ids are ULIDs, so lexicographic order is chronological.
  const newestFirst = [...deployment.versions].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const releases = newestFirst.map((v): ReleaseRow => {
    const t = traffic?.get(v.id);
    return {
      versionId: v.id,
      version: v.version,
      pushedAt: v.createdAt,
      origin: v.origin?.source ?? null,
      schemaChange: v.schemaChange,
      wentLiveAt: wentLive.get(v.id) ?? null,
      isProd: prod?.versionId === v.id,
      isServing: (prod?.servingVersionId ?? null) === v.id,
      scopesPinned: pinned.get(v.id) ?? 0,
      failures: failureCounts.get(v.id) ?? 0,
      requests: traffic === null ? null : (t?.requests ?? 0),
      errors: traffic === null ? null : (t?.errors ?? 0),
    };
  });

  return { releases, scopesTrackingProd: tracking, metricsAvailable: metrics !== null };
}

/** One side of the running-vs-update comparison (#1236). Traffic nullable = metrics unavailable. */
export interface ReleaseSide {
  versionId: string;
  version: string | null;
  requests: number | null;
  errors: number | null;
  cpuTimeP50: number | null;
  cpuTimeP99: number | null;
}

export interface ReleaseComparison {
  /** Null only when the vertical has no versions at all. */
  running: ReleaseSide | null;
  /** Null = already on prod's head — nothing an update would move to. */
  update: ReleaseSide | null;
  metricsAvailable: boolean;
  /**
   * Whether this team BUILDS the vertical (#1236 follow-up). False for an app
   * installed from another team's vertical: its traffic is the builder's to see,
   * not ours. The version pair stays knowable either way — the registry is not
   * telemetry — so the card still answers "am I behind?", which is the half a
   * tenant most needs and the half ownership never gated.
   */
  owned: boolean;
}

/** A metrics row as the comparison needs it — the ledger's row plus the CPU percentiles. */
export interface ComparisonMetricsRow extends ReleaseMetricsRow {
  cpuTimeP50: number;
  cpuTimeP99: number;
}

/**
 * Join the (running, update) pair against 24h of version-stamped traffic
 * (#1236): the last question before pressing Update, answered from the same
 * rows the ledger reads. Requests and errors sum across a version's scripts;
 * the CPU percentiles come from its busiest script — percentiles cannot be
 * summed, and the busiest script is where the latency story actually happened.
 */
export function deriveReleaseComparison(
  pair: { runningId: string | null; runningLabel: string | null; updateId: string | null; updateLabel: string | null },
  metrics: ComparisonMetricsRow[] | null,
  opts: { owned?: boolean } = {},
): ReleaseComparison {
  // An app whose vertical another team publishes has no visible traffic — and the
  // authority answers that case with an EMPTY array, not an error, because it
  // narrows its ownership map and short-circuits. Read literally, empty summed to
  // zero and the card said "0 req, no traffic" about an app we simply cannot see.
  // That is the precise misreading every other derivation here refuses; it belongs
  // refused here too, so unowned collapses to the same unknown as no metrics at all.
  const owned = opts.owned ?? true;
  const visible = owned ? metrics : null;
  const side = (versionId: string | null, version: string | null): ReleaseSide | null => {
    if (versionId === null) return null;
    if (visible === null) {
      return { versionId, version, requests: null, errors: null, cpuTimeP50: null, cpuTimeP99: null };
    }
    let requests = 0;
    let errors = 0;
    let busiest: ComparisonMetricsRow | undefined;
    for (const m of visible) {
      if (m.versionId !== versionId) continue;
      requests += m.requests;
      errors += m.errors;
      if (busiest === undefined || m.requests > busiest.requests) busiest = m;
    }
    return {
      versionId,
      version,
      requests,
      errors,
      cpuTimeP50: busiest?.cpuTimeP50 ?? null,
      cpuTimeP99: busiest?.cpuTimeP99 ?? null,
    };
  };
  return {
    running: side(pair.runningId, pair.runningLabel),
    update: side(pair.updateId, pair.updateLabel),
    metricsAvailable: visible !== null,
    owned,
  };
}

/** One time bucket of traffic, as the series read delivers it. */
export interface TrafficBucketInput {
  start: string;
  bucketMinutes: number;
  requests: number;
  errors: number;
  /** Additive status-class split (#1693) — see `TenantMetricsBucket`. Absent on a plane
   *  that does not (yet) carry the status-class dimension. */
  class2xx?: number;
  class3xx?: number;
  class4xx?: number;
}

/** One plotted bucket — zero-filled, so a gap in the data reads as a gap in traffic. */
export interface TrafficBucket {
  start: string;
  requests: number;
  errors: number;
  /**
   * The chart's green and yellow segments (#1693): `green` is 2xx + 3xx traffic, `yellow`
   * is 4xx — the red segment is `errors` above, unchanged. Both present or both absent:
   * absent means the source bucket carried no status-class split, and the chart falls
   * back to today's single-color bar.
   */
  green?: number;
  yellow?: number;
}

/** A moment worth drawing a line at: a push, or a go-live. */
export interface ReleaseMarker {
  at: string;
  kind: 'pushed' | 'went-live';
  version: string;
  versionId: string;
}

export interface TrafficSeries {
  buckets: TrafficBucket[];
  markers: ReleaseMarker[];
  bucketMinutes: number;
  /** False = the plane cannot bucket; the chart says so rather than drawing silence. */
  available: boolean;
}

/** The grid a series is drawn on: the bucket width, and the window's two ends. */
export interface BucketGrid {
  widthMs: number;
  start: number;
  end: number;
}

/**
 * The bucket width the plane answers a window of `hours` in — the same rule the
 * observability reader applies (`cf-observability.ts`), restated here so a derivation
 * that has NO rows to read the width from still lands on the grid the rows would have.
 */
export function bucketMinutesFor(hours: number): number {
  return hours <= 6 ? 15 : 60;
}

/**
 * The window, snapped to the bucket boundary the backend buckets on. Shared by every
 * derivation drawn on one chart — the release series, the team series, and the overlays
 * over them — so nothing drawn over the same hours can disagree about where a column
 * begins. The snap moves `start` EARLIER than `now - hours` by up to one bucket: the
 * first column is a whole bucket, and a sibling read that windowed from the exact
 * request time would drop every fact in that column's opening minutes.
 */
export function bucketGrid(bucketMinutes: number, hours: number, now: Date): BucketGrid {
  const widthMs = bucketMinutes * 60_000;
  const end = Math.floor(now.getTime() / widthMs) * widthMs;
  return { widthMs, start: end - hours * 3_600_000, end };
}

/**
 * A bucket's raw class sums (already sampling-weighted upstream) → the chart's two
 * stacked segments (#1693): green is "no complaint" (2xx + 3xx), yellow is "client got a
 * no" (4xx) — never itself an alarm, per the issue's own note that a 401 or 404 is
 * routine. The red segment is `errors` (5xx) and is computed nowhere else; this
 * function only ever adds `green`/`yellow` to it.
 *
 * `null` is the fallback signal: a source that never reported the status-class split
 * (an older plane, or a script-grain source that cannot carry it) must not be guessed
 * at, so the chart renders today's single-color bar instead of inventing a split.
 * The three fields travel together — one absent means all three are.
 */
export function stackedStatusClasses(b: {
  class2xx?: number;
  class3xx?: number;
  class4xx?: number;
}): { green: number; yellow: number } | null {
  if (b.class2xx === undefined || b.class3xx === undefined || b.class4xx === undefined) return null;
  return { green: b.class2xx + b.class3xx, yellow: b.class4xx };
}

/**
 * Rows → one bucket per slot of the grid, absent meaning explicitly zero. See the
 * zero-fill rule on `deriveTrafficSeries`: skipping an empty bucket lets its
 * neighbours join and draws an outage as a narrower peak.
 */
function fillGrid(rows: TrafficBucketInput[], grid: BucketGrid): TrafficBucket[] {
  // Decided ONCE, over every row this grid draws from — not per bucket: a source
  // either carries the status-class dimension for its whole answer or not at all, and
  // a bucket that merely had no traffic of a class must still stack a real (zero)
  // green/yellow, not fall back to the no-split rendering.
  //
  // EVERY row must carry ALL three fields, not just some row carrying one of them —
  // `some(class2xx !== undefined)` let a mixed or partial-version answer (one row
  // missing `class4xx`, say) turn stacking on and then silently read its absent
  // fields as zero, drawing an incomplete stack rather than falling back. A source
  // is only "has the split" when nothing in it is guessing.
  const hasClasses =
    rows.length > 0 && rows.every((b) => b.class2xx !== undefined && b.class3xx !== undefined && b.class4xx !== undefined);
  const totals = new Map<number, { requests: number; errors: number; class2xx: number; class3xx: number; class4xx: number }>();
  for (const b of rows) {
    const t = Date.parse(b.start);
    if (Number.isNaN(t)) continue;
    // Snap to the grid this series is drawn on: the backend's bucket boundary and
    // ours must agree, or a row lands between two columns and is lost.
    const slot = Math.floor(t / grid.widthMs) * grid.widthMs;
    if (slot < grid.start || slot > grid.end) continue;
    const acc = totals.get(slot) ?? { requests: 0, errors: 0, class2xx: 0, class3xx: 0, class4xx: 0 };
    acc.requests += b.requests;
    acc.errors += b.errors;
    acc.class2xx += b.class2xx ?? 0;
    acc.class3xx += b.class3xx ?? 0;
    acc.class4xx += b.class4xx ?? 0;
    totals.set(slot, acc);
  }

  const plotted: TrafficBucket[] = [];
  for (let t = grid.start; t <= grid.end; t += grid.widthMs) {
    const acc = totals.get(t);
    const classes = hasClasses
      ? stackedStatusClasses({ class2xx: acc?.class2xx ?? 0, class3xx: acc?.class3xx ?? 0, class4xx: acc?.class4xx ?? 0 })
      : null;
    plotted.push({
      start: new Date(t).toISOString(),
      requests: acc?.requests ?? 0,
      errors: acc?.errors ?? 0,
      ...(classes ?? {}),
    });
  }
  return plotted;
}

/**
 * The series a release chart plots (#1236): traffic over time with every push and
 * go-live drawn on it — "did this push break anything" as a shape rather than a
 * table.
 *
 * Two rules the rendering depends on. **Zero-fill**: a bucket with no rows is
 * absent from the backend's answer, and a chart that simply skips it draws a lie
 * — the neighbours join and an outage becomes a narrower peak — so every bucket
 * in the window exists here, explicitly zero. **Markers are registry facts, not
 * telemetry**: a push that produced no traffic still gets its line, which is
 * exactly the case worth seeing.
 */
export function deriveTrafficSeries(input: {
  /** Null = the bucketed read was unavailable; the chart says so. */
  buckets: TrafficBucketInput[] | null;
  releases: ReleaseRow[];
  /**
   * Every prod go-live, as the channel history records them — NOT `ReleaseRow.wentLiveAt`,
   * which keeps only the newest instant per version. Channel history is append-only and a
   * rollback writes `v1 → v2 → v1`, so the collapsed field would lose v1's FIRST go-live
   * and the chart would not draw the line that explains the rollback.
   */
  prodHistory: Array<{ versionId: string; at: string }>;
  hours: number;
  /** The window's end — the caller's clock, so the series and its markers agree. */
  now: Date;
}): TrafficSeries {
  const { buckets, releases, prodHistory, hours, now } = input;
  const bucketMinutes = buckets?.[0]?.bucketMinutes ?? bucketMinutesFor(hours);
  const grid = bucketGrid(bucketMinutes, hours, now);
  const plotted = fillGrid(buckets ?? [], grid);

  const markers: ReleaseMarker[] = [];
  const inWindow = (iso: string): boolean => {
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t >= grid.start && t <= now.getTime();
  };
  for (const r of releases) {
    if (inWindow(r.pushedAt)) {
      markers.push({ at: r.pushedAt, kind: 'pushed', version: r.version, versionId: r.versionId });
    }
  }
  // Go-lives come from the raw history, one marker per promotion: a version that was
  // rolled back and re-promoted inside the window went live TWICE, and both lines are
  // the point of the chart. '—' is the label for a promotion whose version the
  // registry no longer lists — the instant is still a fact worth drawing.
  const labels = new Map(releases.map((r) => [r.versionId, r.version]));
  for (const h of prodHistory) {
    if (!inWindow(h.at)) continue;
    markers.push({ at: h.at, kind: 'went-live', version: labels.get(h.versionId) ?? '—', versionId: h.versionId });
  }
  markers.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return { buckets: plotted, markers, bucketMinutes, available: buckets !== null };
}

/** One time bucket of ONE installed app's traffic, as the tenant series read delivers it. */
export interface TenantTrafficBucketInput extends TrafficBucketInput {
  scopeId: string;
}

/** One app's line on the team chart — its own zero-filled series. */
export interface TeamTrafficLine {
  scopeId: string;
  buckets: TrafficBucket[];
}

export interface TeamTrafficSeries {
  /** Every scope asked for, in the order asked. */
  series: TeamTrafficLine[];
  bucketMinutes: number;
  /** False = the plane cannot bucket; the chart says so rather than drawing silence. */
  available: boolean;
}

/**
 * The team Observability chart's series (#1447): every installed app's traffic over one
 * window, one line each, from the single tenant-grain read.
 *
 * Two rules beyond `deriveTrafficSeries`' zero-fill, both about what an absence means.
 * **A named scope always gets a series**, even when the read returned no row for it: an
 * installed app that served nothing is a fact, and dropping its line would make it
 * indistinguishable from an app the reader never installed. **Scopes never merge**: rows
 * are keyed by scope before they are bucketed, so one busy app cannot lend its shape to a
 * quiet one — the whole reason the plane carries the scope dimension.
 *
 * No markers here. A push is a fact about a vertical's code, and a team chart draws
 * installations of several verticals at once; per-app deploy markers arrive with the
 * per-app series route.
 */
export function deriveTeamSeries(input: {
  /** Null = the bucketed read was unavailable; the chart says so. */
  buckets: TenantTrafficBucketInput[] | null;
  /** The scopes the caller asked about — each one gets a line whether it has rows or not. */
  scopeIds: string[];
  hours: number;
  /** The window's end — the caller's clock, so every line shares one axis. */
  now: Date;
}): TeamTrafficSeries {
  const { buckets, scopeIds, hours, now } = input;
  const bucketMinutes = buckets?.[0]?.bucketMinutes ?? bucketMinutesFor(hours);
  const grid = bucketGrid(bucketMinutes, hours, now);

  const rowsByScope = new Map<string, TenantTrafficBucketInput[]>();
  for (const b of buckets ?? []) rowsByScope.set(b.scopeId, [...(rowsByScope.get(b.scopeId) ?? []), b]);

  return {
    series: [...new Set(scopeIds)].map((scopeId) => ({
      scopeId,
      buckets: fillGrid(rowsByScope.get(scopeId) ?? [], grid),
    })),
    bucketMinutes,
    available: buckets !== null,
  };
}
