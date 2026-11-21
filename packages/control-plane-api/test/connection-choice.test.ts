import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { runPlatformSweep, ulid, webCryptoSecretBox, type ConnectionBinder } from '@substrat-run/kernel';
import { connectionId, permissionKey, platformActorId, principalId, scopeId, tenantId, type ConnectionId, type ScopeId } from '@substrat-run/contracts';
import { bindPlanimaScope, listPlanimaBindings, unbindPlanimaScope } from '@substrat-run/connector-planima';
import {
  ConnectionRelayError,
  chooseScopeConnection,
  connectionBindingOptions,
  readScopeConnectionChoice,
  relayConnectionCheckout,
  type PaymentCheckout,
} from '../src/index.js';
import { heldVersion } from './held-manifest.js';

/**
 * #3221: a tenant holding two payment accounts chooses which one each install's checkouts go
 * through. Planima's binder stands in for the payment provider's, made `exclusive` the way the
 * control plane's `connectionBindersFor` makes one for a provider that takes payments.
 */
describe('choosing the connection an install lands through (#3221)', () => {
  const SLUG = 'acme-shop';
  const LAND = permissionKey.parse('payment:record');
  const actor = platformActorId.parse(ulid());
  const person = principalId.parse(ulid());

  let dir: string;
  let host: SqliteScopeHost;
  let t: ReturnType<typeof tenantId.parse>;
  let a: ScopeId;
  let b: ScopeId;

  const binder = (exclusive = true): ConnectionBinder => ({
    list: (h, row) => listPlanimaBindings(h, row.id),
    bind: (h, row, target) => bindPlanimaScope(h, { ...(target as Parameters<typeof bindPlanimaScope>[1]), connectionId: row.id }),
    options: (raw, current) => {
      const schema = connectionBindingOptions('planima');
      return schema.parse({ ...(current ? schema.strip().parse(current) : {}), ...(raw ?? {}) });
    },
    unbind: (h, row, s) => unbindPlanimaScope(h, row.id, s),
    ...(exclusive ? { exclusive: true as const } : {}),
  });
  const landings = (exclusive = true) => ({ read: (slug: string, v: string) => host.versionConnectionLandings(slug, v), binders: { planima: binder(exclusive) } });

  const runs = async (mode: 'every-install' | 'on-request' = 'every-install') => {
    const id = ulid();
    await host.admin.publishVersion(actor, await heldVersion({
      id, verticalSlug: SLUG, version: `1.0.${id.toLowerCase()}`, manifestDigest: `m-${id}`, permissionDigest: 'p', migrationDigest: 'g', deploymentRef: null,
      manifestJson: JSON.stringify({
        registry: {
          permissions: [{ key: LAND, description: 'land a payment', declaredBy: ['@acme/shop'] }],
          roles: [],
          entityGrants: [],
          connections: [{ provider: 'planima', operation: 'shop/land', permission: LAND, ...(mode === 'on-request' ? { bind: mode } : {}), declaredBy: ['@acme/shop'] }],
        },
      }),
    }));
    await host.admin.admitVersion(actor, id);
    for (const s of [a, b]) await host.admin.bindScopeVersion(actor, t, s, id);
  };
  /** A tenant connection for one account, as the dashboard's door makes one. */
  const connect = async (account: string): Promise<ConnectionId> => {
    const id = connectionId.parse(ulid());
    await host.admin.createConnection(actor, { id, tenantId: t, vertical: SLUG, provider: 'planima', label: account, externalAccountRef: account, secret: { token: account } });
    return id;
  };
  const pass = (exclusive = true) =>
    runPlatformSweep(host, {
      actor,
      fetch: globalThis.fetch,
      sweepers: { planima: async () => ({ found: 0, failed: [] }) },
      drainRetries: false,
      recordFailure: () => {},
      connectionLandings: landings(exclusive),
    });
  /** Each scope's bound connections, as the binder lists them. */
  const boundTo = async (...conns: ConnectionId[]) => {
    const out: Record<string, ConnectionId[]> = { [a]: [], [b]: [] };
    for (const c of conns) for (const x of await listPlanimaBindings(host, c)) out[x.scopeId]!.push(c);
    return out;
  };
  const holds = async (s: ScopeId, c: ConnectionId) => (await host.connectionGrantsInScope(t, s)).some((g) => g.connectionId === c && g.permission === LAND);
  const choose = (s: ScopeId, c: string, exclusive = true) =>
    chooseScopeConnection(host, actor, { tenantId: t, scopeId: s, provider: 'planima', connectionId: c, chosenBy: person }, { landings: landings(exclusive) });
  const refusal = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof ConnectionRelayError ? e.status : e));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'connection-choice-'));
    host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(7)) });
    t = tenantId.parse(ulid());
    a = scopeId.parse(ulid());
    b = scopeId.parse(ulid());
    await host.admin.createTenant(actor, { id: t, slug: 'acme', name: 'Acme' });
    await host.admin.registerVertical(actor, { slug: SLUG, name: 'Acme Shop', source: 'builtin' });
    for (const s of [a, b]) {
      await host.provisionScope(actor, { tenantId: t, scopeId: s, vertical: SLUG });
      await host.admin.activateScope(actor, t, s);
    }
    await runs();
  });

  afterEach(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds every install to the first account only, keeps the one a tenant chooses, and checks out through it', async () => {
    const first = await connect('acct_first');
    await pass();
    // One account: every install lands through it, exactly as before the choice existed.
    expect(await boundTo(first)).toEqual({ [a]: [first], [b]: [first] });

    // A second account connected later binds nowhere, so no install is left with two.
    const second = await connect('acct_second');
    await pass();
    expect(await boundTo(first, second)).toEqual({ [a]: [first], [b]: [first] });
    expect(await holds(a, second)).toBe(false);

    // The tenant moves install a to the second account: bound and keyed there, the first taken off.
    expect(await choose(a, second)).toEqual({ provider: 'planima', scopeId: a, chosen: second, bound: [second], unbound: [first] });
    expect(await boundTo(first, second)).toEqual({ [a]: [second], [b]: [first] });
    expect([await holds(a, second), await holds(a, first)]).toEqual([true, false]);
    const row = (await host.admin.auditLog(actor, { tenantId: t })).find((e) => e.action === 'bindConnectionScope' && (e.after as { connectionId?: string })?.connectionId === second);
    expect(row?.after).toMatchObject({ requestedBy: person, phase: 'applied' });

    // The next pass keeps the choice, and the checkout goes through the chosen account.
    await pass();
    expect(await boundTo(first, second)).toEqual({ [a]: [second], [b]: [first] });
    const asked: string[] = [];
    const checkout: PaymentCheckout = async (_h, conn) => {
      asked.push(conn.id);
      return { connectionId: conn.id, checkoutId: 'cs_test_1', url: 'https://checkout.example.com/cs_test_1', expiresAt: '2026-11-15T11:00:00.000Z' as never, live: false };
    };
    const order = { tenantId: t, scopeId: a, provider: 'planima', reference: 'order-1', currency: 'SEK', lines: [{ name: 'Mug', quantity: 1, unitAmount: '99.50' }], successUrl: 'https://shop.example.com/paid', cancelUrl: 'https://shop.example.com/cart' };
    await relayConnectionCheckout(host, actor, order, { proven: true, landings: landings(), checkout: () => checkout });
    expect(asked).toEqual([second]);

    // Disconnecting the chosen account leaves install a unbound until the next pass gives it the one left.
    await host.admin.revokeConnection(actor, second);
    await pass();
    expect(await boundTo(first)).toEqual({ [a]: [first], [b]: [first] });
  });

  it('leaves an install bound to two accounts as it found it, says a choice is owed, and the choice settles it', async () => {
    const first = await connect('acct_first');
    const second = await connect('acct_second');
    // What an every-install landing left before #3221: both accounts bound everywhere.
    await pass(false);
    expect(await boundTo(first, second)).toEqual({ [a]: [first, second], [b]: [first, second] });

    await pass();
    expect(await boundTo(first, second)).toEqual({ [a]: [first, second], [b]: [first, second] });
    const read = () => readScopeConnectionChoice(host, actor, { tenantId: t, scopeId: b, provider: 'planima' }, { landings: landings() });
    expect(await read()).toEqual({ provider: 'planima', scopeId: b, chosen: null, bound: [first, second].sort() });

    await choose(b, first);
    expect(await read()).toEqual({ provider: 'planima', scopeId: b, chosen: first, bound: [first] });
    // Choosing again changes nothing.
    expect(await choose(b, first)).toMatchObject({ chosen: first, unbound: [] });
  });

  it('refuses a provider that binds every connection, an unknown or revoked connection, an archived install and an on-request landing', async () => {
    const first = await connect('acct_first');
    const other = await connect('acct_other');

    expect(await refusal(choose(a, first, false))).toBe(409);
    expect(await refusal(choose(a, connectionId.parse(ulid())))).toBe(404);
    await host.admin.revokeConnection(actor, other);
    expect(await refusal(choose(a, other))).toBe(404);
    await host.admin.archiveScope(actor, t, b);
    expect(await refusal(choose(b, first))).toBe(409);
    await runs('on-request');
    expect(await refusal(choose(a, first))).toBe(409);
    expect(await boundTo(first)).toEqual({ [a]: [], [b]: [] });
  });
});
