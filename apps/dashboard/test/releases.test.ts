import { describe, expect, it } from 'vitest';
import { instant, platformActorId, type ChannelHistoryEntry, type OpsFailureEntry, type Scope } from '@substrat-run/contracts';
import {
  deriveReleaseComparison,
  deriveReleases,
  deriveTeamSeries,
  deriveTrafficSeries,
  stackedStatusClasses,
} from '../src/releases.js';
import { versionPair } from '../src/deployments.js';
import type { Deployment } from '../src/deployments.js';

const actor = platformActorId.parse('01ARZ3NDEKTSV4RRFFQ69G5FAV');
const at = (s: string) => instant.parse(s);

const V1 = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const V2 = '01ARZ3NDEKTSV4RRFFQ69G5FA2';

function deployment(): Deployment {
  return {
    slug: 'acme/crm',
    displaySlug: 'crm',
    name: 'CRM',
    source: 'cli',
    listed: false,
    versions: [
      { id: V2, version: '0.0.2', admission: 'admitted', admissionNote: null, deploymentRef: null, schemaChange: true, origin: null, createdAt: '2026-09-08T10:00:00.000Z' },
      { id: V1, version: '0.0.1', admission: 'admitted', admissionNote: null, deploymentRef: null, schemaChange: false, origin: null, createdAt: '2026-09-01T10:00:00.000Z' },
    ],
    channels: [{ channel: 'prod', versionId: V2, servingVersionId: V1 }],
  } as Deployment;
}

function history(): ChannelHistoryEntry[] {
  // Newest first, as the plane answers. V2 went live twice (a rollback and back).
  return [
    { id: '01B00000000000000000000003', verticalSlug: 'acme/crm', channel: 'prod', versionId: V2, fromVersionId: V1, actor, at: at('2026-09-08T11:00:00Z') },
    { id: '01B00000000000000000000002', verticalSlug: 'acme/crm', channel: 'prod', versionId: V1, fromVersionId: null, actor, at: at('2026-09-01T11:00:00Z') },
  ] as ChannelHistoryEntry[];
}

function scope(over: Partial<Scope>): Scope {
  return {
    verticalVersionId: null,
    archivedAt: null,
    ...over,
  } as Scope;
}

function failure(version: string | null): OpsFailureEntry {
  return { version } as OpsFailureEntry;
}

describe('deriveReleases (#1236)', () => {
  it('joins push, go-live, adoption, failures and traffic onto the version axis', () => {
    const view = deriveReleases({
      deployment: deployment(),
      prodHistory: history(),
      scopes: [
        scope({ verticalVersionId: V1 }),
        scope({ verticalVersionId: V1 }),
        scope({}), // no pin — follows prod
        scope({ verticalVersionId: V1, archivedAt: at('2026-09-05T00:00:00Z') }), // archived: not adoption
      ],
      failures: [failure(V2), failure(V2), failure(V1), failure(null)],
      metrics: [
        { versionId: V2, requests: 100, errors: 5 },
        // The same version's second script (archive + serving) — traffic sums.
        { versionId: V2, requests: 20, errors: 1 },
        { versionId: null, requests: 999, errors: 999 }, // unstamped: unattributable
      ],
    });

    expect(view.scopesTrackingProd).toBe(1);
    expect(view.metricsAvailable).toBe(true);
    const [v2, v1] = view.releases;
    expect(v2).toMatchObject({
      versionId: V2,
      isProd: true,
      // The promote points at V2 but the in-place serve has not landed it yet.
      isServing: false,
      wentLiveAt: '2026-09-08T11:00:00.000Z',
      scopesPinned: 0,
      failures: 2,
      requests: 120,
      errors: 6,
    });
    expect(v1).toMatchObject({ versionId: V1, isProd: false, isServing: true, scopesPinned: 2, failures: 1, requests: 0, errors: 0 });
  });

  it('renders unavailable metrics as unknown, never as zero traffic', () => {
    const view = deriveReleases({
      deployment: deployment(),
      prodHistory: [],
      scopes: [],
      failures: [],
      metrics: null,
    });
    expect(view.metricsAvailable).toBe(false);
    expect(view.releases[0]!.requests).toBeNull();
    expect(view.releases[0]!.errors).toBeNull();
    // And a never-promoted version has no go-live instant, not an invented one.
    expect(view.releases[0]!.wentLiveAt).toBeNull();
  });

  it('orders releases newest first whatever order the versions arrive in', () => {
    // The panel reads the top of the list as "the latest pushes"; an
    // oldest-first input (a raw `listVersions` page) must not become the
    // oldest eight on screen.
    const d = deployment();
    const view = deriveReleases({
      deployment: { ...d, versions: [...d.versions].reverse() },
      prodHistory: [],
      scopes: [],
      failures: [],
      metrics: null,
    });
    expect(view.releases.map((r) => r.versionId)).toEqual([V2, V1]);
  });
});

