import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  SOCIAL_RELAY_CONFIG_KEY,
  SOCIAL_RELAY_DELIVERY_STALE,
  SOCIAL_RELAY_SECRET_NEEDED,
  SOCIAL_RELAY_SECRET_STALE,
  type SocialRelayDelivery,
} from '@substrat-run/contracts';
import { SCHEMA_STATEMENTS } from '../db/ddl.generated.js';
import { createAdminApi } from '../src/admin-api.js';
import { genericProvidersFrom, readProvider, readProviders, upsertProvider } from '../src/providers.js';
import { isSocialRelayEntry, parseSocialRelayEntry, syncSocialRelay } from '../src/social-relay.js';
import type { SqlExec } from '../src/introspect.js';

/**
 * Platform-provided social sign-in (#1544), the issuer's half: what one `substrat:social-relay`
 * delivery does to `identity_provider`, and what the admin panel may then do to those rows.
 *
 * The promises are about what an operator does NOT see change: a delivered provider arrives
 * switched off, a re-delivery never overrides a decision they made, a provider of their own under
 * the same id is never touched, and the platform's credential cannot be edited or deleted out
 * from under the reconciler that will deliver it again.
 */

let sql: SqlExec;

function sqlExecOf(database: Database.Database): SqlExec {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = database.prepare(query);
      if (!stmt.reader) {
        stmt.run(...(bindings as []));
        return { columnNames: [], toArray: () => [], raw: () => [][Symbol.iterator]() };
      }
      const objects = stmt.all(...(bindings as [])) as Record<string, unknown>[];
      return {
        columnNames: stmt.columns().map((c) => c.name),
        toArray: () => objects,
        raw: () => (stmt.raw(true).all(...(bindings as [])) as unknown[][]).values(),
      };
    },
  };
}

const RELAY = 'https://id.substrat.net';

function provider(id: string, label: string) {
  const issuer = `${RELAY}/${id}`;
  return {
    id,
    label,
    issuer,
    endpoints: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
    },
  };
}

function delivery(over: Partial<SocialRelayDelivery> = {}): SocialRelayDelivery {
  return {
    clientId: 'relay-client-1',
    clientSecret: 'secret-1',
    providers: [provider('github', 'GitHub')],
    ...over,
  };
}

beforeEach(() => {
  const database = new Database(':memory:');
  sql = sqlExecOf(database);
  for (const statement of SCHEMA_STATEMENTS) sql.exec(statement);
});

describe('the delivered entry', () => {
  it('is recognised by its key alone', () => {
    expect(isSocialRelayEntry(SOCIAL_RELAY_CONFIG_KEY)).toBe(true);
    expect(isSocialRelayEntry('substrat:social-relay:extra')).toBe(false);
  });

  it('parses a well-formed delivery', () => {
    expect(parseSocialRelayEntry(JSON.stringify(delivery()))).toEqual(delivery());
  });

  it('refuses endpoints that are not under the provider’s own issuer', () => {
    const bad = provider('github', 'GitHub');
    bad.endpoints.token_endpoint = 'https://elsewhere.example/token';
    expect(() => parseSocialRelayEntry(JSON.stringify(delivery({ providers: [bad] })))).toThrow(/not under its issuer/);
    const plain = provider('github', 'GitHub');
    plain.endpoints.authorization_endpoint = 'http://id.substrat.net/github/authorize';
    expect(() => parseSocialRelayEntry(JSON.stringify(delivery({ providers: [plain] })))).toThrow();
  });

  it('refuses endpoints describing another issuer', () => {
    const bad = provider('github', 'GitHub');
    bad.endpoints.issuer = `${RELAY}/google`;
    expect(() => parseSocialRelayEntry(JSON.stringify(delivery({ providers: [bad] })))).toThrow(/another issuer/);
  });
});

