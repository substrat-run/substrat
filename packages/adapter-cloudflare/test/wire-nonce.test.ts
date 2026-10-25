/**
 * RFC wire-signing §4 on the scope's own object: the nonce store is in storage, so it survives an
 * eviction; a claim is bookkeeping, so it advances no write revision a carry fences on; and no dump
 * carries it. The behaviour both adapters share is `wireNonceContractSuite`, in contract.test.ts.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { platformActorId, scopeId, tenantId } from '@substrat-run/contracts';
import { WIRE_NONCE_CAP, WIRE_NONCE_TABLE_NAMES, WRITE_REVISION_KEY, dumpMetaValue, ulid } from '@substrat-run/kernel';
import { CloudflareScopeHost } from './test-host.js';
import { warmControlPlane } from './do-warmup.js';

beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

const until = () => Math.floor(Date.now() / 1000) + 3600;
const nonce = () => `${ulid().toLowerCase()}aaaaA`.slice(-22).replace(/.$/, 'A');

describe('the wire nonce store in the scope object (RFC wire-signing §4)', () => {
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  let host: CloudflareScopeHost;

  beforeAll(async () => {
    host = new CloudflareScopeHost({ scope: env.SCOPE, controlPlane: env.CONTROL_PLANE });
    await host.admin.createTenant(staff, { id: t, slug: `wire-nonce-do-${t.slice(-8).toLowerCase()}`, name: 'Wire nonces' });
  });

  const newScope = async () => {
    const s = scopeId.parse(ulid());
    await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'wire-nonce' });
    await host.admin.activateScope(staff, t, s);
    return s;
  };
  const raw = (s: string) => env.SCOPE.get(env.SCOPE.idFromName(s));
  const revisionOf = async (s: string) =>
    runInDurableObject(raw(s), (_o, state) =>
      (state.storage.sql.exec(`SELECT value FROM _substrat_meta WHERE key = ?`, WRITE_REVISION_KEY).toArray()[0] as { value: string } | undefined)?.value ?? null,
    );
  const rowsOf = async (s: string) =>
    runInDurableObject(raw(s), (_o, state) => Number((state.storage.sql.exec('SELECT COUNT(*) AS n FROM _substrat_wire_nonces').toArray()[0] as { n: number }).n));

  it('a claim advances no write revision, and an ordinary write beside it still does', async () => {
    const s = await newScope();
    const before = await revisionOf(s);
    expect(await host.claimWireNonceLocal(t, s, nonce(), until())).toBe(true);
    expect(await host.claimWireNonceLocal(t, s, nonce(), until())).toBe(true);
    expect(await rowsOf(s)).toBe(2);
    expect(await revisionOf(s)).toBe(before);
    // The twin: the revision is still moved by a write that is the scope's data.
    await host.restoreScope(staff, t, s, await host.admin.exportScope(staff, t, s));
    expect(await revisionOf(s)).not.toBe(before);
  });

  it('no dump carries the store or a claim, and taking one leaves the revision where it was', async () => {
    const s = await newScope();
    await host.claimWireNonceLocal(t, s, nonce(), until());
    const before = await revisionOf(s);
    const tables = await host.exportScopeLocal(s);
    for (const name of WIRE_NONCE_TABLE_NAMES) expect(tables.map((x) => x.name)).not.toContain(name);
    expect(dumpMetaValue(tables, WRITE_REVISION_KEY)).toBeNull();
    expect(await revisionOf(s)).toBe(before);
  });

  it('a spent nonce stays spent after the object is evicted and woken again', async () => {
    const s = await newScope();
    const a = nonce();
    expect(await host.claimWireNonceLocal(t, s, a, until())).toBe(true);
    await runInDurableObject(raw(s), (_o, state) => {
      state.abort('evicted for the wire nonce store');
    }).catch(() => undefined);
    expect(await host.claimWireNonceLocal(t, s, a, until())).toBe(false);
    expect(await host.claimWireNonceLocal(t, s, nonce(), until())).toBe(true);
  });

  it('a store at its cap throws through the RPC, and a claim after the window frees it', async () => {
    const s = await newScope();
    // Fill the count to the cap by hand, with rows already expired: the next claim purges a batch
    // first, so it is admitted; a count at the cap with nothing expired is refused.
    await runInDurableObject(raw(s), (_o, state) => {
      state.storage.sql.exec(`INSERT INTO _substrat_wire_nonce_count (slot, live) VALUES ('live', ?)`, WIRE_NONCE_CAP);
    });
    await expect(() => host.claimWireNonceLocal(t, s, nonce(), until())).rejects.toThrow(/wire nonce store/);
    await runInDurableObject(raw(s), (_o, state) => {
      state.storage.sql.exec(`INSERT INTO _substrat_wire_nonces (nonce, until_s) VALUES (?, 1)`, nonce());
    });
    expect(await host.claimWireNonceLocal(t, s, nonce(), until())).toBe(true);
  });
});
