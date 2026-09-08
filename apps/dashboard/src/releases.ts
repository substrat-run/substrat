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