describe('syncing the rows', () => {
  it('creates each provider switched off, under its relay id, as a generic row', () => {
    const sync = syncSocialRelay(sql, delivery({ providers: [provider('github', 'GitHub'), provider('google', 'Google')] }));
    expect(sync).toEqual({
      refused: null,
      created: ['github-relay', 'google-relay'],
      updated: [],
      switchedOff: [],
      operatorOwned: [],
    });
    expect(readProvider(sql, 'github-relay')).toMatchObject({
      client_id: 'relay-client-1',
      client_secret: 'secret-1',
      issuer: `${RELAY}/github`,
      label: 'GitHub',
      disabled: 1,
      allow_signup: 0,
      trust_email: 0,
    });
    // Off means not mounted: nothing reaches Better Auth until an operator switches it on.
    expect(genericProvidersFrom(readProviders(sql)) ?? []).toEqual([]);
  });

  it('replaces the credential on re-delivery and keeps every decision the operator made', () => {
    syncSocialRelay(sql, delivery());
    sql.exec(
      "UPDATE identity_provider SET disabled = 0, allow_signup = 1, trust_email = 1 WHERE provider_id = 'github-relay'",
    );
    const sync = syncSocialRelay(sql, delivery({ clientSecret: 'secret-2' }));
    expect(sync.updated).toEqual(['github-relay']);
    expect(readProvider(sql, 'github-relay')).toMatchObject({
      client_secret: 'secret-2',
      disabled: 0,
      allow_signup: 1,
      trust_email: 1,
    });
    const mounted = genericProvidersFrom(readProviders(sql)) ?? [];
    expect(mounted).toHaveLength(1);
    expect(mounted[0]).toMatchObject({ providerId: 'github-relay', clientId: 'relay-client-1', clientSecret: 'secret-2' });
  });

  it('keeps the held secret when a re-delivery carries none, and creates a new provider with it', () => {
    syncSocialRelay(sql, delivery());
    const { clientSecret: _none, ...withoutSecret } = delivery({
      providers: [provider('github', 'GitHub'), provider('google', 'Google')],
    });
    const sync = syncSocialRelay(sql, withoutSecret);
    expect(sync).toMatchObject({ refused: null, created: ['google-relay'], updated: ['github-relay'] });
    expect(readProvider(sql, 'github-relay')?.client_secret).toBe('secret-1');
    expect(readProvider(sql, 'google-relay')?.client_secret).toBe('secret-1');
  });

  it('writes nothing and asks for the secret when it holds none for that client', () => {
    const { clientSecret: _none, ...withoutSecret } = delivery();
    expect(syncSocialRelay(sql, withoutSecret)).toMatchObject({ refused: SOCIAL_RELAY_SECRET_NEEDED, created: [] });
    expect(readProviders(sql)).toEqual([]);
    // A secret held for ANOTHER client (the relay client was replaced) is not this one's.
    syncSocialRelay(sql, delivery());
    expect(syncSocialRelay(sql, { ...withoutSecret, clientId: 'relay-client-2' }).refused).toBe(SOCIAL_RELAY_SECRET_NEEDED);
    expect(readProvider(sql, 'github-relay')?.client_id).toBe('relay-client-1');
  });

  it('never touches an operator’s own provider under the same id', () => {
    upsertProvider(sql, 'github-relay', {
      clientId: 'theirs',
      clientSecret: 'their-secret',
      issuer: 'https://idp.acme.example',
      label: 'Their GitHub bridge',
      allowSignup: false,
      trustEmail: false,
      disabled: false,
    });
    const sync = syncSocialRelay(sql, delivery());
    expect(sync.operatorOwned).toEqual(['github-relay']);
    expect(readProvider(sql, 'github-relay')).toMatchObject({ client_id: 'theirs', client_secret: 'their-secret' });
  });

  it('adopts a row configured against the relay by hand, keeping it enabled', () => {
    upsertProvider(sql, 'github-relay', {
      clientId: 'hand-registered',
      clientSecret: 'hand-secret',
      issuer: `${RELAY}/github`,
      label: 'GitHub',
      allowSignup: true,
      trustEmail: false,
      disabled: false,
    });
    expect(syncSocialRelay(sql, delivery()).updated).toEqual(['github-relay']);
    expect(readProvider(sql, 'github-relay')).toMatchObject({ client_id: 'relay-client-1', disabled: 0, allow_signup: 1 });
  });

  it('switches off a provider the relay stopped serving, and leaves it switched off when it returns', () => {
    syncSocialRelay(sql, delivery({ providers: [provider('github', 'GitHub'), provider('google', 'Google')] }));
    sql.exec("UPDATE identity_provider SET disabled = 0 WHERE provider_id = 'google-relay'");
    expect(syncSocialRelay(sql, delivery()).switchedOff).toEqual(['google-relay']);
    expect(readProvider(sql, 'google-relay')?.disabled).toBe(1);
    syncSocialRelay(sql, delivery({ providers: [provider('github', 'GitHub'), provider('google', 'Google')] }));
    expect(readProvider(sql, 'google-relay')?.disabled).toBe(1);
  });

  it('does not switch off a provider of the operator’s that merely ends in -relay', () => {
    upsertProvider(sql, 'corp-relay', {
      clientId: 'theirs',
      clientSecret: 'their-secret',
      issuer: 'https://idp.acme.example',
      label: 'Corp',
      allowSignup: false,
      trustEmail: false,
      disabled: false,
    });
    expect(syncSocialRelay(sql, delivery()).switchedOff).toEqual([]);
    expect(readProvider(sql, 'corp-relay')?.disabled).toBe(0);
  });
});

