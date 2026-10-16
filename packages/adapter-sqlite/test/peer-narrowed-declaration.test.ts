import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  permissionKey,
  platformActorId,
  scopeId,
  tenantId,
  type ModuleRegistration,
  type VerticalCaller,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { PEER_CALLER, freshnessMod, peerMod, peerModNarrowed, peerModWithoutCaller } from '@substrat-run/contract-tests';
import { SqliteScopeHost } from '../src/index.js';

/**
 * #2263: a version that NARROWS a peer, or drops it, takes the keys away on its first call.
 *
 * A peer's keys are tuples `peerSeats` wrote when the scope was provisioned, and a seat only ever
 * adds, so the tuples of an earlier, wider declaration are still live in the scope's storage. The
 * host's checker is bounded by the RUNNING declaration (`boundToPeerDeclarations`), so they are
 * inert evidence: never held, never brought back by the kill switch, and held again only when a
 * version declares the key again. Each host below is one version over the same scope storage.
 */
describe('#2263: a narrowed or removed peer declaration (pure adapter)', () => {
  const READ = permissionKey.parse('peer:read');
  const WRITE = permissionKey.parse('peer:write');
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const caller: VerticalCaller = { vertical: PEER_CALLER, scope: scopeId.parse(ulid()) };
  let dir: string;

  const full = peerMod;
  const narrowed = peerModNarrowed;
  const removed = peerModWithoutCaller;

  /** One version serving the scope storage in `dir`, closed afterwards. */
  async function serve<T>(version: ModuleRegistration, fn: (host: SqliteScopeHost) => Promise<T>): Promise<T> {
    const host = new SqliteScopeHost({ dir });
    host.registerModule(version);
    try {
      return await fn(host);
    } finally {
      await host.close();
    }
  }
  const refusal = (p: Promise<unknown>): Promise<string | undefined> =>
    p.then(
      () => undefined,
      (e: unknown) => errorCodeOf(e),
    );
  const call = (host: SqliteScopeHost, s: ReturnType<typeof scopeId.parse>, op: string, input?: unknown) =>
    host.getVerticalScope(caller, t, s).then((stub) => stub.invoke(op, input));
  const covers = (host: SqliteScopeHost, s: ReturnType<typeof scopeId.parse>) => host.peerCovers(t, s, PEER_CALLER, [READ, WRITE]);
  /** The scope's `vertical:` grant rows, read from its file with every host closed. */
  const tuples = (s: ReturnType<typeof scopeId.parse>) => {
    const db = new Database(join(dir, `${t}__${s}.sqlite`));
    try {
      return db
        .prepare(
          `SELECT relation, revoked_at IS NOT NULL AS revoked FROM _substrat_tuples
            WHERE subject = ? AND substr(relation, 1, 8) = 'granted:' ORDER BY relation`,
        )
        .all(`vertical:${PEER_CALLER}`);
    } finally {
      db.close();
    }
  };
  /** A fresh scope, provisioned (and so seated) by the WIDE declaration. */
  async function provisionedByFull() {
    const s = scopeId.parse(ulid());
    await serve(full, async (host) => {
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
      await host.admin.activateScope(staff, t, s);
      expect(await covers(host, s)).toEqual([
        { permission: READ, held: true },
        { permission: WRITE, held: true },
      ]);
    });
    return s;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'substrat-peer-narrowed-'));
    await serve(full, async (host) => {
      await host.admin.createTenant(staff, { id: t, slug: 'peer-narrowed', name: 'Peer narrowed' });
      await host.admin.grantEntitlement(staff, t, 'peer');
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a dropped key is not held from the first call of the narrower version, reconcile or not', async () => {
    const s = await provisionedByFull();
    await serve(narrowed, async (host) => {
      expect(await covers(host, s)).toEqual([
        { permission: READ, held: true },
        { permission: WRITE, held: false },
      ]);
      // `peer/note` checks the dropped key; `peer/list` the kept one.
      expect(await refusal(call(host, s, 'peer/note', { id: 'n1', body: 'x' }))).toBe('permission_denied');
      await expect(call(host, s, 'peer/list')).resolves.toEqual([]);
      // A reconcile changes nothing about it: it never takes the tuple, and never needs to.
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
      expect(await refusal(call(host, s, 'peer/note', { id: 'n1', body: 'x' }))).toBe('permission_denied');
    });
    // The stale tuple stays, live, as evidence (K-21) — inert under the narrower version.
    expect(tuples(s)).toEqual([
      { relation: 'granted:peer:read', revoked: 0 },
      { relation: 'granted:peer:write', revoked: 0 },
    ]);
  });

  it('a removed peer is refused at the door and holds nothing, though its tuples remain', async () => {
    const s = await provisionedByFull();
    await serve(removed, async (host) => {
      expect(await refusal(call(host, s, 'peer/list'))).toBe('forbidden');
      expect(await covers(host, s)).toEqual([
        { permission: READ, held: false },
        { permission: WRITE, held: false },
      ]);
    });
    expect(tuples(s)).toHaveLength(2);
  });

  it('the kill switch OFF then ON gives back only what the running declaration names', async () => {
    const s = await provisionedByFull();
    await serve(narrowed, async (host) => {
      const node = { tenantId: t, scopeId: s };
      await host.admin.revokeFromPeer(staff, { vertical: PEER_CALLER, node, reason: 'incident' });
      expect((await covers(host, s)).some((c) => c.held)).toBe(false);
      await host.admin.restoreToPeer(staff, { vertical: PEER_CALLER, node, reason: 'resolved' });
      expect(await covers(host, s)).toEqual([
        { permission: READ, held: true },
        { permission: WRITE, held: false },
      ]);
      expect(await refusal(call(host, s, 'peer/note', { id: 'n2', body: 'x' }))).toBe('permission_denied');
    });
  });

  it('a key declared again is held again, through the tuple that stayed', async () => {
    const s = await provisionedByFull();
    await serve(narrowed, async (host) => {
      expect(await refusal(call(host, s, 'peer/note', { id: 'n3', body: 'x' }))).toBe('permission_denied');
    });
    await serve(full, async (host) => {
      expect(await covers(host, s)).toEqual([
        { permission: READ, held: true },
        { permission: WRITE, held: true },
      ]);
      await expect(call(host, s, 'peer/note', { id: 'n3', body: 'x' })).resolves.toEqual({ id: 'n3' });
    });
  });

  it("an operator's tombstone stays a tombstone across a narrowing, a re-declaration and a reconcile", async () => {
    const s = await provisionedByFull();
    // An operator's revoke of one seat: the row tombstoned in place (#1659).
    const db = new Database(join(dir, `${t}__${s}.sqlite`));
    db.prepare(`UPDATE _substrat_tuples SET revoked_at = ? WHERE subject = ? AND relation = ?`).run(
      new Date().toISOString(),
      `vertical:${PEER_CALLER}`,
      'granted:peer:write',
    );
    db.close();
    await serve(narrowed, async (host) => {
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
    });
    await serve(full, async (host) => {
      await host.provisionScope(staff, { tenantId: t, scopeId: s });
      expect(await covers(host, s)).toEqual([
        { permission: READ, held: true },
        { permission: WRITE, held: false },
      ]);
      expect(await refusal(call(host, s, 'peer/note', { id: 'n4', body: 'x' }))).toBe('permission_denied');
    });
    expect(tuples(s)).toEqual([
      { relation: 'granted:peer:read', revoked: 0 },
      { relation: 'granted:peer:write', revoked: 1 },
    ]);
  });

  it('the declaration the checker reads is rebuilt when a module registers, never served stale', async () => {
    const s = await provisionedByFull();
    const host = new SqliteScopeHost({ dir });
    try {
      host.registerModule(freshnessMod);
      // Read the union while it declares no peer, so a cache that outlived registration would hold it.
      expect((host as unknown as { peerDeclarations(): Map<string, unknown> }).peerDeclarations().size).toBe(0);
      host.registerModule(peerMod);
      expect(await covers(host, s)).toEqual([
        { permission: READ, held: true },
        { permission: WRITE, held: true },
      ]);
    } finally {
      await host.close();
    }
  });
});
