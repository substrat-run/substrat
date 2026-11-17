import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SOCIAL_RELAY_SELF_PATH, type SocialRelayDelivery } from '@substrat-run/contracts';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { createAdminApi } from '../src/admin-api.js';
import type { SqlExec } from '../src/introspect.js';
import { syncSocialRelay } from '../src/social-relay.js';
import { AUTO_HEAL_INTERVAL_MS, claimHeal, readHealRecord, recordHealResult } from '../src/social-relay-heal.js';
import { runHeal } from '../src/social-relay-self.js';

/**
 * Platform sign-in's self-heal (#1544), the install's half: when opening the Connections page asks
 * the platform to register this install at the social relay, how often, and what the operator's
 * "Set up" button asks. The worker routes that make the ask are in `internal-surface.test.ts`; the
 * platform's half (the route, the caller check, the rotation guard) is held in control-plane-api's
 * and the control plane's suites.
 */

const RELAY = 'https://id.substrat.net';
const CP = 'https://cp.substrat.test';
const INSTANCE = { tenantId: '01HTENANT00000000000000000', scopeId: '01HSCOPE000000000000000000' };
const T0 = new Date('2026-11-17T10:00:00.000Z');

function sqlOver(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return { columnNames: stmt.columns().map((c) => c.name), toArray: () => objects, raw: () => [][Symbol.iterator]() };
    },
  };
}