/**
 * The secret's generation (#3275). The relay accepts only its newest secret, so these are the
 * promises that keep an install from holding a dead one: an older secret never overwrites a newer,
 * and a held secret the relay has moved past is reported, so the platform rotates it once.
 */
describe('secret generations', () => {
  const secretless = (over: Partial<SocialRelayDelivery> = {}) => {
    const { clientSecret: _none, ...rest } = delivery(over);
    return rest;
  };
  const held = () => JSON.parse(String(sql.exec("SELECT value FROM config WHERE key = 'social_relay_client'").toArray()[0]?.value));

  it('refuses a secret older than the one held, writing nothing — the out-of-order delivery of #3275', () => {
    // Run B's rotation (generation 3) landed first; run A's (generation 2) arrives late.
    syncSocialRelay(sql, delivery({ clientSecret: 'secret-b', generation: 3 }));
    const late = syncSocialRelay(
      sql,
      delivery({ clientSecret: 'secret-a', generation: 2, providers: [provider('github', 'GitHub'), provider('google', 'Google')] }),
    );
    expect(late).toMatchObject({ refused: SOCIAL_RELAY_DELIVERY_STALE, created: [], updated: [] });
    expect(held()).toEqual({ clientId: 'relay-client-1', clientSecret: 'secret-b', generation: 3 });
    expect(readProviders(sql).map((r) => [r.provider_id, r.client_secret])).toEqual([['github-relay', 'secret-b']]);
    // In order, the newer one is taken, and so is the same one again.
    expect(syncSocialRelay(sql, delivery({ clientSecret: 'secret-c', generation: 4 })).refused).toBeNull();
    expect(syncSocialRelay(sql, delivery({ clientSecret: 'secret-c', generation: 4 })).refused).toBeNull();
    expect(held()).toEqual({ clientId: 'relay-client-1', clientSecret: 'secret-c', generation: 4 });
  });

  it('reports a held secret the relay has rotated past, writing nothing, so the platform rotates it', () => {
    syncSocialRelay(sql, delivery({ clientSecret: 'secret-a', generation: 2 }));
    const stuck = syncSocialRelay(sql, secretless({ generation: 3, providers: [provider('github', 'GitHub'), provider('google', 'Google')] }));
    expect(stuck).toMatchObject({ refused: SOCIAL_RELAY_SECRET_STALE, created: [] });
    expect(readProvider(sql, 'google-relay')).toBeUndefined();
    // The rotation's delivery heals it.
    expect(syncSocialRelay(sql, delivery({ clientSecret: 'secret-b', generation: 4 })).refused).toBeNull();
    expect(syncSocialRelay(sql, secretless({ generation: 4 })).refused).toBeNull();
    expect(readProvider(sql, 'github-relay')?.client_secret).toBe('secret-b');
  });

  it('keeps a held secret newer than the generation a secretless delivery read', () => {
    syncSocialRelay(sql, delivery({ clientSecret: 'secret-b', generation: 3 }));
    expect(syncSocialRelay(sql, secretless({ generation: 2 })).refused).toBeNull();
    expect(held()).toEqual({ clientId: 'relay-client-1', clientSecret: 'secret-b', generation: 3 });
  });

  it('cannot vouch for a secret held from before generations, so asks for one; one delivered is taken', () => {
    sql.exec(
      "INSERT INTO config (key, value) VALUES ('social_relay_client', ?)",
      JSON.stringify({ clientId: 'relay-client-1', clientSecret: 'legacy' }),
    );
    expect(syncSocialRelay(sql, secretless({ generation: 1 })).refused).toBe(SOCIAL_RELAY_SECRET_NEEDED);
    // A platform that sends no generation is handled as it always was.
    expect(syncSocialRelay(sql, secretless()).refused).toBeNull();
    expect(syncSocialRelay(sql, delivery({ clientSecret: 'fresh', generation: 2 })).refused).toBeNull();
    expect(held()).toEqual({ clientId: 'relay-client-1', clientSecret: 'fresh', generation: 2 });
  });

  it('takes a new client’s secret whatever generation the old client’s was at', () => {
    syncSocialRelay(sql, delivery({ clientSecret: 'old-client', generation: 7 }));
    expect(syncSocialRelay(sql, delivery({ clientId: 'relay-client-2', clientSecret: 'new-client', generation: 1 })).refused).toBeNull();
    expect(held()).toEqual({ clientId: 'relay-client-2', clientSecret: 'new-client', generation: 1 });
  });
});

