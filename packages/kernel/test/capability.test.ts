import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_SECRET_PREFIX,
  capabilityId,
  node as nodeSchema,
  permissionKey,
  principalId,
  type CheckSubject,
  type Node,
  type RoleDefinition,
} from '@substrat-run/contracts';
import {
  WITHHELD_SECRET,
  capabilityExchangeable,
  capabilityLive,
  capabilityTokenHash,
  carriesSecret,
  guardSecrets,
  mintCapabilitySecret,
  redactSecrets,
  type CapabilityRow,
} from '../src/capability.js';
import {
  createTupleEvaluator,
  type PermissionTupleReader,
  type PermissionTupleRow,
  type ScopeTupleReader,
} from '../src/permission-eval.js';
import type { ScopedSql } from '../src/scope-host.js';

/**
 * The capability branch of the evaluator (#1672), against a reader with nothing in it but
 * rows — so each of its four steps is shown to deny ON ITS OWN, which the contract suite
 * cannot always show: there the session door refuses a revoked or expired capability
 * before the checker is ever asked, so the checker's own liveness step is masked.
 */

const T = '01JZ0000000000000000000001';
const S = '01JZ0000000000000000000002';
const ALICE = '01JZ00000000000000000000A1';
const CAP = '01JZ00000000000000000000C1';
const NOW = '2026-01-01T00:00:00.000Z';

const NODE: Node = nodeSchema.parse({ tenantId: T, scopeId: S });
const TENANT_NODE: Node = nodeSchema.parse({ tenantId: T, scopeId: null });
const READ = permissionKey.parse('doc:read');
const WRITE = permissionKey.parse('doc:write');

const tuple = (
  subject: string,
  relation: string,
  object: string,
  extra: Partial<Pick<PermissionTupleRow, 'expires_at' | 'revoked_at'>> = {},
): PermissionTupleRow => ({
  subject,
  relation,
  object,
  expires_at: extra.expires_at ?? null,
  revoked_at: extra.revoked_at ?? null,
});

const capRow = (over: Partial<CapabilityRow> = {}): CapabilityRow => ({
  id: CAP,
  mode: 'act',
  label: null,
  entity_type: 'folder',
  entity_id: 'F',
  permissions: JSON.stringify([READ]),
  operations: null,
  principal: null,
  minted_by: JSON.stringify(ALICE),
  minted_at: '2025-12-01T00:00:00.000Z',
  expires_at: null,
  max_uses: null,
  uses: 0,
  last_used_at: null,
  revoked_at: null,
  revoked_by: null,
  ...over,
});

/** The tree: doc d1 → folder F; doc d3 → folder G. Alice reads the whole scope. */
const readerFor = (opts: {
  cap?: CapabilityRow;
  aliceHolds?: boolean;
  withCapabilityRead?: boolean;
}): PermissionTupleReader => {
  const rows: PermissionTupleRow[] = [
    tuple('doc:d1', 'parent', 'folder:F'),
    tuple('doc:d3', 'parent', 'folder:G'),
    ...(opts.aliceHolds === false ? [] : [tuple(`principal:${ALICE}`, 'role:staff', `scope:${S}`)]),
  ];
  const scope: ScopeTupleReader = {
    tuples: (subject, prefix) => rows.filter((r) => r.subject === subject && r.relation.startsWith(prefix)),
    grant: (subject, relation, object) =>
      rows.find((r) => r.subject === subject && r.relation === relation && r.object === object),
    parents: (object) => rows.filter((r) => r.subject === object && r.relation === 'parent'),
    ...(opts.withCapabilityRead === false
      ? {}
      : { capability: (id: string) => (opts.cap && opts.cap.id === id ? opts.cap : undefined) }),
  };
  return {
    now: () => NOW,
    tenantTuples: () => [],
    getRole: (_t, key) =>
      key === 'staff'
        ? ({ key: 'staff', permissions: [READ, WRITE], source: 'vertical' } as RoleDefinition)
        : undefined,
    scopeFor: () => scope,
  };
};

const capability: CheckSubject = { kind: 'capability', id: capabilityId.parse(CAP) };
const d1 = { entityType: 'doc', entityId: 'd1' };
const d3 = { entityType: 'doc', entityId: 'd3' };

