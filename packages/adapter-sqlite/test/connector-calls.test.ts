import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectionId, platformActorId, scopeId, tenantId, type DomainEvent } from '@substrat-run/contracts';
import {
  ulid,
  webCryptoSecretBox,
  type ConnectorCallRecord,
  type ConnectorCallRecorder,
  type FetchLike,
} from '@substrat-run/kernel';
import { SqliteScopeHost } from '../src/index.js';

/**
 * One record per connector call (#1691), on the self-host path — the connection's
 * sanctioned `fetch`, settled by `recordConnectionUse`, handed to the recorder.
 *
 * Two properties, each with its positive twin: nothing a call carries (credential, URL
 * query, body, the provider's error body, a thrown message) reaches a record; and the
 * recorder cannot fail or stall the call, however it misbehaves. Where a record lands in an
 * Analytics Engine point is the hosted adapter's, and its own suite holds that (#1978).
 */

/** Every string a call carries that must never reach a record. */
const SECRET = { apiToken: 'tok-LIVE-9f3a-do-not-record' };
const PAYLOAD = 'personnummer-19121212-1212';
const QUERY = 'access_token=qs-LIVE-77aa';
const HOSTNAME = 'provider.invalid';
const THROWN = `socket hang up while sending ${SECRET.apiToken}`;
const FORBIDDEN = [SECRET.apiToken, PAYLOAD, QUERY, 'qs-LIVE-77aa', HOSTNAME, 'socket hang up', 'HTTP 500'];

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
    return { host, staff, t, s, id, call, health };
  };

  const capture = () => {
    const records: ConnectorCallRecord[] = [];
    const recorder: ConnectorCallRecorder = { record: (call) => void records.push(call) };
    return { records, recorder };
  };

  it('dispatches for provisioning while the tenant is active, then holds a suspended tenant', async () => {
    const w = await world(); // The scope remains provisioning throughout this test.
    expect(await w.call('/ok')).toBe('resolved');
    await w.host.admin.setTenantStatus(w.staff, w.t, 'suspended');
    let called = false;
    await expect(w.host.dispatchConnector(
      w.t,
      w.s,
      async () => { called = true; },
      { id: ulid(), type: 'doc.send-requested', payload: {} } as unknown as DomainEvent,
    )).rejects.toThrow(/tenant not active \(status: suspended\)/);
    expect(called).toBe(false);
  });

  describe('no field can carry a secret or a payload', () => {
    it('ok, 5xx, thrown and timed-out calls each hand over one record, and none holds what the call carried', async () => {
      const { records, recorder } = capture();
      const w = await world(recorder);
      expect(await w.call('/ok')).toBe('resolved');
      expect(await w.call('/fail')).toBe('resolved');
      expect(await w.call('/throw')).toBe('rejected');
      expect(await w.call('/hang', 30)).toBe('rejected');

      expect(records).toHaveLength(4);
      const written = JSON.stringify(records);
      for (const f of FORBIDDEN) expect(written).not.toContain(f);
      // Every string is a row identifier or an enum member — nothing else can be in one.
      for (const r of records) {
        expect(r['substrat.tenant.id']).toBe(w.t);
        expect(r['substrat.connection.provider']).toBe('scrive');
        expect(r['substrat.vertical']).toBe('docs');
      }
    });

    it('its positive twin: the same calls DID carry those strings — the health line holds the error text', async () => {
      const { records, recorder } = capture();
      const w = await world(recorder);
      await w.call('/throw');
      // The thrown message reached the one place it belongs, so the absence above is the
      // recorder's shape keeping it out, not a call that never carried it.
      expect((await w.health()).lastError).toContain(SECRET.apiToken);
      expect(records).toHaveLength(1);
      expect(JSON.stringify(records)).not.toContain(SECRET.apiToken);
    });

    it('classifies each call from its status or its abort — OTel error.type, closed enum', async () => {
      const { records, recorder } = capture();
      const w = await world(recorder);
      await w.call('/ok');
      await w.call('/fail');
      await w.call('/throw');
      await w.call('/hang', 30);
      // A success sets no error.type at all.
      expect(records.map((r) => r['error.type'])).toEqual([undefined, '5xx', 'network', 'timeout']);
      expect(records.map((r) => r['http.response.status_code'])).toEqual([200, 500, undefined, undefined]);
      // Timed where the call is made: a real duration (seconds), never absent.
      for (const r of records) expect(r['http.client.request.duration']).toBeGreaterThanOrEqual(0);
    });
  });

  describe('an untimed settlement is still a call (#1691)', () => {
    it('carries no duration but keeps its error.type, so it counts in calls and errors', async () => {
      const { records, recorder } = capture();
      const w = await world(recorder);
      // The shape the connect-time probe and any legacy caller use: no duration, no status.
      await w.host.admin.recordConnectionUse(w.id, { ok: true });
      await w.host.admin.recordConnectionUse(w.id, { ok: false, error: 'provider refused' });
      const identity = { 'substrat.tenant.id': w.t, 'substrat.connection.provider': 'scrive', 'substrat.vertical': 'docs' };
      expect(records).toEqual([identity, { ...identity, 'error.type': '_OTHER' }]);
    });
  });

  describe('the recorder cannot fail or stall the call', () => {
    it('a recorder that throws is not rethrown; the call and its health line are untouched', async () => {
      let asked = 0;
      const throwing: ConnectorCallRecorder = {
        record() {
          asked += 1;
          throw new Error('recorder bug');
        },
      };
      const w = await world(throwing);
      expect(await w.call('/ok')).toBe('resolved');
      expect(await w.call('/fail')).toBe('resolved');
      expect(asked).toBe(2);
      const h = await w.health();
      expect(h.lastOkAt).not.toBeNull();
      expect(h.lastError).toBe('HTTP 500 from scrive');
    });

    it('its positive twin: a working recorder is handed each call', async () => {
      const { records, recorder } = capture();
      const w = await world(recorder);
      await w.call('/ok');
      expect(records).toHaveLength(1);
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