describe('versionPair (#1236) — the shared running/update frame', () => {
  it('pins win, and an unpinned scope runs the prod head without being offered it as an update', () => {
    const d = deployment(); // prod → V2
    expect(versionPair(d, V1)).toMatchObject({ runningId: V1, runningLabel: '0.0.1', updateId: V2, updateLabel: '0.0.2' });
    // Unpinned = effectively on prod's head; comparing prod to the null pin must
    // not offer that same head as its own "update" — the bug the helper pins down.
    expect(versionPair(d, null)).toMatchObject({ runningId: V2, updateId: null });
  });
});

describe('deriveReleaseComparison (#1236)', () => {
  const pair = { runningId: V1, runningLabel: '0.0.1', updateId: V2, updateLabel: '0.0.2' };

  it('sums traffic per side and takes the busiest script\u2019s percentiles', () => {
    const cmp = deriveReleaseComparison(pair, [
      { versionId: V1, requests: 10, errors: 5, cpuTimeP50: 3, cpuTimeP99: 9 },
      { versionId: V2, requests: 100, errors: 1, cpuTimeP50: 4, cpuTimeP99: 12 },
      // V2's quieter second script: adds traffic, must not win the percentiles.
      { versionId: V2, requests: 2, errors: 0, cpuTimeP50: 99, cpuTimeP99: 999 },
      { versionId: null, requests: 7, errors: 7, cpuTimeP50: 1, cpuTimeP99: 1 },
    ]);
    expect(cmp.running).toMatchObject({ requests: 10, errors: 5, cpuTimeP50: 3 });
    expect(cmp.update).toMatchObject({ requests: 102, errors: 1, cpuTimeP50: 4, cpuTimeP99: 12 });
    expect(cmp.metricsAvailable).toBe(true);
  });

  it('renders unavailable metrics as unknown sides, and no update as null', () => {
    const cmp = deriveReleaseComparison(pair, null);
    expect(cmp.metricsAvailable).toBe(false);
    expect(cmp.running).toMatchObject({ versionId: V1, requests: null, cpuTimeP99: null });
    expect(deriveReleaseComparison({ ...pair, updateId: null, updateLabel: null }, []).update).toBeNull();
  });
});

