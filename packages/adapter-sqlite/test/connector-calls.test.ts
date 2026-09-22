import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionId, platformActorId, scopeId, tenantId, type DomainEvent } from '@substrat-run/contracts';
import {
  analyticsEngineConnectorCallRecorder,
  ulid,
  webCryptoSecretBox,
  type ConnectorCallRecorder,
  type FetchLike,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * One data point per connector call (#1691), on the self-host path — the connection's
 * sanctioned `fetch`, settled by `recordConnectionUse`, handed to the recorder.
 *
 * Two properties, each with its positive twin: nothing a call carries (credential, URL
 * query, body, the provider's error body, a thrown message) reaches a written point; and
 * the recorder cannot fail or stall the call, however it misbehaves.
 */

/** Every string a call carries that must never reach a data point. */
const SECRET = { apiToken: 'tok-LIVE-9f3a-do-not-record' };
const PAYLOAD = 'personnummer-19121212-1212';
const QUERY = 'access_token=qs-LIVE-77aa';
const HOSTNAME = 'provider.invalid';
const THROWN = `socket hang up while sending ${SECRET.apiToken}`;
const FORBIDDEN = [SECRET.apiToken, PAYLOAD, QUERY, 'qs-LIVE-77aa', HOSTNAME, 'socket hang up', 'HTTP 500'];

type Point = { indexes?: string[]; blobs?: string[]; doubles?: number[] };

describe('connector calls into the recorder (#1691)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /**
   * A provider that answers by path: `/ok` 200, `/fail` 500 with an error body that
   * echoes the request (as real ones do), `/throw` rejects with the credential in its
   * message, `/hang` waits for the host's timeout.
   */
  const provider: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/ok') return new Response('{}', { status: 200 });
    if (url.pathname === '/fail') {
      return new Response(`bad request: ${String(init?.body)} with ${url.search}`, { status: 500 });
    }
    if (url.pathname === '/throw') throw new Error(THROWN);
    return new Promise((_, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener('abort', () => reject(signal.reason));
    });
  };

  const world = async (connectorCalls?: ConnectorCallRecorder) => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-connector-calls-'));
    const host = new SqliteScopeHost({
      dir,
      secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)),
      fetch: provider,
      ...(connectorCalls ? { connectorCalls } : {}),
    });
    const staff = platformActorId.parse(ulid());
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
    const id = connectionId.parse(ulid());
    await host.admin.createConnection(staff, {
      id,
      tenantId: t,
      vertical: 'docs',
      provider: 'scrive',
      label: 'scrive',
      externalAccountRef: 'acct-1',
      scopes: [],
      secret: SECRET,
    });

    /** One call through the connection's sanctioned `fetch`, as a connector makes it. */
    const call = async (path: string, timeoutMs = 5_000) => {
      let result: 'resolved' | 'rejected' = 'resolved';
      await host.dispatchConnector(
        t,
        s,
        async (ctx) => {
          const conn = await ctx.connection('scrive');
          try {
            await conn.fetch(`https://${HOSTNAME}${path}?${QUERY}`, {
              method: 'POST',
              headers: { authorization: `Bearer ${conn.secret.apiToken}` },
              body: JSON.stringify({ subject: PAYLOAD }),
            });
          } catch {
            result = 'rejected';
          }
        },
        { id: ulid(), type: 'doc.send-requested', payload: {} } as unknown as DomainEvent,
        { timeoutMs },
      );
      return result;
    };
    const health = async () => (await host.admin.listConnections(staff, { tenantId: t }))[0]!;
    return { host, t, id, call, health };
  };

  const capture = () => {
    const points: Point[] = [];
    const recorder = analyticsEngineConnectorCallRecorder({ writeDataPoint: (p) => void points.push(p) });
    return { points, recorder };
  };

  describe('no field can carry a secret or a payload', () => {
    it('ok, 5xx, thrown and timed-out calls each write one point, and none holds what the call carried', async () => {
      const { points, recorder } = capture();
      const w = await world(recorder);
      expect(await w.call('/ok')).toBe('resolved');
      expect(await w.call('/fail')).toBe('resolved');
      expect(await w.call('/throw')).toBe('rejected');
      expect(await w.call('/hang', 30)).toBe('rejected');

      expect(points).toHaveLength(4);
      const written = JSON.stringify(points);
      for (const f of FORBIDDEN) expect(written).not.toContain(f);
      // Every blob is a row identifier or an enum member — nothing else can be in one.
      for (const p of points) {
        expect(p.indexes).toEqual([w.t]);
        expect(p.blobs!.slice(0, 2)).toEqual(['scrive', 'docs']);
        expect(p.doubles).toHaveLength(2);
      }
    });

    it('its positive twin: the same calls DID carry those strings — the health line holds the error text', async () => {
      const { points, recorder } = capture();
      const w = await world(recorder);
      await w.call('/throw');
      // The thrown message reached the one place it belongs, so the absence above is the
      // recorder's shape keeping it out, not a call that never carried it.
      expect((await w.health()).lastError).toContain(SECRET.apiToken);
      expect(points).toHaveLength(1);
      expect(JSON.stringify(points)).not.toContain(SECRET.apiToken);
    });

    it('classifies each call from its status or its abort — the closed outcome enum', async () => {
      const { points, recorder } = capture();
      const w = await world(recorder);
      await w.call('/ok');
      await w.call('/fail');
      await w.call('/throw');
      await w.call('/hang', 30);
      expect(points.map((p) => p.blobs![2])).toEqual(['ok', 'http_5xx', 'network', 'timeout']);
      expect(points.map((p) => p.doubles![1])).toEqual([200, 500, 0, 0]);
      // Timed where the call is made: a real duration, never the "untimed" sentinel.
      for (const p of points) expect(p.doubles![0]).toBeGreaterThanOrEqual(0);
    });
  });

  describe('the recorder cannot fail or stall the call', () => {
    it('a throwing Analytics Engine write is swallowed and counted; the call and its health line are untouched', async () => {
      const recorder = analyticsEngineConnectorCallRecorder({
        writeDataPoint: () => {
          throw new Error('Analytics Engine unavailable');
        },
      });
      const w = await world(recorder);
      expect(await w.call('/ok')).toBe('resolved');
      expect(await w.call('/fail')).toBe('resolved');
      expect(recorder.dropped).toBe(2);
      const h = await w.health();
      expect(h.lastOkAt).not.toBeNull();
      expect(h.lastError).toBe('HTTP 500 from scrive');
    });

    it('its positive twin: a working write drops nothing', async () => {
      const { points, recorder } = capture();
      const w = await world(recorder);
      await w.call('/ok');
      expect(recorder.dropped).toBe(0);
      expect(points).toHaveLength(1);
    });

    it('a recorder that throws is not rethrown', async () => {
      const throwing: ConnectorCallRecorder = {
        record() {
          throw new Error('recorder bug');
        },
      };
      expect(await (await world(throwing)).call('/ok')).toBe('resolved');
    });

    it('a recorder that never settles is not awaited', async () => {
      let asked = 0;
      const hanging = {
        record() {
          asked += 1;
          return new Promise(() => {}); // never settles
        },
      } as unknown as ConnectorCallRecorder;
      const w = await world(hanging);
      const outcome = await Promise.race([
        w.call('/ok'),
        new Promise((r) => setTimeout(() => r('stalled'), 2_000)),
      ]);
      expect(outcome).toBe('resolved');
      expect(asked).toBe(1);
    });

    it('with no recorder at all (the self-host default) the call is unchanged', async () => {
      const w = await world();
      expect(await w.call('/ok')).toBe('resolved');
      expect((await w.health()).lastOkAt).not.toBeNull();
    });
  });
});
