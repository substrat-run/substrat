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
): ReleaseComparison {
  const side = (versionId: string | null, version: string | null): ReleaseSide | null => {
    if (versionId === null) return null;
    if (metrics === null) {
      return { versionId, version, requests: null, errors: null, cpuTimeP50: null, cpuTimeP99: null };
    }
    let requests = 0;
    let errors = 0;
    let busiest: ComparisonMetricsRow | undefined;
    for (const m of metrics) {
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
    metricsAvailable: metrics !== null,
  };
}

/** One time bucket of traffic, as the series read delivers it. */
export interface TrafficBucketInput {
  start: string;
  bucketMinutes: number;
  requests: number;
  errors: number;
}

/** One plotted bucket — zero-filled, so a gap in the data reads as a gap in traffic. */
export interface TrafficBucket {
  start: string;
  requests: number;
  errors: number;
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
  const bucketMinutes = buckets?.[0]?.bucketMinutes ?? (hours <= 6 ? 15 : 60);
  const widthMs = bucketMinutes * 60_000;
  const end = Math.floor(now.getTime() / widthMs) * widthMs;
  const start = end - hours * 3_600_000;

  const totals = new Map<number, { requests: number; errors: number }>();
  for (const b of buckets ?? []) {
    const t = Date.parse(b.start);
    if (Number.isNaN(t)) continue;
    // Snap to the grid this series is drawn on: the backend's bucket boundary and
    // ours must agree, or a row lands between two columns and is lost.
    const slot = Math.floor(t / widthMs) * widthMs;
    if (slot < start || slot > end) continue;
    const acc = totals.get(slot) ?? { requests: 0, errors: 0 };
    acc.requests += b.requests;
    acc.errors += b.errors;
    totals.set(slot, acc);
  }

  const plotted: TrafficBucket[] = [];
  for (let t = start; t <= end; t += widthMs) {
    const acc = totals.get(t);
    plotted.push({ start: new Date(t).toISOString(), requests: acc?.requests ?? 0, errors: acc?.errors ?? 0 });
  }

  const markers: ReleaseMarker[] = [];
  const inWindow = (iso: string): boolean => {
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t >= start && t <= now.getTime();
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