describe('deriveReleaseComparison — unowned is unknown, never zero', () => {
  const pair = { runningId: V1, runningLabel: '0.0.1', updateId: V2, updateLabel: '0.0.2' };

  it('reports traffic as unknown for a vertical another team publishes', () => {
    // The authority answers an unowned vertical with an EMPTY list, not a throw —
    // it narrows its ownership map and short-circuits. Summed literally that is a
    // confident "0 req / no traffic" about an app we cannot see, which is the
    // misreading every other derivation here refuses.
    const cmp = deriveReleaseComparison(
      pair,
      [{ versionId: V1, requests: 5, errors: 1, cpuTimeP50: 2, cpuTimeP99: 4 }],
      { owned: false },
    );
    expect(cmp.owned).toBe(false);
    expect(cmp.metricsAvailable).toBe(false);
    expect(cmp.running).toMatchObject({ versionId: V1, requests: null, errors: null, cpuTimeP99: null });
    // The version pair stays knowable: the registry is not telemetry, and "am I
    // behind?" is the half ownership never gated.
    expect(cmp.update).toMatchObject({ versionId: V2, version: '0.0.2' });
  });

  it('defaults to owned, so the existing callers keep their numbers', () => {
    const cmp = deriveReleaseComparison(pair, [
      { versionId: V1, requests: 5, errors: 1, cpuTimeP50: 2, cpuTimeP99: 4 },
    ]);
    expect(cmp.owned).toBe(true);
    expect(cmp.running).toMatchObject({ requests: 5, errors: 1 });
  });
});

