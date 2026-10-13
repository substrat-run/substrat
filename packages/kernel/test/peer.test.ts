import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  errorCodeOf,
  moduleManifest,
  peerSpec,
  scopeId as scopeIdOf,
  tenantId as tenantIdOf,
  type ScopeId,
} from '@substrat-run/contracts';
import {
  actorOf,
  admitPeer,
  collectPeers,
  peerSeats,
  resolvePeerInstanceFrom,
  samePeerVertical,
  peerVerticalSpellings,
  peerCallerAt,
  resolveVerticalInstanceFrom,
  seatScopeTuple,
  switchPeer,
  ulid,
  type SwitchSql,
  type VerticalInstanceCandidate,
} from '../src/index.js';
import { idempotencySubject } from '../src/idempotency.js';

/**
 * #1706: the kernel's half of the peer door — each rule the two adapters share, executed alone,
 * so a break in one is named by the test that pins it rather than by a suite-wide red.
 */

const CALLER = 'acme/board-room';
const S = scopeIdOf.parse(ulid());
const callerScope = scopeIdOf.parse(ulid());

const fresh = (): { db: DatabaseSync; sql: SwitchSql } => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE _substrat_tuples (
    subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
    expires_at TEXT, revoked_at TEXT, PRIMARY KEY (subject, relation, object)
  )`);
  const sql: SwitchSql = {
    all: (q, ...p) => db.prepare(q).all(...p) as Record<string, unknown>[],
    run: (q, ...p) => {
      db.prepare(q).run(...p);
    },
  };
  return { db, sql };
};

const manifest = (peers: unknown) =>
  moduleManifest.parse({
    id: '@test/target',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: { emits: [], consumes: [] },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'target',
    peers,
  });

describe('the peer declaration (#1706)', () => {
  it('a receive-only peer — `operations: []` — parses', () => {
    expect(peerSpec.parse({ vertical: CALLER, operations: [], permissions: ['doc:read'] })).toEqual({
      vertical: CALLER,
      operations: [],
      permissions: ['doc:read'],
    });
  });

  it('`permissions: []` is refused: a peer entry that grants nothing declares nothing', () => {
    expect(peerSpec.safeParse({ vertical: CALLER, operations: ['doc/list'], permissions: [] }).success).toBe(false);
    expect(peerSpec.safeParse({ vertical: CALLER, operations: [], permissions: [] }).success).toBe(false);
  });

  it('a slug is the registry id — owner-prefixed or bare — and nothing else', () => {
    expect(peerSpec.safeParse({ vertical: 'callout', operations: [], permissions: ['a:b'] }).success).toBe(true);
    for (const bad of ['Acme/Board', 'https://crm.example', 'a/b/c', '']) {
      expect(peerSpec.safeParse({ vertical: bad, operations: [], permissions: ['a:b'] }).success).toBe(false);
    }
  });

  it('one module names a peer once; duplicates inside an entry are refused', () => {
    expect(() =>
      manifest([
        { vertical: CALLER, operations: [], permissions: ['a:b'] },
        { vertical: CALLER, operations: ['x/y'], permissions: ['a:c'] },
      ]),
    ).toThrow(/more than once/);
    expect(peerSpec.safeParse({ vertical: CALLER, operations: ['x/y', 'x/y'], permissions: ['a:b'] }).success).toBe(
      false,
    );
  });

  it('two modules naming one peer are read as their union', () => {
    const peers = collectPeers([
      { peers: [peerSpec.parse({ vertical: CALLER, operations: ['a/one'], permissions: ['a:read'] })] },
      { peers: [peerSpec.parse({ vertical: CALLER, operations: ['b/two'], permissions: ['b:read'] })] },
      {},
    ]);
    expect([...peers.get(CALLER)!.operations].sort()).toEqual(['a/one', 'b/two']);
    expect([...peers.get(CALLER)!.permissions].sort()).toEqual(['a:read', 'b:read']);
  });
});

describe('peerSeats + admitPeer (#1706)', () => {
  const peers = collectPeers([
    { peers: [peerSpec.parse({ vertical: CALLER, operations: ['doc/list'], permissions: ['doc:write', 'doc:read'] })] },
    { peers: [peerSpec.parse({ vertical: 'acme/listener', operations: [], permissions: ['doc:read'] })] },
  ]);
  const caller = { vertical: CALLER, scope: callerScope };

  it('seats one `vertical:<slug>` grant per declared key on the scope, in a stable order', () => {
    expect(peerSeats(peers, S)).toEqual([
      { subject: 'vertical:acme/board-room', relation: 'granted:doc:read', object: `scope:${S}` },
      { subject: 'vertical:acme/board-room', relation: 'granted:doc:write', object: `scope:${S}` },
      { subject: 'vertical:acme/listener', relation: 'granted:doc:read', object: `scope:${S}` },
    ]);
  });

  it('admits a declared peer on an allowlisted operation, as the subject the spine records', () => {
    const { sql } = fresh();
    const subject = admitPeer(sql, peers, caller, 'doc/list');
    expect(subject).toEqual({ kind: 'vertical', id: CALLER, scope: callerScope });
    expect(actorOf(subject)).toEqual({ vertical: CALLER, scope: callerScope });
  });

  it('refuses an undeclared peer, an operation off the allowlist, and a receive-only peer’s call', () => {
    const { sql } = fresh();
    const refused = (fn: () => unknown) => {
      try {
        fn();
        return 'admitted';
      } catch (e) {
        return errorCodeOf(e);
      }
    };
    expect(refused(() => admitPeer(sql, peers, { vertical: 'acme/stranger', scope: callerScope }, 'doc/list'))).toBe(
      'forbidden',
    );
    expect(refused(() => admitPeer(sql, peers, caller, 'doc/delete'))).toBe('forbidden');
    expect(refused(() => admitPeer(sql, peers, { vertical: 'acme/listener', scope: callerScope }, 'doc/list'))).toBe(
      'forbidden',
    );
    // A DELIVERY (`null`, #1705) names no operation and meets no allowlist — receive-only included.
    expect(refused(() => admitPeer(sql, peers, { vertical: 'acme/listener', scope: callerScope }, null))).toBe(
      'admitted',
    );
  });

  it('a switched-off peer is refused at admission — and a delivery too — until restored', () => {
    const { db, sql } = fresh();
    for (const seat of peerSeats(peers, S)) {
      const st = seatScopeTuple(seat.subject, seat.relation, seat.object, null);
      db.prepare(st.sql).run(...st.params);
    }
    expect(switchPeer(sql, { vertical: CALLER, scopeId: S, to: 'off', at: '2026-09-22T00:00:00.000Z' })).toMatchObject({
      held: true,
      changed: true,
    });
    expect(() => admitPeer(sql, peers, caller, 'doc/list')).toThrow(/switched off/);
    expect(() => admitPeer(sql, peers, caller, null)).toThrow(/switched off/);
    // The seat is blocked while OFF: a re-provision writes nothing live for the peer.
    for (const seat of peerSeats(peers, S)) {
      const st = seatScopeTuple(seat.subject, seat.relation, seat.object, null);
      db.prepare(st.sql).run(...st.params);
    }
    const live = db
      .prepare(
        "SELECT relation FROM _substrat_tuples WHERE subject = ? AND substr(relation, 1, 8) = 'granted:' AND revoked_at IS NULL",
      )
      .all(`vertical:${CALLER}`);
    expect(live).toEqual([]);
    switchPeer(sql, { vertical: CALLER, scopeId: S, to: 'on', at: '2026-09-22T00:01:00.000Z' });
    expect(admitPeer(sql, peers, caller, 'doc/list')).toMatchObject({ kind: 'vertical' });
  });

  it('an idempotency key is scoped per calling instance, not per vertical', () => {
    const a = idempotencySubject({ kind: 'vertical', id: CALLER, scope: callerScope });
    const b = idempotencySubject({ kind: 'vertical', id: CALLER, scope: scopeIdOf.parse(ulid()) });
    expect(a).not.toBe(b);
    expect(a.startsWith(`vertical:${CALLER}@`)).toBe(true);
  });
});

describe('resolveVerticalInstanceFrom (#1706)', () => {
  const T = tenantIdOf.parse(ulid());
  const U = tenantIdOf.parse(ulid());
  const row = (over: Partial<VerticalInstanceCandidate> = {}): VerticalInstanceCandidate => ({
    id: scopeIdOf.parse(ulid()),
    tenantId: T,
    vertical: 'acme/crm',
    status: 'active',
    kind: 'default',
    forkedFrom: null,
    ...over,
  });

  it('exactly one primary, active instance of that vertical in that tenant resolves', () => {
    const only = row();
    expect(resolveVerticalInstanceFrom([only], { id: T, slug: null }, 'acme/crm')).toEqual({
      outcome: 'resolved',
      instance: { tenantId: T, scopeId: only.id, vertical: 'acme/crm' },
    });
  });

  it('never counts another tenant’s, a preview, a fork, a suspended or an archived one', () => {
    const noise = [
      row({ tenantId: U }),
      row({ kind: 'preview' }),
      row({ forkedFrom: scopeIdOf.parse(ulid()) as ScopeId }),
      row({ status: 'suspended' }),
      row({ status: 'archived' }),
      row({ status: 'provisioning' }),
      row({ vertical: 'acme/other' }),
    ];
    expect(resolveVerticalInstanceFrom(noise, { id: T, slug: null }, 'acme/crm')).toEqual({
      outcome: 'not-installed',
      tenantId: T,
      vertical: 'acme/crm',
    });
    expect(resolveVerticalInstanceFrom([...noise, row()], { id: T, slug: null }, 'acme/crm').outcome).toBe('resolved');
  });

  it('two live instances are ambiguous', () => {
    expect(resolveVerticalInstanceFrom([row(), row()], { id: T, slug: null }, 'acme/crm')).toEqual({
      outcome: 'ambiguous',
      tenantId: T,
      vertical: 'acme/crm',
      count: 2,
    });
  });

  it('an explicit binding chooses exactly its live, same-tenant primary scope', () => {
    const chosen = row();
    const other = row();
    expect(resolvePeerInstanceFrom([other, chosen], { id: T, slug: null }, 'acme/crm', chosen.id)).toEqual({
      outcome: 'resolved', instance: { tenantId: T, scopeId: chosen.id, vertical: 'acme/crm' },
    });
    expect(resolvePeerInstanceFrom([other, chosen], { id: T, slug: null }, 'acme/crm', null).outcome).toBe('ambiguous');
  });

  it('a stale binding never falls back to a remaining live instance', () => {
    const chosen = row({ status: 'suspended' });
    const other = row();
    const expected = { outcome: 'bound-unavailable', tenantId: T, vertical: 'acme/crm', targetScopeId: chosen.id };
    expect(resolvePeerInstanceFrom([chosen, other], { id: T, slug: null }, 'acme/crm', chosen.id)).toEqual(expected);
    expect(resolvePeerInstanceFrom([other], { id: T, slug: null }, 'acme/crm', chosen.id)).toEqual(expected);
    expect(resolvePeerInstanceFrom([row({ ...chosen, tenantId: U, status: 'active' }), other], { id: T, slug: null }, 'acme/crm', chosen.id)).toEqual(expected);
    expect(resolvePeerInstanceFrom([row({ ...chosen, status: 'active', vertical: 'acme/other' }), other], { id: T, slug: null }, 'acme/crm', chosen.id)).toEqual(expected);
    expect(resolvePeerInstanceFrom([row({ ...chosen, status: 'active', kind: 'preview' }), other], { id: T, slug: null }, 'acme/crm', chosen.id)).toEqual(expected);
    expect(resolvePeerInstanceFrom([row({ ...chosen, status: 'active' }), other], { id: T, slug: null }, 'acme/crm', chosen.id).outcome).toBe('resolved');
    expect(resolvePeerInstanceFrom([row({ ...chosen, status: 'active' }), other], { id: T, slug: null }, 'acme/crm', chosen.id, true)).toEqual(expected);
  });
});

describe('a tenant-pinned registration is the same peer vertical, in its own tenant only (#2252)', () => {
  const T2 = tenantIdOf.parse(ulid());
  const own = { id: T2, slug: 't-abc' };
  const scope = (vertical: string): VerticalInstanceCandidate => ({
    id: scopeIdOf.parse(ulid()),
    tenantId: T2,
    vertical,
    status: 'active',
    kind: '',
    forkedFrom: null,
  });

  it('a bare declared name reaches its exact spelling and this tenant\'s pinned one, nothing else', () => {
    expect(peerVerticalSpellings('crm', 't-abc')).toEqual(['crm', 't-abc/crm']);
    expect(samePeerVertical('t-abc/crm', 'crm', 't-abc')).toBe(true);
    expect(samePeerVertical('crm', 'crm', 't-abc')).toBe(true);
    // Another tenant's listed vertical is another vertical.
    expect(samePeerVertical('acme/crm', 'crm', 't-abc')).toBe(false);
    // Never the reverse: a declared prefixed name does not reach a bare registration.
    expect(samePeerVertical('crm', 't-abc/crm', 't-abc')).toBe(false);
    expect(samePeerVertical('crm', 'acme/crm', 't-abc')).toBe(false);
    // A slug that merely ends the same way.
    expect(samePeerVertical('t-abc/my-crm', 'crm', 't-abc')).toBe(false);
    // Read with no tenant slug, names match exactly.
    expect(samePeerVertical('t-abc/crm', 'crm', null)).toBe(false);
    expect(samePeerVertical('t-abc/crm', 'crm', '')).toBe(false);
    // Empty strings match nothing.
    expect(peerVerticalSpellings('', 't-abc')).toEqual([]);
    expect(samePeerVertical('', '', 't-abc')).toBe(false);
    expect(samePeerVertical('t-abc/', '', 't-abc')).toBe(false);
    expect(samePeerVertical(null, 'crm', 't-abc')).toBe(false);
  });

  it('resolves the declared bare name to the one pinned install', () => {
    const only = scope('t-abc/crm');
    expect(resolveVerticalInstanceFrom([only, scope('t-abc/other')], own, 'crm')).toEqual({
      outcome: 'resolved',
      instance: { tenantId: T2, scopeId: only.id, vertical: 'crm' },
    });
    expect(resolvePeerInstanceFrom([only], own, 'crm', only.id)).toMatchObject({ outcome: 'resolved' });
  });

  it('never resolves another tenant\'s prefix, or a declared prefixed name to a bare install', () => {
    const foreign = scope('acme/crm');
    expect(resolveVerticalInstanceFrom([foreign], own, 'crm').outcome).toBe('not-installed');
    expect(resolvePeerInstanceFrom([foreign], own, 'crm', foreign.id).outcome).toBe('bound-unavailable');
    expect(resolveVerticalInstanceFrom([scope('crm')], own, 'acme/crm').outcome).toBe('not-installed');
  });

  it('an exact install wins over the pinned one, so a tenant running both still resolves; a binding chooses either', () => {
    const bare = scope('crm');
    const pinned = scope('t-abc/crm');
    expect(resolveVerticalInstanceFrom([pinned, bare], own, 'crm')).toEqual({
      outcome: 'resolved',
      instance: { tenantId: T2, scopeId: bare.id, vertical: 'crm' },
    });
    // A tenant running the exact one and another tenant's `acme/crm` resolves as before.
    expect(resolveVerticalInstanceFrom([bare, scope('acme/crm')], own, 'crm')).toMatchObject({ outcome: 'resolved' });
    expect(resolvePeerInstanceFrom([bare, pinned], own, 'crm', pinned.id)).toMatchObject({
      outcome: 'resolved', instance: { scopeId: pinned.id },
    });
  });

  it('two pinned installs stay ambiguous until one is bound', () => {
    const a = scope('t-abc/crm');
    const b = scope('t-abc/crm');
    expect(resolveVerticalInstanceFrom([a, b], own, 'crm')).toMatchObject({ outcome: 'ambiguous', count: 2 });
    expect(resolvePeerInstanceFrom([a, b], own, 'crm', b.id)).toMatchObject({ outcome: 'resolved', instance: { scopeId: b.id } });
  });

  it('the door: a declaration naming the caller\'s registered spelling wins, then this tenant\'s pin; a foreign prefix is refused', () => {
    const { sql } = fresh();
    const declare = (...names: string[]) =>
      collectPeers([{ peers: names.map((vertical) => peerSpec.parse({ vertical, operations: ['doc/list'], permissions: ['doc:read'] })) }]);
    const at = (peers: ReturnType<typeof declare>, vertical: string, tenantSlug?: string) =>
      admitPeer(sql, peers, peerCallerAt(peers, { vertical, scope: callerScope, ...(tenantSlug ? { tenantSlug } : {}) }), 'doc/list');
    // A pinned caller meets the bare slug its target declares, keyed by the declared name.
    expect(at(declare('crm'), 't-abc/crm', 't-abc')).toEqual({ kind: 'vertical', id: 'crm', scope: callerScope });
    // The slug is never recorded: the caller the door reads carries none.
    expect(peerCallerAt(declare('crm'), { vertical: 't-abc/crm', scope: callerScope, tenantSlug: 't-abc' }))
      .toEqual({ vertical: 'crm', scope: callerScope });
    // A target declaring the full pinned spelling keeps working, with or without the slug.
    expect(at(declare('t-abc/crm'), 't-abc/crm', 't-abc')).toMatchObject({ id: 't-abc/crm' });
    expect(at(declare('t-abc/crm'), 't-abc/crm')).toMatchObject({ id: 't-abc/crm' });
    // Both declared: the registered spelling wins.
    expect(at(declare('crm', 't-abc/crm'), 't-abc/crm', 't-abc')).toMatchObject({ id: 't-abc/crm' });
    // Another tenant's listed vertical is not the declared `crm`, and gets no seat.
    expect(() => at(declare('crm'), 'acme/crm', 't-abc')).toThrow(/not a declared peer/);
    // Without the platform's slug (an older router or drain), the door matches exactly, as before.
    expect(() => at(declare('crm'), 't-abc/crm')).toThrow(/not a declared peer/);
    // Never the reverse: a bare caller does not meet a declared pinned spelling.
    expect(() => at(declare('t-abc/crm'), 'crm', 't-abc')).toThrow(/not a declared peer/);
  });
});
