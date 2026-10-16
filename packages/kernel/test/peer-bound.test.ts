import { describe, expect, it } from 'vitest';
import {
  entityRef,
  objectRef,
  peerSpec,
  permissionKey,
  principalId,
  scopeId as scopeIdOf,
  tenantId as tenantIdOf,
  type CheckSubject,
  type Coverage,
  type Decision,
  type Node,
  type PermissionKey,
} from '@substrat-run/contracts';
import { boundToPeerDeclarations, collectPeers, ulid, type PeerDeclarations, type PermissionChecker } from '../src/index.js';
import type { GrantedEntitiesPage } from '../src/grant-scoped-read.js';
import type { Holdings } from '../src/permission-checker.js';

/**
 * #2263: a peer holds a key only when the RUNNING declaration names it — `boundToPeerDeclarations`.
 * Each property here is one the adapters rely on, run against a scripted inner checker so a break
 * in the decorator is named by the test that pins it.
 */

const node: Node = { tenantId: tenantIdOf.parse(ulid()), scopeId: scopeIdOf.parse(ulid()) };
const KEYS = ['a:read', 'a:write', 'a:admin', 'b:read', 'b:write'].map((k) => permissionKey.parse(k));
const VERTICALS = ['acme/board-room', 'acme/crm', 'listener'];
const peerScope = scopeIdOf.parse(ulid());
const person = principalId.parse(ulid());
const NOTE = entityRef.parse({ entityType: 'note', entityId: 'n1' });

const subjectsOf = (): CheckSubject[] => [
  ...VERTICALS.map((id): CheckSubject => ({ kind: 'vertical', id, scope: peerScope })),
  { kind: 'principal', id: person },
  { kind: 'system', id: 'mod-a' } as CheckSubject,
];
const refOf = (s: CheckSubject): string => `${s.kind}:${s.id}`;

/** A deterministic PRNG, so a failing case reproduces from its seed. */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0x1_0000_0000;
  };
}

/** An inner checker holding exactly `held` (subject ref → keys), returning fresh objects per call. */
function scripted(held: Map<string, Set<string>>): PermissionChecker & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const has = (s: CheckSubject, p: string) => held.get(refOf(s))?.has(p) ?? false;
  return {
    calls,
    check: async (...args): Promise<Decision> => {
      calls.push(['check', ...args]);
      const [s, p, n] = args;
      return has(s, p)
        ? { allowed: true, proof: [{ subject: objectRef.parse(refOf(s)), relation: `granted:${p}`, object: objectRef.parse(`scope:${n.scopeId}`) }] }
        : { allowed: false, checked: p, node: n };
    },
    covers: async (...args): Promise<Coverage> => {
      calls.push(['covers', ...args]);
      const [s, required] = args;
      const missing = required.filter((p) => !has(s, p));
      return missing.length ? { covered: false, missing: [missing[0]!, ...missing.slice(1)] } : { covered: true, missing: [] };
    },
    holdings: async (...args): Promise<Holdings> => {
      calls.push(['holdings', ...args]);
      const [s] = args;
      const mine = [...(held.get(refOf(s)) ?? [])].map((p) => permissionKey.parse(p));
      return { permissions: mine, roles: ['member'], granted: mine, narrowed: mine.map((permission) => ({ permission, entity: NOTE })) };
    },
    grantedEntities: async (...args): Promise<GrantedEntitiesPage> => {
      calls.push(['grantedEntities', ...args]);
      const [s, p] = args;
      return has(s, p) ? { kind: 'ids', ids: ['n1'], nextCursor: null } : { kind: 'ids', ids: [], nextCursor: null };
    },
  };
}

function randomWorld(next: () => number): { held: Map<string, Set<string>>; peers: PeerDeclarations } {
  const pick = <T>(xs: readonly T[]) => xs.filter(() => next() < 0.5);
  const held = new Map<string, Set<string>>();
  for (const s of subjectsOf()) held.set(refOf(s), new Set(pick(KEYS)));
  const peers = collectPeers([
    {
      // A spec holds at least one key; an empty pick declares the peer with one key.
      peers: pick(VERTICALS).map((vertical) => {
        const keys = pick(KEYS);
        return peerSpec.parse({ vertical, operations: [], permissions: keys.length ? keys : [KEYS[0]!] });
      }),
    },
  ]);
  return { held, peers };
}