describe('deriveTrafficSeries (#1236) — the chart series and its markers', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');
  const releasesOf = () =>
    deriveReleases({ deployment: deployment(), prodHistory: history(), scopes: [], failures: [], metrics: null }).releases;

  it('zero-fills the window so a gap in traffic is a gap on the chart', () => {
    const series = deriveTrafficSeries({
      hours: 6,
      now,
      releases: [],
      prodHistory: [],
      buckets: [
        { start: '2026-09-08T11:00:00.000Z', bucketMinutes: 60, requests: 10, errors: 1 },
        { start: '2026-09-08T08:00:00.000Z', bucketMinutes: 60, requests: 4, errors: 0 },
      ],
    });
    // Seven hourly columns for a six-hour window (both edges), every one present.
    expect(series.buckets).toHaveLength(7);
    expect(series.bucketMinutes).toBe(60);
    const byStart = new Map(series.buckets.map((b) => [b.start, b]));
    expect(byStart.get('2026-09-08T11:00:00.000Z')).toMatchObject({ requests: 10, errors: 1 });
    expect(byStart.get('2026-09-08T08:00:00.000Z')).toMatchObject({ requests: 4, errors: 0 });
    // The untouched hours exist and are explicitly zero, never absent.
    expect(byStart.get('2026-09-08T09:00:00.000Z')).toMatchObject({ requests: 0, errors: 0 });
    expect(series.available).toBe(true);
  });

  it('sums rows that land in one bucket and drops rows outside the window', () => {
    const series = deriveTrafficSeries({
      hours: 2,
      now,
      releases: [],
      prodHistory: [],
      buckets: [
        // Two scripts' rows for the same hour — one column, summed.
        { start: '2026-09-08T11:00:00.000Z', bucketMinutes: 60, requests: 10, errors: 1 },
        { start: '2026-09-08T11:30:00.000Z', bucketMinutes: 60, requests: 5, errors: 2 },
        { start: '2026-09-01T11:00:00.000Z', bucketMinutes: 60, requests: 999, errors: 999 },
        { start: 'not-a-date', bucketMinutes: 60, requests: 7, errors: 7 },
      ],
    });
    const hour11 = series.buckets.find((b) => b.start === '2026-09-08T11:00:00.000Z');
    expect(hour11).toMatchObject({ requests: 15, errors: 3 });
    expect(series.buckets.reduce((n, b) => n + b.requests, 0)).toBe(15);
  });

  it('draws a marker per push and go-live inside the window, oldest first', () => {
    const series = deriveTrafficSeries({ hours: 72, now, releases: releasesOf(), prodHistory: history(), buckets: [] });
    // V2 pushed 10:00 and went live 11:00 on the 8th; V1's instants are a week old.
    expect(series.markers.map((m) => `${m.version}:${m.kind}`)).toEqual(['0.0.2:pushed', '0.0.2:went-live']);
    expect(series.markers[0]!.at < series.markers[1]!.at).toBe(true);
  });

  it('draws EVERY go-live of a rolled-back version, not just the newest one', () => {
    // v2 live at 08:00, rolled back to v1 at 09:00, v2 again at 10:00 — three lines.
    // `ReleaseRow.wentLiveAt` collapses to the newest instant per version, so reading
    // markers from it would lose v2's 08:00 promotion and the chart would not explain
    // why the rollback happened. The raw history is the source for exactly that reason.
    const prodHistory = [
      { versionId: V2, at: '2026-09-08T10:00:00.000Z' },
      { versionId: V1, at: '2026-09-08T09:00:00.000Z' },
      { versionId: V2, at: '2026-09-08T08:00:00.000Z' },
    ];
    const releases = deriveReleases({ deployment: deployment(), prodHistory, scopes: [], failures: [], metrics: null }).releases;
    // The collapsed field really does keep only the newest — the premise of this test.
    expect(releases.find((r) => r.versionId === V2)!.wentLiveAt).toBe('2026-09-08T10:00:00.000Z');

    const series = deriveTrafficSeries({ hours: 6, now, releases, prodHistory, buckets: [] });
    expect(series.markers.filter((m) => m.kind === 'went-live').map((m) => `${m.version}@${m.at}`)).toEqual([
      '0.0.2@2026-09-08T08:00:00.000Z',
      '0.0.1@2026-09-08T09:00:00.000Z',
      '0.0.2@2026-09-08T10:00:00.000Z',
    ]);
  });

  it('still draws a go-live whose version the registry no longer lists', () => {
    // A pruned version leaves a promotion the label map cannot name. The instant is
    // still a fact, so the line is drawn with the UI's '—' placeholder.
    const prodHistory = [{ versionId: '01ARZ3NDEKTSV4RRFFQ69G5FA9', at: '2026-09-08T09:00:00.000Z' }];
    const series = deriveTrafficSeries({ hours: 6, now, releases: releasesOf(), prodHistory, buckets: [] });
    expect(series.markers.filter((m) => m.kind === 'went-live')).toEqual([
      { at: '2026-09-08T09:00:00.000Z', kind: 'went-live', version: '—', versionId: '01ARZ3NDEKTSV4RRFFQ69G5FA9' },
    ]);
  });

  it('says unavailable rather than drawing a flat line of silence', () => {
    const series = deriveTrafficSeries({ hours: 24, now, releases: releasesOf(), prodHistory: history(), buckets: null });
    expect(series.available).toBe(false);
    // The window still exists (so a caller CAN render an axis), but the caller is
    // told not to — an all-zero chart and "I could not look" are different answers.
    expect(series.buckets.every((b) => b.requests === 0)).toBe(true);
  });

  it('sums the weighted status classes per bucket and the stacked total equals requests (#1693)', () => {
    const series = deriveTrafficSeries({
      hours: 2,
      now,
      releases: [],
      prodHistory: [],
      buckets: [
        // A fixture naming every class, split across two rows landing in the same
        // bucket — the same "two scripts, one column, summed" shape the plain
        // requests/errors test above uses, so the weighted sum is exercised, not
        // just the pass-through of one already-summed row.
        { start: '2026-09-08T11:00:00.000Z', bucketMinutes: 60, requests: 90, errors: 3, class2xx: 70, class3xx: 10, class4xx: 7 },
        { start: '2026-09-08T11:30:00.000Z', bucketMinutes: 60, requests: 10, errors: 0, class2xx: 8, class3xx: 1, class4xx: 1 },
      ],
    });
    const hour11 = series.buckets.find((b) => b.start === '2026-09-08T11:00:00.000Z')!;
    expect(hour11).toMatchObject({ requests: 100, errors: 3, green: 89, yellow: 8 });
    expect(hour11.green! + hour11.yellow! + hour11.errors).toBe(hour11.requests);
  });

  it('falls back to no split when the source buckets carry no status-class fields', () => {
    const series = deriveTrafficSeries({
      hours: 2,
      now,
      releases: [],
      prodHistory: [],
      buckets: [{ start: '2026-09-08T11:00:00.000Z', bucketMinutes: 60, requests: 10, errors: 1 }],
    });
    const hour11 = series.buckets.find((b) => b.start === '2026-09-08T11:00:00.000Z')!;
    expect(hour11.green).toBeUndefined();
    expect(hour11.yellow).toBeUndefined();
    // A bucket the source never touched (still zero-filled) is `green`-less too, not
    // a stray `{ green: 0 }` that would read as "this source has the split".
    const untouched = series.buckets.find((b) => b.start !== '2026-09-08T11:00:00.000Z')!;
    expect(untouched.green).toBeUndefined();
  });

  it('falls back for the WHOLE chart when one row of a mixed answer is missing a class field', () => {
    // Two rows land in the same bucket; one carries the full split, the other is
    // missing `class4xx` — a partial or mixed-version answer, not an absent one.
    // Turning stacking on here would silently read the missing field as zero and
    // draw an incomplete stack, which is worse than the honest single-color bar.
    const series = deriveTrafficSeries({
      hours: 2,
      now,
      releases: [],
      prodHistory: [],
      buckets: [
        { start: '2026-09-08T11:00:00.000Z', bucketMinutes: 60, requests: 90, errors: 3, class2xx: 70, class3xx: 10, class4xx: 7 },
        { start: '2026-09-08T11:30:00.000Z', bucketMinutes: 60, requests: 10, errors: 0, class2xx: 8, class3xx: 1 },
      ],
    });
    expect(series.buckets.every((b) => b.green === undefined && b.yellow === undefined)).toBe(true);
  });

  it('falls back when a row names only one class', () => {
    const series = deriveTrafficSeries({
      hours: 2,
      now,
      releases: [],
      prodHistory: [],
      buckets: [{ start: '2026-09-08T11:00:00.000Z', bucketMinutes: 60, requests: 10, errors: 1, class2xx: 9 }],
    });
    expect(series.buckets.every((b) => b.green === undefined && b.yellow === undefined)).toBe(true);
  });

  it('stacks when every row is complete — the twin of the two fallback cases above', () => {
    const series = deriveTrafficSeries({
      hours: 2,
      now,
      releases: [],
      prodHistory: [],
      buckets: [
        { start: '2026-09-08T11:00:00.000Z', bucketMinutes: 60, requests: 90, errors: 3, class2xx: 70, class3xx: 10, class4xx: 7 },
        { start: '2026-09-08T11:30:00.000Z', bucketMinutes: 60, requests: 10, errors: 0, class2xx: 8, class3xx: 1, class4xx: 1 },
      ],
    });
    const hour11 = series.buckets.find((b) => b.start === '2026-09-08T11:00:00.000Z')!;
    expect(hour11).toMatchObject({ green: 89, yellow: 8 });
  });
});