describe('the admin panel on a platform row', () => {
  function api() {
    return createAdminApi({
      sql,
      session: async () => ({ sub: 'admin', email: 'admin@acme.example', name: 'Admin', role: 'admin' }),
      effectiveCfg: () => ({}),
      auth: () => ({}) as never,
      offeredProviders: () => [],
      transaction: (fn) => fn(),
    });
  }
  const json = { 'content-type': 'application/json' };

  it('marks it as the platform’s', async () => {
    syncSocialRelay(sql, delivery());
    const res = await api().request('/providers');
    const body = (await res.json()) as { providers: { id: string; platform: boolean }[] };
    expect(body.providers).toEqual([expect.objectContaining({ id: 'github-relay', platform: true })]);
  });

  it('lets a save change the three decisions and nothing else', async () => {
    syncSocialRelay(sql, delivery());
    const res = await api().request('/providers/github-relay', {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({
        clientId: 'attempted',
        clientSecret: 'attempted-secret',
        issuer: 'https://evil.example',
        label: 'Not GitHub',
        allowSignup: true,
        trustEmail: true,
        disabled: false,
      }),
    });
    expect(res.status).toBe(200);
    expect(readProvider(sql, 'github-relay')).toMatchObject({
      client_id: 'relay-client-1',
      client_secret: 'secret-1',
      issuer: `${RELAY}/github`,
      label: 'GitHub',
      allow_signup: 1,
      trust_email: 1,
      disabled: 0,
    });
  });

  it('refuses to remove it, pointing at the switch instead', async () => {
    syncSocialRelay(sql, delivery());
    const res = await api().request('/providers/github-relay', { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(readProvider(sql, 'github-relay')).toBeDefined();
  });
});