function provider(id: string) {
  const issuer = `${RELAY}/${id}`;
  return { id, label: id, issuer, endpoints: { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` } };
}

/** A relay that serves `served`, and a control plane that records each ask and answers `cpAnswer`. */
function world(served: string[], cpAnswer: () => { ok: boolean; status: number; json(): Promise<unknown> } = () => Response.json({ status: 'delivered', providers: served, rotated: false })) {
  const asked: unknown[] = [];
  const relayReads: string[] = [];
  const fetch = async (input: string, init?: { headers?: Record<string, string>; body?: string }) => {
    if (input === `${RELAY}/providers`) {
      relayReads.push(input);
      return Response.json({ providers: served.map(provider) });
    }
    if (input === `${CP}${SOCIAL_RELAY_SELF_PATH}`) {
      asked.push({ secret: init?.headers?.['x-substrat-platform'], body: JSON.parse(String(init?.body)) });
      return cpAnswer();
    }
    throw new Error(`unexpected fetch ${input}`);
  };
  return { asked, relayReads, transport: { controlPlaneUrl: CP, platformSecret: 'platform', fetch } };
}

let sql: SqlExec;

beforeEach(() => {
  const database = new Database(':memory:');
  for (const statement of SCHEMA_STATEMENTS) database.exec(statement);
  sql = sqlOver(database);
});

/** Give this install a relay client and rows for `upstreams`, as a delivery does. */
function delivered(upstreams: string[]): void {
  const delivery: SocialRelayDelivery = { clientId: 'relay-client-1', clientSecret: 'secret-1', providers: upstreams.map(provider) };
  syncSocialRelay(sql, delivery);
}

describe('when opening the Connections page asks the platform', () => {
  it('asks at most once per interval, a manual ask excepted, and never for an install nobody provisioned', () => {
    expect(claimHeal(sql, undefined, 'auto', T0)).toBeNull();
    expect(claimHeal(sql, INSTANCE, 'auto', T0)).toMatchObject({ ...INSTANCE, hasClient: false, relayOrigin: null });
    const later = (ms: number) => new Date(T0.getTime() + ms);
    expect(claimHeal(sql, INSTANCE, 'auto', later(AUTO_HEAL_INTERVAL_MS - 1))).toBeNull();
    expect(claimHeal(sql, INSTANCE, 'manual', later(AUTO_HEAL_INTERVAL_MS - 1))).not.toBeNull();
    // The manual claim moved the clock, so the automatic one waits a full interval from it.
    expect(claimHeal(sql, INSTANCE, 'auto', later(AUTO_HEAL_INTERVAL_MS))).toBeNull();
    expect(claimHeal(sql, INSTANCE, 'auto', later(2 * AUTO_HEAL_INTERVAL_MS - 1))).not.toBeNull();
  });

  it.each([
    // [rows held, relay serves, asks?, hasClient sent]
    ['no client held', null, ['github'], true, false],
    ['a provider the relay added since', ['github'], ['github', 'google'], true, true],
    ['nothing missing', ['github', 'google'], ['github', 'google'], false, undefined],
  ] as const)('%s', async (_name, held, served, asks, hasClient) => {
    if (held) delivered([...held]);
    const { asked, transport } = world([...served]);
    const claim = claimHeal(sql, INSTANCE, 'auto', T0)!;
    const result = await runHeal(claim, 'auto', transport);
    expect(asked).toEqual(asks ? [{ secret: 'platform', body: { ...INSTANCE, hasClient } }] : []);
    expect(result.status).toBe(asks ? 'delivered' : 'current');
  });

  it('counts a row the operator holds under the relay id as held, so it is not asked for forever', async () => {
    sql.exec(
      "INSERT INTO identity_provider (provider_id, client_id, client_secret, issuer, disabled, allow_signup, trust_email) VALUES ('google-relay', 'theirs', 's', 'https://idp.example', 0, 0, 0)",
    );
    delivered(['github', 'google']); // google-relay stays theirs: another issuer
    const { asked, transport } = world(['github', 'google']);
    expect(await runHeal(claimHeal(sql, INSTANCE, 'auto', T0)!, 'auto', transport)).toEqual({ status: 'current' });
    expect(asked).toEqual([]);
  });

  it('files a result under its own attempt, and drops one that finishes after a newer claim', () => {
    const auto = claimHeal(sql, INSTANCE, 'auto', T0)!;
    const manual = claimHeal(sql, INSTANCE, 'manual', T0)!;
    recordHealResult(sql, manual.attempt, { status: 'delivered', providers: ['github'] });
    recordHealResult(sql, auto.attempt, { status: 'failed', reason: 'slow' });
    expect(readHealRecord(sql)).toMatchObject({ attempt: manual.attempt, trigger: 'manual', result: { status: 'delivered' } });
  });

  it("tells the operator the platform's own sentence when it refuses", async () => {
    const { transport } = world(['github'], () =>
      Response.json({ status: 403, detail: "relay refused: 'x' may only act for its own scope" }, { status: 403, headers: { 'content-type': 'application/problem+json' } }),
    );
    expect(await runHeal(claimHeal(sql, INSTANCE, 'manual', T0)!, 'manual', transport)).toEqual({
      status: 'failed',
      reason: "relay refused: 'x' may only act for its own scope",
    });
  });
});

describe("the admin API's half", () => {
  const api = (hosted: boolean) =>
    createAdminApi({
      sql,
      session: async () => ({ sub: 'admin', email: 'admin@acme.example', name: 'Admin', role: 'admin' }),
      effectiveCfg: () => ({}),
      auth: () => ({}) as never,
      offeredProviders: () => [],
      transaction: (fn) => fn(),
      ...(hosted ? { socialRelayHeal: { claim: () => claimHeal(sql, INSTANCE, 'manual', T0) } } : {}),
    });

  it('offers the button where the platform can be asked, and claims for the worker; standalone it says nothing', async () => {
    const read = async (hosted: boolean) => ((await (await api(hosted).request('/providers')).json()) as { platformSignIn: unknown }).platformSignIn;
    expect(await read(true)).toEqual({ clientHeld: false, last: null });
    const sync = await api(true).request('/social-relay/sync', { method: 'POST' });
    expect(await sync.json()).toMatchObject({ ...INSTANCE, hasClient: false });
    expect(await read(true)).toEqual({ clientHeld: false, last: { attempt: expect.any(String), at: T0.toISOString(), trigger: 'manual' } });

    expect(await read(false)).toBeNull();
    expect((await api(false).request('/social-relay/sync', { method: 'POST' })).status).toBe(501);
  });
});