describe('stackedStatusClasses (#1693) — the chart\'s green/yellow segments', () => {
  it('combines 2xx and 3xx into green, keeps 4xx as yellow', () => {
    expect(stackedStatusClasses({ class2xx: 70, class3xx: 10, class4xx: 7 })).toEqual({ green: 80, yellow: 7 });
  });

  it('renders no segment for a class with nothing in it', () => {
    expect(stackedStatusClasses({ class2xx: 12, class3xx: 0, class4xx: 0 })).toEqual({ green: 12, yellow: 0 });
  });

  it('is null (the fallback signal) when any class field is absent — the split travels as one unit', () => {
    expect(stackedStatusClasses({})).toBeNull();
    expect(stackedStatusClasses({ class2xx: 1, class3xx: 1 })).toBeNull();
  });
});

describe('deriveTeamSeries (#1447) — one line per installed app', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');
  const A = '01J2Q8Z3V9K4W7X2M5N6P789AB';
  const B = '01J2Q8Z3V9K4W7X2M5N6P7LEGA';

  it('gives every named scope a series, even one that served nothing', () => {
    const team = deriveTeamSeries({
      hours: 2,
      now,
      scopeIds: [A, B],
      buckets: [{ scopeId: A, start: '2026-09-08T11:00:00.000Z', bucketMinutes: 60, requests: 3, errors: 0 }],
    });
    // B installed and quiet is a fact; dropping its line would read as "never installed".
    expect(team.series.map((s) => s.scopeId)).toEqual([A, B]);
    expect(team.series[1]!.buckets).toHaveLength(3);
    expect(team.series[1]!.buckets.every((b) => b.requests === 0 && b.errors === 0)).toBe(true);
  });

  it('snaps rows onto the grid and zero-fills the rest of the window', () => {
    const team = deriveTeamSeries({
      hours: 6,
      now,
      scopeIds: [A],
      buckets: [
        // Mid-bucket and out-of-window rows, the same two cases the release chart has.
        { scopeId: A, start: '2026-09-08T11:30:00.000Z', bucketMinutes: 60, requests: 5, errors: 2 },
        { scopeId: A, start: '2026-09-08T11:00:00.000Z', bucketMinutes: 60, requests: 10, errors: 1 },
        { scopeId: A, start: '2026-09-01T11:00:00.000Z', bucketMinutes: 60, requests: 999, errors: 999 },
        { scopeId: A, start: 'not-a-date', bucketMinutes: 60, requests: 7, errors: 7 },
      ],
    });
    const line = team.series[0]!.buckets;
    expect(line).toHaveLength(7);
    expect(team.bucketMinutes).toBe(60);
    expect(line.find((b) => b.start === '2026-09-08T11:00:00.000Z')).toMatchObject({ requests: 15, errors: 3 });
    expect(line.reduce((n, b) => n + b.requests, 0)).toBe(15);
  });

  it('keeps two apps apart, so one busy app cannot lend its shape to a quiet one', () => {
    const team = deriveTeamSeries({
      hours: 1,
      now,
      scopeIds: [A, B],
      buckets: [
        { scopeId: A, start: '2026-09-08T12:00:00.000Z', bucketMinutes: 60, requests: 100, errors: 4 },
        { scopeId: B, start: '2026-09-08T12:00:00.000Z', bucketMinutes: 60, requests: 7, errors: 0 },
      ],
    });
    const at12 = (scopeId: string) =>
      team.series.find((s) => s.scopeId === scopeId)!.buckets.find((b) => b.start === '2026-09-08T12:00:00.000Z');
    expect(at12(A)).toMatchObject({ requests: 100, errors: 4 });
    expect(at12(B)).toMatchObject({ requests: 7, errors: 0 });
  });

  it('drops rows for a scope the caller did not ask about', () => {
    // The worker resolves scopes against the team's own apps, so this is belt and
    // braces — but a stray scope's traffic silently summed into another app's line
    // is exactly the misreading the scope dimension exists to prevent.
    const team = deriveTeamSeries({
      hours: 1,
      now,
      scopeIds: [A],
      buckets: [
        { scopeId: A, start: '2026-09-08T12:00:00.000Z', bucketMinutes: 60, requests: 2, errors: 0 },
        { scopeId: '01J2Q8Z3V9K4W7X2M5N6P7XXXX', start: '2026-09-08T12:00:00.000Z', bucketMinutes: 60, requests: 500, errors: 9 },
      ],
    });
    expect(team.series).toHaveLength(1);
    expect(team.series[0]!.buckets.reduce((n, b) => n + b.requests, 0)).toBe(2);
  });

  it('says unavailable, and still returns one zero series per scope', () => {
    const team = deriveTeamSeries({ hours: 24, now, scopeIds: [A, B], buckets: null });
    expect(team.available).toBe(false);
    expect(team.series.map((s) => s.scopeId)).toEqual([A, B]);
    expect(team.series.every((s) => s.buckets.every((b) => b.requests === 0))).toBe(true);
  });
});
