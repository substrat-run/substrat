import { describe, expect, it } from 'vitest';
import { instant, platformActorId, type ChannelHistoryEntry, type OpsFailureEntry, type Scope } from '@substrat-run/contracts';
import { deriveReleases } from '../src/releases.js';
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
