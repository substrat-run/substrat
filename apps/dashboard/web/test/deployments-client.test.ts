// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { teamApi } from '../src/lib/api';
import { ApiError } from '../src/lib/api.generated';

/**
 * The Verticals pages' calls go through `teamApi(teamId)` (#2170): every read and write of
 * the team's deployments and previews names its team in its own URL, so a second tab on
 * another team cannot decide which team's verticals this tab promotes, removes or previews.
 * The worker side of these same paths is `test/deployments-team-routes.test.ts`.
 */
describe('teamApi: the deployments & previews calls', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  const stub = (answer: () => Response = () => new Response(JSON.stringify({}), { status: 200 })) => {
    const seen: { url: string; method: string; body: unknown; credentials?: RequestCredentials }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        credentials: init?.credentials,
      });
      return answer();
    }) as unknown as typeof fetch;
    return seen;
  };

  it('names the team in every path, with the slug encoded whole, and the verbs and bodies the worker serves', async () => {
    const seen = stub();
    const client = teamApi('T 1');
    const slug = 'acme/hr';
    await client.listDeployments();
    await client.promoteDeployment({ slug, channel: 'prod', versionId: 'V1', acknowledge: { migrationChange: true, review: { base: 'V0', digest: 'a'.repeat(64) } } });
    await client.getPromotionReview({ slug, versionId: 'V 1' });
    await client.listChannelHistory({ slug, channel: 'prod' });
    await client.listDeploymentFailures({ slug });
    await client.getDeploymentReleases({ slug });
    await client.getDeploymentTraffic({ slug, hours: 24 });
    await client.listDeploymentIssues({ slug });
    await client.deleteDeployment({ slug });
    await client.listBoundScopes({ slug });
    await client.reviewScopeMove({ slug, scopeIds: ['S1'], target: 'acme/b' });
    await client.moveScopes({ slug, scopeIds: ['S1'], target: 'acme/b', ackMigrations: true, reviews: { S1: { base: null, digest: 'b'.repeat(64) } } });
    await client.retireScopes({ slug, scopeIds: ['S1'], confirm: '1' });
    await client.listPreviews({ slug });
    await client.createPreview({ slug, tag: 'pr-1', versionId: 'V1', ttlHours: null });
    await client.deletePreview({ slug, tag: 'pr-1' });
    await client.bindPreviewDomain({ slug, tag: 'pr-1', domain: 'crm-test.example.com', canonical: true });

    const base = '/api/teams/T%201';
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${base}/deployments`,
      `POST ${base}/deployments/acme%2Fhr/promote`,
      `GET ${base}/deployments/acme%2Fhr/promote-review?versionId=V+1`,
      `GET ${base}/deployments/acme%2Fhr/channels/prod/history`,
      `GET ${base}/deployments/acme%2Fhr/failures`,
      `GET ${base}/deployments/acme%2Fhr/releases`,
      `GET ${base}/deployments/acme%2Fhr/traffic?hours=24`,
      `GET ${base}/deployments/acme%2Fhr/issues`,
      `DELETE ${base}/deployments/acme%2Fhr`,
      `GET ${base}/deployments/acme%2Fhr/scopes`,
      `POST ${base}/deployments/acme%2Fhr/scopes/move-review`,
      `POST ${base}/deployments/acme%2Fhr/scopes/move`,
      `POST ${base}/deployments/acme%2Fhr/scopes/retire`,
      `GET ${base}/deployments/acme%2Fhr/previews`,
      `POST ${base}/deployments/acme%2Fhr/previews`,
      `DELETE ${base}/deployments/acme%2Fhr/previews/pr-1`,
      `POST ${base}/deployments/acme%2Fhr/previews/pr-1/domain`,
    ]);
    // The path params are not repeated in the body; what is sent is the declared input.
    expect(seen[1]!.body).toEqual({ channel: 'prod', versionId: 'V1', acknowledge: { migrationChange: true, review: { base: 'V0', digest: 'a'.repeat(64) } } });
    expect(seen[10]!.body).toEqual({ scopeIds: ['S1'], target: 'acme/b' });
    expect(seen[11]!.body).toEqual({ scopeIds: ['S1'], target: 'acme/b', ackMigrations: true, reviews: { S1: { base: null, digest: 'b'.repeat(64) } } });
    expect(seen[12]!.body).toEqual({ scopeIds: ['S1'], confirm: '1' });
    expect(seen[14]!.body).toEqual({ tag: 'pr-1', versionId: 'V1', ttlHours: null });
    expect(seen[16]!.body).toEqual({ domain: 'crm-test.example.com', canonical: true });
    // …with the session, on every call.
    expect(seen.every((s) => s.credentials === 'include')).toBe(true);
  });

  it('a refusal surfaces its status, its sentence and its parsed problem body — the reason a dialog branches on', async () => {
    stub(() => Response.json({ title: 'Precondition failed', detail: 'the promote review is stale', reason: 'promote_review_stale', requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, { status: 412 }));
    const err = await teamApi('T1').promoteDeployment({ slug: 'acme/hr', channel: 'prod', versionId: 'V1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 412, message: 'the promote review is stale', body: { reason: 'promote_review_stale' } });
  });
});