describe('#2263 boundToPeerDeclarations', () => {
  it('is a pure narrowing: never grants what the inner checker would not, for any declaration and tuples', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { held, peers } = randomWorld(rng(seed));
      const inner = scripted(held);
      const bounded = boundToPeerDeclarations(inner, () => peers);
      for (const s of subjectsOf()) {
        const declared = s.kind === 'vertical' ? (peers.get(s.id)?.permissions ?? new Set()) : undefined;
        for (const p of KEYS) {
          const innerAllowed = (await inner.check(s, p, node)).allowed;
          const allowed = (await bounded.check(s, p, node)).allowed;
          // Never wider than inner, and for a peer exactly inner ∩ declared.
          if (allowed) expect(innerAllowed, `seed ${seed} ${refOf(s)} ${p}`).toBe(true);
          expect(allowed, `seed ${seed} ${refOf(s)} ${p}`).toBe(declared ? innerAllowed && declared.has(p) : innerAllowed);
          const page = await bounded.grantedEntities!(s, p, node, 'note', async () => true);
          const innerPage = await inner.grantedEntities!(s, p, node, 'note', async () => true);
          const innerSome = innerPage.kind === 'ids' && innerPage.ids.length > 0;
          expect(page.kind === 'ids' && page.ids.length > 0).toBe(declared ? innerSome && declared.has(p) : innerSome);
        }
        const covers = await bounded.covers(s, KEYS, node);
        const innerCovers = await inner.covers(s, KEYS, node);
        const innerMissing = new Set<string>(innerCovers.covered ? [] : innerCovers.missing);
        const missing = new Set<string>(covers.covered ? [] : covers.missing);
        for (const p of KEYS) {
          if (innerMissing.has(p)) expect(missing.has(p), `seed ${seed} covers ${refOf(s)} ${p}`).toBe(true);
          if (declared && !declared.has(p)) expect(missing.has(p)).toBe(true);
        }
        const holdings = await bounded.holdings!(s, node);
        const innerHoldings = await inner.holdings!(s, node);
        for (const p of holdings.permissions) expect(innerHoldings.permissions).toContain(p);
        if (declared) {
          for (const p of [...holdings.permissions, ...holdings.granted, ...holdings.narrowed.map((n) => n.permission)]) {
            expect(declared.has(p)).toBe(true);
          }
          expect(holdings.roles).toEqual([]);
        }
      }
    }
  });

  it('hands every non-peer subject to the inner checker untouched: same arguments, same answer object', async () => {
    const inner = scripted(new Map([[`principal:${person}`, new Set(['a:read'])]]));
    const answers = new Map<string, unknown>();
    const passthrough: PermissionChecker = {
      check: async (...a) => { const r = await inner.check(...a); answers.set('check', r); return r; },
      covers: async (...a) => { const r = await inner.covers(...a); answers.set('covers', r); return r; },
      holdings: async (...a) => { const r = await inner.holdings!(...a); answers.set('holdings', r); return r; },
      grantedEntities: async (...a) => { const r = await inner.grantedEntities!(...a); answers.set('grantedEntities', r); return r; },
    };
    // Even a declaration that cannot be read leaves a person alone.
    const bounded = boundToPeerDeclarations(passthrough, () => { throw new Error('unreadable'); });
    for (const s of subjectsOf().filter((x) => x.kind !== 'vertical')) {
      inner.calls.length = 0;
      const check = { s, p: KEYS[0]!, n: node, e: NOTE };
      expect(await bounded.check(check.s, check.p, check.n, check.e)).toBe(answers.get('check'));
      expect(await bounded.covers(s, KEYS, node)).toBe(answers.get('covers'));
      expect(await bounded.holdings!(s, node)).toBe(answers.get('holdings'));
      const cb = async () => true;
      expect(await bounded.grantedEntities!(s, KEYS[0]!, node, 'note', cb, { limit: 3 })).toBe(answers.get('grantedEntities'));
      expect(inner.calls).toEqual([
        ['check', s, KEYS[0], node, NOTE],
        ['covers', s, KEYS, node],
        ['holdings', s, node],
        ['grantedEntities', s, KEYS[0], node, 'note', cb, { limit: 3 }],
      ]);
    }
  });

  it('keeps an absent optional method absent, so a caller still sees an incomplete checker', () => {
    const bare: PermissionChecker = { check: async (_s, p, n) => ({ allowed: false, checked: p, node: n }), covers: async () => ({ covered: true, missing: [] }) };
    const bounded = boundToPeerDeclarations(bare, () => new Map());
    expect(bounded.holdings).toBeUndefined();
    expect(bounded.grantedEntities).toBeUndefined();
  });

  describe('fails closed: a declaration that cannot be read gives a peer nothing', () => {
    const peer: CheckSubject = { kind: 'vertical', id: VERTICALS[0]!, scope: peerScope };
    const everything = new Map([[refOf(peer), new Set<string>(KEYS)]]);
    for (const [name, read] of [
      ['throws', () => { throw new Error('registry unreadable'); }],
      ['answers undefined', () => undefined],
    ] as const) {
      it(`when the declaration ${name}`, async () => {
        const bounded = boundToPeerDeclarations(scripted(everything), read as () => PeerDeclarations | undefined);
        for (const p of KEYS) expect(await bounded.check(peer, p, node)).toEqual({ allowed: false, checked: p, node });
        expect(await bounded.covers(peer, KEYS, node)).toEqual({ covered: false, missing: KEYS });
        expect(await bounded.holdings!(peer, node)).toEqual({ permissions: [], roles: [], granted: [], narrowed: [] });
        expect(await bounded.grantedEntities!(peer, KEYS[0]!, node, 'note', async () => true)).toEqual({ kind: 'ids', ids: [], nextCursor: null });
      });
    }
  });

  it('reads the declaration on every call, so a narrower one takes effect on the very next check', async () => {
    const peer: CheckSubject = { kind: 'vertical', id: VERTICALS[0]!, scope: peerScope };
    const WRITE = permissionKey.parse('a:write');
    let running = collectPeers([{ peers: [peerSpec.parse({ vertical: peer.id, operations: [], permissions: ['a:read', 'a:write'] })] }]);
    const bounded = boundToPeerDeclarations(scripted(new Map([[refOf(peer), new Set<string>(KEYS)]])), () => running);
    expect((await bounded.check(peer, WRITE, node)).allowed).toBe(true);
    running = collectPeers([{ peers: [peerSpec.parse({ vertical: peer.id, operations: [], permissions: ['a:read'] })] }]);
    expect((await bounded.check(peer, WRITE, node)).allowed).toBe(false);
    expect((await bounded.check(peer, permissionKey.parse('a:read'), node)).allowed).toBe(true);
    // A key declared again is held again, through the tuple the inner checker still holds.
    running = collectPeers([{ peers: [peerSpec.parse({ vertical: peer.id, operations: [], permissions: ['a:read', 'a:write'] })] }]);
    expect((await bounded.check(peer, WRITE, node)).allowed).toBe(true);
  });

  it('a covers answer keeps the order the keys were asked in', async () => {
    const peer: CheckSubject = { kind: 'vertical', id: VERTICALS[1]!, scope: peerScope };
    const peers = collectPeers([{ peers: [peerSpec.parse({ vertical: peer.id, operations: [], permissions: ['b:read'] })] }]);
    const bounded = boundToPeerDeclarations(scripted(new Map([[refOf(peer), new Set(['a:read'])]])), () => peers);
    const asked: PermissionKey[] = [KEYS[4]!, KEYS[3]!, KEYS[0]!];
    expect(await bounded.covers(peer, asked, node)).toEqual({ covered: false, missing: asked });
  });
});
