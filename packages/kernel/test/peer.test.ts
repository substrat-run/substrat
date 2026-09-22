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
  idempotencySubject,
  peerSeats,
  resolveVerticalInstanceFrom,
  seatScopeTuple,
  switchPeer,
  ulid,
  type SwitchSql,
  type VerticalInstanceCandidate,
} from '../src/index.js';

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
    expect(resolveVerticalInstanceFrom([only], T, 'acme/crm')).toEqual({
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
    expect(resolveVerticalInstanceFrom(noise, T, 'acme/crm')).toEqual({
      outcome: 'not-installed',
      tenantId: T,
      vertical: 'acme/crm',
    });
    expect(resolveVerticalInstanceFrom([...noise, row()], T, 'acme/crm').outcome).toBe('resolved');
  });

  it('two live instances are ambiguous', () => {
    expect(resolveVerticalInstanceFrom([row(), row()], T, 'acme/crm')).toEqual({
      outcome: 'ambiguous',
      tenantId: T,
      vertical: 'acme/crm',
      count: 2,
    });
  });
});