describe('the evaluator’s capability branch', () => {
  it('allows its key on an entity beneath its root, proving it through the walk and the minter', async () => {
    const decision = await createTupleEvaluator(readerFor({ cap: capRow() })).check(
      capability,
      READ,
      NODE,
      d1,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.proof).toEqual([
      { subject: `principal:${ALICE}`, relation: 'role:staff', object: `scope:${S}` },
      { subject: 'role:staff', relation: 'granted:doc:read', object: `scope:${S}` },
      { subject: `capability:${CAP}`, relation: 'minted-by', object: `principal:${ALICE}` },
      { subject: 'doc:d1', relation: 'parent', object: 'folder:F' },
      { subject: `capability:${CAP}`, relation: 'granted:doc:read', object: 'folder:F' },
    ]);
  });

  const denials: [string, Parameters<typeof readerFor>[0], Partial<{ entity: typeof d1 | undefined; permission: typeof READ; node: Node }>][] = [
    ['a sibling subtree', { cap: capRow() }, { entity: d3 }],
    ['a key it does not carry, though the minter holds it', { cap: capRow() }, { permission: WRITE }],
    ['a node-level check', { cap: capRow() }, { entity: undefined }],
    ['a tenant-node check', { cap: capRow() }, { node: TENANT_NODE }],
    ['a revoked capability', { cap: capRow({ revoked_at: '2025-12-15T00:00:00.000Z' }) }, {}],
    ['an expired capability', { cap: capRow({ expires_at: NOW }) }, {}],
    ['a minter who no longer holds the key', { cap: capRow(), aliceHolds: false }, {}],
    ['a `become` capability, which never acts', { cap: capRow({ mode: 'become', principal: ALICE }) }, {}],
    ['a platform-minted row', { cap: capRow({ minted_by: JSON.stringify({ platform: ALICE }) }) }, {}],
    ['a row whose permissions do not decode', { cap: capRow({ permissions: 'not json' }) }, {}],
    ['an unknown capability', {}, {}],
    ['a reader with no capability read at all', { cap: capRow(), withCapabilityRead: false }, {}],
  ];
  for (const [what, world, over] of denials) {
    it(`denies ${what}`, async () => {
      const decision = await createTupleEvaluator(readerFor(world)).check(
        capability,
        over.permission ?? READ,
        over.node ?? NODE,
        'entity' in over ? over.entity : d1,
      );
      expect(decision.allowed).toBe(false);
    });
  }

  it('an expiry one moment in the future still allows — the boundary is exclusive of now', async () => {
    const decision = await createTupleEvaluator(
      readerFor({ cap: capRow({ expires_at: '2026-01-01T00:00:00.001Z' }) }),
    ).check(capability, READ, NODE, d1);
    expect(decision.allowed).toBe(true);
  });

  it('writing a `capability:` TUPLE grants nothing — the row is the only authority', async () => {
    const reader = readerFor({ cap: undefined });
    const scope = reader.scopeFor(NODE)!;
    const forged = tuple(`capability:${CAP}`, 'granted:doc:read', 'folder:F');
    const withForgery: PermissionTupleReader = {
      ...reader,
      scopeFor: () => ({
        ...scope,
        grant: (s, r, o) =>
          s === forged.subject && r === forged.relation && o === forged.object ? forged : scope.grant(s, r, o),
        tuples: (s, prefix) => (s === forged.subject && forged.relation.startsWith(prefix) ? [forged] : scope.tuples(s, prefix)),
      }),
    };
    expect((await createTupleEvaluator(withForgery).check(capability, READ, NODE, d1)).allowed).toBe(false);
  });

  it('covers nothing — a capability can confer no role', async () => {
    expect(await createTupleEvaluator(readerFor({ cap: capRow() })).covers(capability, [READ, READ], NODE)).toEqual({
      covered: false,
      missing: [READ],
    });
  });

  it('principals are untouched by the branch', async () => {
    const alice: CheckSubject = { kind: 'principal', id: principalId.parse(ALICE) };
    expect((await createTupleEvaluator(readerFor({})).check(alice, READ, NODE, d1)).allowed).toBe(true);
  });
});

describe('capability liveness and the use limit', () => {
  it('live = not revoked and not expired; exchangeable adds the use limit', () => {
    expect(capabilityLive(capRow(), NOW)).toBe(true);
    expect(capabilityLive(capRow({ revoked_at: NOW }), NOW)).toBe(false);
    expect(capabilityLive(capRow({ expires_at: NOW }), NOW)).toBe(false);
    expect(capabilityExchangeable(capRow({ max_uses: 2, uses: 1 }), NOW)).toBe(true);
    expect(capabilityExchangeable(capRow({ max_uses: 2, uses: 2 }), NOW)).toBe(false);
    expect(capabilityExchangeable(capRow({ max_uses: null, uses: 10_000 }), NOW)).toBe(true);
    // At the limit a capability still ACTS — the limit bounds exchanges, not use.
    expect(capabilityLive(capRow({ max_uses: 1, uses: 1 }), NOW)).toBe(true);
  });
});

describe('the secret', () => {
  it('is 256 bits behind the prefix, and never the same twice', () => {
    const a = mintCapabilitySecret();
    const b = mintCapabilitySecret();
    expect(a.startsWith(CAPABILITY_SECRET_PREFIX)).toBe(true);
    // 32 bytes → 43 base64url characters, no padding.
    expect(a.slice(CAPABILITY_SECRET_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('is hashed with SHA-256, hex', async () => {
    // The standard test vector for "abc".
    expect(await capabilityTokenHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('is found anywhere in a value — nested, or spliced into a string', () => {
    const s = mintCapabilitySecret();
    expect(carriesSecret({ a: [{ b: `https://x/#share=${s}` }] }, [s])).toBe(true);
    expect(carriesSecret({ a: [{ b: 'nothing' }] }, [s])).toBe(false);
    expect(carriesSecret('anything', [])).toBe(false);
  });

  it('is withheld from a recording wherever it appears, and nothing else changes', () => {
    const s = mintCapabilitySecret();
    expect(redactSecrets({ id: 'x', link: `https://x/#share=${s}`, n: 3 }, [s])).toEqual({
      id: 'x',
      link: `https://x/#share=${WITHHELD_SECRET}`,
      n: 3,
    });
    const untouched = { a: 1 };
    expect(redactSecrets(untouched, [])).toBe(untouched);
  });

  it('cannot reach ctx.sql — in the statement or a parameter — while other statements pass', () => {
    const s = mintCapabilitySecret();
    const ran: string[] = [];
    const inner: ScopedSql = {
      query: (sql) => {
        ran.push(sql);
        return [];
      },
      exec: (sql) => {
        ran.push(sql);
        return { changes: 0 };
      },
    };
    const guarded = guardSecrets(inner, [s]);
    expect(() => guarded.exec('INSERT INTO t VALUES (?)', [s])).toThrow(/capability secret/);
    expect(() => guarded.query(`SELECT '${s}'`)).toThrow(/capability secret/);
    guarded.exec('INSERT INTO t VALUES (?)', ['fine']);
    expect(ran).toEqual(['INSERT INTO t VALUES (?)']);
  });
});
