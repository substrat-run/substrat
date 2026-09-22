import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { connectionId, platformActorId, scopeId, tenantId, type DomainEvent } from '@substrat-run/contracts';
import {
  analyticsEngineConnectorCallRecorder,
  ulid,
  webCryptoSecretBox,
  type ConnectorCallRecorder,
  type FetchLike,
} from '@substrat-run/kernel';
import { CloudflareScopeHost } from '../src/host.js';
import { warmControlPlane } from './do-warmup.js';

/**
 * One data point per connector call (#1691), on the hosted path — the coordinator's
 * sanctioned `fetch`, settled by the control-plane DO, recorded from the identity the DO
 * read off the row. The same two properties the self-host suite holds, against the real
 * DOs: nothing the call carried reaches a point, and a failing write cannot fail the call.
 */
describe('connector calls into the recorder, hosted (#1691)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  const staff = platformActorId.parse(ulid());
  const SECRET = { apiToken: 'tok-LIVE-cf-do-not-record' };
  const PAYLOAD = 'personnummer-19121212-1212';
  const QUERY = 'access_token=qs-LIVE-cf';
  const FORBIDDEN = [SECRET.apiToken, PAYLOAD, QUERY, 'provider.invalid', 'HTTP 500', 'socket'];

  const provider: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/ok') return new Response('{}', { status: 200 });
    if (url.pathname === '/fail') return new Response(`echo ${String(init?.body)}`, { status: 500 });
    throw new Error(`socket closed sending ${SECRET.apiToken}`);
  };

  const world = async (connectorCalls: ConnectorCallRecorder) => {
    const host = new CloudflareScopeHost({
      scope: env.SCOPE,
      controlPlane: env.CONTROL_PLANE,
      secretBox: webCryptoSecretBox('test-key', new Uint8Array(32).fill(7)),
      fetch: provider,
      connectorCalls,
    });
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: `t-${t.toLowerCase()}`, name: 'T' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    await host.admin.activateScope(staff, t, s);
    await host.admin.createConnection(staff, {
      id: connectionId.parse(ulid()),
      tenantId: t,
      vertical: 'docs',
      provider: 'scrive',
      label: 'scrive',
      secret: SECRET,
    });
    const call = async (path: string) => {
      let result: 'resolved' | 'rejected' = 'resolved';
      await host.dispatchConnector(
        t,
        s,
        async (ctx) => {
          const conn = await ctx.connection('scrive');
          try {
            await conn.fetch(`https://provider.invalid${path}?${QUERY}`, {
              method: 'POST',
              headers: { authorization: `Bearer ${SECRET.apiToken}` },
              body: JSON.stringify({ subject: PAYLOAD }),
            });
          } catch {
            result = 'rejected';
          }
        },
        { id: ulid(), type: 'doc.send-requested', payload: {} } as unknown as DomainEvent,
      );
      return result;
    };
    const health = async () => (await host.admin.listConnections(staff, { tenantId: t }))[0]!;
    return { t, call, health };
  };

  it('writes one point per call, keyed off the row, and none holds what the call carried', async () => {
    const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
    const w = await world(analyticsEngineConnectorCallRecorder({ writeDataPoint: (p) => void points.push(p) }));
    expect(await w.call('/ok')).toBe('resolved');
    expect(await w.call('/fail')).toBe('resolved');
    expect(await w.call('/throw')).toBe('rejected');

    expect(points.map((p) => p.indexes)).toEqual([[w.t], [w.t], [w.t]]);
    expect(points.map((p) => p.blobs)).toEqual([
      ['scrive', 'docs', 'ok'],
      ['scrive', 'docs', 'http_5xx'],
      ['scrive', 'docs', 'network'],
    ]);
    const written = JSON.stringify(points);
    for (const f of FORBIDDEN) expect(written).not.toContain(f);
    // The positive twin: the call DID carry the credential — the health line holds it.
    expect((await w.health()).lastError).toContain(SECRET.apiToken);
  });

  it('a throwing Analytics Engine write is swallowed and counted; the health line still settles', async () => {
    const recorder = analyticsEngineConnectorCallRecorder({
      writeDataPoint: () => {
        throw new Error('Analytics Engine unavailable');
      },
    });
    const w = await world(recorder);
    expect(await w.call('/ok')).toBe('resolved');
    expect(await w.call('/fail')).toBe('resolved');
    expect(recorder.dropped).toBe(2);
    expect((await w.health()).lastError).toBe('HTTP 500 from scrive');
  });
});
