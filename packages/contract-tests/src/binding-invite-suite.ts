/**
 * Contract suite for BINDING invites (#1686) — a `become` link that also binds its claimant to
 * their own record, and the unbind beside it.
 *
 * What it pins, in one sentence: **a link minted by someone holding a binding shape's key on a
 * record, for a record that names nobody, yields its principal exactly once, and in that one
 * transaction the record's column comes to name them and they are given the record's declared
 * shape there; anything that would make that wrong — the record bound meanwhile, gone, the
 * minter no longer holding the key, the shape no longer declared, a fault inside the grant —
 * refuses the exchange and leaves the link unspent; an unbind or an erasure takes it back.**
 *
 * Every refusal is paired with the allow beside it, and checked to have written nothing:
 *
 * 1. **The mint.** Refused, writing nothing, for a type the scope's reconciled registry binds
 *    nothing on (another scope, another type), a missing record, a bound record, and a minter
 *    lacking the key — scope-wide or on THAT record. The clerk's mint records the action, on the
 *    record and on `capability.become-minted`.
 * 2. **The claim.** One exchange: the column names the claimant, the marker and the shape's keys
 *    are theirs, `entity.holder-bound` is on the record's history with the capability as actor, and
 *    they read their record and no other.
 * 3. **The claim re-judged.** The record bound meanwhile, deleted, the minter's key gone, the shape
 *    dropped from the registry: each refuses with the one answer and leaves `uses = 0` and the
 *    record as it was; putting it right lets the same link through.
 * 4. **Atomic.** A fault inside the shape grant rolls the use back with the column.
 * 5. **The keys come only from the column.** A direct grant of a binding shape's key on such a
 *    record is refused; a key outside the shape is not.
 * 6. **The unbind.** Bounded by the key on the record; it clears the column and tombstones the
 *    marker and every key of the shape, a retired one included; the record can be bound again.
 * 7. **The erasure.** Erasing the record or its person releases the binding — after the module's
 *    hook has read the rows by the column, and also when the hook deleted the row.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  CAPABILITY_BECOME_MINTED,
  ENTITY_HOLDER_BOUND,
  ENTITY_HOLDER_UNBOUND,
  dataSubjectId,
  errorCodeOf,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type BoundedBecomeMint,
  type BoundedUnbind,
  type CapabilityRecord,
  type EntityRef,
  type MintedCapability,
  type PrincipalBecomeCapabilityInput,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost } from '@substrat-run/kernel';
import { BIND_DUP_SHAPE, BIND_INVITE, BIND_MEMBER, BIND_OLD, BIND_READ_OWN, BIND_SHAPE, bindMod } from './bind-module.js';
import type { ScopeHostFixture } from './scope-host-suite.js';
import type { RawScopeQuery } from './subject-erasure-suite.js';

/** The host verbs under test — on each adapter's host class, not on `ScopeHost`. */
export interface BindingVerbs {
  mintBecomeCapabilityBounded(tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, input: PrincipalBecomeCapabilityInput): Promise<BoundedBecomeMint>;
  unbindEntityHolderBounded(tenantId: TenantId, scopeId: ScopeId, caller: PrincipalId, entity: EntityRef): Promise<BoundedUnbind>;
}

type Row = Record<string, unknown>;

export function bindingInviteContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture & { verbs: BindingVerbs }>,
  raw: RawScopeQuery,
): void {
  describe(`binding invites (#1686): ${adapterName}`, () => {
    let fixture: ScopeHostFixture & { verbs: BindingVerbs };
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const s2 = scopeId.parse(ulid()); // provisioned, never reconciled with the shape
    const staff = platformActorId.parse(ulid());
    const p = () => principalId.parse(ulid());
    const clerk = p(); // bind:invite + bind:member scope-wide
    const outsider = p(); // bind:member only
    const node = (scope: ScopeId = s1) => ({ tenantId: t1, scopeId: scope });
    const rec = (id: string): EntityRef => ({ entityType: 'brecord', entityId: id });

    const sql = async (q: string, params: (string | null)[] = [], scope: ScopeId = s1): Promise<Row[]> =>
      (await host.getScope(clerk, t1, scope)).invoke<Row[]>('bind/sql', { sql: q, params });
    const put = async (q: string, params: (string | null)[] = []) => (await host.getScope(clerk, t1, s1)).invoke('bind/put', { sql: q, params });
    const record = async (fate: string | null = null): Promise<string> => {
      const id = ulid();
      await put('INSERT INTO bind_records (id, principal, email, fate) VALUES (?, NULL, ?, ?)', [id, `${id}@example.test`, fate]);
      return id;
    };
    const rowOf = async (id: string) => (await sql('SELECT principal FROM bind_records WHERE id = ?', [id]))[0] as { principal: string | null } | undefined;
    /** Every tuple on the record: who, what, and whether it is live. */
    const tuplesOn = async (id: string) =>
      (await sql('SELECT subject, relation, revoked_at IS NULL AS live FROM _substrat_tuples WHERE object = ? ORDER BY subject, relation', [`brecord:${id}`])).map(
        (r) => ({ subject: r.subject, relation: r.relation, live: Number(r.live) === 1 }),
      );
    const outbox = async (type: string) =>
      (await sql('SELECT actor, entity_type, entity_id, payload FROM _substrat_outbox WHERE type = ? ORDER BY id', [type])).map((r) => ({
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        actor: JSON.parse(String(r.actor)) as unknown,
        payload: r.payload === null ? null : (JSON.parse(String(r.payload)) as Record<string, unknown>),
      }));
    const records = async (scope: ScopeId = s1): Promise<CapabilityRecord[]> =>
      (await host.admin.listCapabilities(staff, t1, scope, { includeRevoked: true })).entries;
    const capOf = async (id: string) => (await records()).find((r) => r.id === id);
    /** What a refusal must not have changed: the directory, the spine, and the records' tuples. */
    const snapshot = async () => ({
      caps: (await records()).length,
      events: (await sql('SELECT COUNT(*) AS n FROM _substrat_outbox'))[0]!.n,
      tuples: (await sql("SELECT COUNT(*) AS n, COUNT(revoked_at) AS dead FROM _substrat_tuples WHERE object LIKE 'brecord:%'"))[0],
    });
    /** A fresh invitee: a principal holding the member role, as an invite grants before it mints. */
    const invitee = async (scope: ScopeId = s1): Promise<PrincipalId> => {
      const who = p();
      await host.admin.assignRole(staff, { principalId: who, roleKey: 'member', node: node(scope) });
      return who;
    };
    const mint = (caller: PrincipalId, principal: PrincipalId, entity: EntityRef, scope: ScopeId = s1) =>
      fixture.verbs.mintBecomeCapabilityBounded(t1, scope, caller, { principal, maxUses: 1, label: 'binding invite', bind: { entity } });
    const minted = async (caller: PrincipalId, principal: PrincipalId, entity: EntityRef): Promise<MintedCapability> => {
      const out = await mint(caller, principal, entity);
      if (!out.ok) throw new Error(`expected a mint, refused: ${JSON.stringify(out)}`);
      return out.minted;
    };
    const exchange = (secret: string) => host.exchangeCapability(t1, s1, secret, { mode: 'become' });
    const reads = async (who: PrincipalId, id: string): Promise<boolean> => {
      try {
        await (await host.getScope(who, t1, s1)).invoke('bind/read', { id });
        return true;
      } catch (err) {
        if (errorCodeOf(err) === 'permission_denied') return false;
        throw err;
      }
    };
    const reconcile = (shapes: (typeof BIND_SHAPE)[]) => host.admin.reconcileEntityGrantShapes(staff, node(), shapes);

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(bindMod);
      await host.admin.createTenant(staff, { id: t1, slug: `bind-${t1.toLowerCase()}`, name: 'Bind' });
      await host.admin.grantEntitlement(staff, t1, 'bind');
      for (const s of [s1, s2]) {
        await host.provisionScope(staff, { tenantId: t1, scopeId: s, vertical: 'bind-vertical' });
        await host.admin.activateScope(staff, t1, s);
      }
      await host.admin.defineRole(staff, t1, { key: 'clerk', permissions: [BIND_INVITE, BIND_MEMBER], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'member', permissions: [BIND_MEMBER], source: 'vertical' });
      for (const s of [s1, s2]) await host.admin.assignRole(staff, { principalId: clerk, roleKey: 'clerk', node: node(s) });
      await host.admin.assignRole(staff, { principalId: outsider, roleKey: 'member', node: node() });
      await reconcile([BIND_SHAPE]);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    describe('the mint', () => {
      it('is refused, writing nothing, where the reconciled registry binds nothing — another scope, another type', async () => {
        const id = await record();
        const before = await snapshot();
        expect(await mint(clerk, await invitee(s2), rec(id), s2)).toEqual({ ok: false, refused: 'bind-not-declared' });
        expect(await mint(clerk, await invitee(), { entityType: 'other', entityId: id })).toEqual({ ok: false, refused: 'bind-not-declared' });
        expect(await snapshot()).toEqual(before);
      });

      it('is refused for a record that does not exist, or already names someone', async () => {
        const bound = await record();
        await put('UPDATE bind_records SET principal = ? WHERE id = ?', [p(), bound]);
        const before = await snapshot();
        expect(await mint(clerk, await invitee(), rec(ulid()))).toEqual({ ok: false, refused: 'bind-record-missing' });
        expect(await mint(clerk, await invitee(), rec(bound))).toEqual({ ok: false, refused: 'bind-record-bound' });
        expect(await snapshot()).toEqual(before);
      });

      it('is refused for a minter without the key, naming it — and the clerk, who holds it, mints', async () => {
        const id = await record();
        const target = await invitee();
        const before = await snapshot();
        expect(await mint(outsider, target, rec(id))).toEqual({ ok: false, coverage: { covered: false, missing: [BIND_INVITE] } });
        expect(await snapshot()).toEqual(before);
        const link = await minted(clerk, target, rec(id));
        expect(await capOf(link.id)).toMatchObject({ mode: 'become', principal: target, action: { kind: 'bind', entity: rec(id) }, uses: 0 });
        const event = (await outbox(CAPABILITY_BECOME_MINTED)).find((e) => e.payload?.capabilityId === link.id);
        expect(event?.payload).toMatchObject({ principal: target, mintedBy: clerk, action: { kind: 'bind', entity: rec(id) } });
      });

      it('the key held on ONE record binds that record and no other', async () => {
        const mine = await record();
        const theirs = await record();
        const narrow = p();
        await host.admin.assignRole(staff, { principalId: narrow, roleKey: 'member', node: node() });
        await host.admin.grant(staff, { principalId: narrow, permission: BIND_INVITE, node: node(), entity: rec(mine), grantedBy: clerk });
        expect((await mint(narrow, await invitee(), rec(mine))).ok).toBe(true);
        expect(await mint(narrow, await invitee(), rec(theirs))).toEqual({ ok: false, coverage: { covered: false, missing: [BIND_INVITE] } });
      });
    });

    describe('the claim', () => {
      it('binds the claimant to the record and gives them its shape, in one exchange', async () => {
        const id = await record();
        const other = await record();
        const target = await invitee();
        const link = await minted(clerk, target, rec(id));
        expect(await reads(target, id)).toBe(false);
        expect(await exchange(link.secret)).toEqual({ kind: 'principal', capabilityId: link.id, principal: target, bound: rec(id) });
        expect((await rowOf(id))?.principal).toBe(target);
        expect(await tuplesOn(id)).toEqual([
          { subject: `principal:${target}`, relation: 'bootstrap', live: true },
          { subject: `principal:${target}`, relation: `granted:${BIND_READ_OWN}`, live: true },
        ]);
        expect((await capOf(link.id))?.uses).toBe(1);
        const bound = (await outbox(ENTITY_HOLDER_BOUND)).filter((e) => e.entity_id === id);
        expect(bound).toEqual([
          {
            actor: { capability: link.id },
            entity_type: 'brecord',
            entity_id: id,
            payload: { entity: rec(id), principal: target, capabilityId: link.id, mintedBy: clerk, granted: [BIND_READ_OWN] },
          },
        ]);
        expect(await reads(target, id)).toBe(true);
        expect(await reads(target, other)).toBe(false);
        // Spent: the second exchange is refused and binds nothing more.
        expect(await exchange(link.secret)).toBeNull();
      });

      /** A minted link whose claim the next step makes wrong; `undo` puts it right again. */
      const refusedThenAllowed = async (
        spoil: (ctx: { id: string; minter: PrincipalId }) => Promise<unknown>,
        undo: (ctx: { id: string; minter: PrincipalId }) => Promise<unknown>,
      ) => {
        const id = await record();
        const minter = p();
        await host.admin.assignRole(staff, { principalId: minter, roleKey: 'clerk', node: node() });
        const target = await invitee();
        const link = await minted(minter, target, rec(id));
        await spoil({ id, minter });
        const before = await snapshot();
        const was = await rowOf(id);
        expect(await exchange(link.secret)).toBeNull();
        expect((await capOf(link.id))?.uses).toBe(0);
        expect(await rowOf(id)).toEqual(was);
        expect(await snapshot()).toEqual(before);
        await undo({ id, minter });
        expect((await exchange(link.secret))?.kind).toBe('principal');
        expect((await rowOf(id))?.principal).toBe(target);
      };

      it('is refused, unspent, when the record was bound meanwhile — and goes through once it is free', () =>
        refusedThenAllowed(
          ({ id }) => put('UPDATE bind_records SET principal = ? WHERE id = ?', [p(), id]),
          ({ id }) => put('UPDATE bind_records SET principal = NULL WHERE id = ?', [id]),
        ));

      it('is refused, unspent, when the record is gone — and goes through once it is back', () =>
        refusedThenAllowed(
          ({ id }) => put('DELETE FROM bind_records WHERE id = ?', [id]),
          ({ id }) => put('INSERT INTO bind_records (id, principal, email, fate) VALUES (?, NULL, NULL, NULL)', [id]),
        ));

      it('is refused, unspent, when its minter has lost the key (or left) — and goes through once they hold it again', () =>
        refusedThenAllowed(
          ({ minter }) => host.admin.unassignRole(staff, { principalId: minter, roleKey: 'clerk', node: node() }),
          ({ minter }) => host.admin.assignRole(staff, { principalId: minter, roleKey: 'clerk', node: node() }),
        ));

      it('is refused, unspent, when the registry keeps the shape but no longer binds with it — and goes through once it does', () =>
        refusedThenAllowed(
          () => reconcile([{ ...BIND_SHAPE, bind: undefined }]),
          () => reconcile([BIND_SHAPE]),
        ));

      it('is refused, unspent, when the registry declares no shape at all — and goes through once it does', () =>
        refusedThenAllowed(
          () => reconcile([]),
          () => reconcile([BIND_SHAPE]),
        ));

      it('is atomic: a fault inside the shape grant rolls the use back with the column', async () => {
        const id = await record();
        const target = await invitee();
        const link = await minted(clerk, target, rec(id));
        await raw(t1, s1, `CREATE TRIGGER bind_fault BEFORE INSERT ON _substrat_tuples WHEN NEW.object = 'brecord:${id}' BEGIN SELECT RAISE(ABORT, 'bind fault'); END`);
        try {
          const before = await snapshot();
          await expect(() => exchange(link.secret)).rejects.toThrow();
          expect((await capOf(link.id))?.uses).toBe(0);
          expect((await rowOf(id))?.principal).toBeNull();
          expect(await snapshot()).toEqual(before);
        } finally {
          await raw(t1, s1, 'DROP TRIGGER bind_fault');
        }
        // The twin: with the fault gone the same link binds.
        expect((await exchange(link.secret))?.kind).toBe('principal');
        expect((await rowOf(id))?.principal).toBe(target);
      });
    });

    describe('an id column two rows share', () => {
      const dup = (key: string): EntityRef => ({ entityType: 'bdup', entityId: key });
      const rowsOf = async (key: string) => (await sql('SELECT holder FROM bind_dups WHERE key = ? ORDER BY holder', [key])).map((r) => r.holder);
      beforeAll(() => reconcile([BIND_SHAPE, BIND_DUP_SHAPE]));
      afterAll(() => reconcile([BIND_SHAPE]));

      it('a record any of whose rows names someone is bound: refused at mint', async () => {
        const key = ulid();
        await put('INSERT INTO bind_dups (key, holder) VALUES (?, NULL), (?, ?)', [key, key, p()]);
        expect(await mint(clerk, await invitee(), dup(key))).toEqual({ ok: false, refused: 'bind-record-bound' });
      });

      it('two rows naming nobody are no one record: the claim refuses and rolls back, leaving the link unspent', async () => {
        const key = ulid();
        await put('INSERT INTO bind_dups (key, holder) VALUES (?, NULL), (?, NULL)', [key, key]);
        const link = await minted(clerk, await invitee(), dup(key));
        await expect(() => exchange(link.secret)).rejects.toThrow();
        expect((await capOf(link.id))?.uses).toBe(0);
        expect(await rowsOf(key)).toEqual([null, null]);
      });

      it('an unbind clears every row carrying the id', async () => {
        const key = ulid();
        await put('INSERT INTO bind_dups (key, holder) VALUES (?, ?), (?, ?)', [key, p(), key, p()]);
        expect(await fixture.verbs.unbindEntityHolderBounded(t1, s1, clerk, dup(key))).toEqual({ ok: true, unbound: [] });
        expect(await rowsOf(key)).toEqual([null, null]);
      });
    });

    describe('the keys come only from the column', () => {
      it("refuses a direct grant of a binding shape's key on such a record — current or retired — and allows any other key", async () => {
        const id = await record();
        const who = await invitee();
        for (const permission of [BIND_READ_OWN, BIND_OLD]) {
          await expect(() => host.admin.grant(staff, { principalId: who, permission, node: node(), entity: rec(id), grantedBy: clerk })).rejects.toThrow(
            /given only by the shape grant/,
          );
        }
        await host.admin.grant(staff, { principalId: who, permission: BIND_INVITE, node: node(), entity: rec(id), grantedBy: clerk });
        expect(await tuplesOn(id)).toEqual([{ subject: `principal:${who}`, relation: `granted:${BIND_INVITE}`, live: true }]);
      });
    });

    describe('the unbind', () => {
      const claimed = async () => {
        const id = await record();
        const target = await invitee();
        const link = await minted(clerk, target, rec(id));
        await exchange(link.secret);
        return { id, target };
      };

      it('is refused, writing nothing, for a caller without the key on the record', async () => {
        const { id, target } = await claimed();
        const before = await snapshot();
        expect(await fixture.verbs.unbindEntityHolderBounded(t1, s1, outsider, rec(id))).toEqual({
          ok: false,
          coverage: { covered: false, missing: [BIND_INVITE] },
        });
        expect(await snapshot()).toEqual(before);
        expect((await rowOf(id))?.principal).toBe(target);
        expect(await reads(target, id)).toBe(true);
      });

      it('clears the column and takes back the marker and every key of the shape, a retired one included', async () => {
        const { id, target } = await claimed();
        // A retired key left from before the shape dropped it — only the kernel's own writes can put it here now.
        await raw(t1, s1, 'INSERT INTO _substrat_tuples (subject, relation, object) VALUES (?, ?, ?)', [`principal:${target}`, `granted:${BIND_OLD}`, `brecord:${id}`]);
        expect(await fixture.verbs.unbindEntityHolderBounded(t1, s1, clerk, rec(id))).toEqual({ ok: true, unbound: [target] });
        expect((await rowOf(id))?.principal).toBeNull();
        expect(await tuplesOn(id)).toEqual([
          { subject: `principal:${target}`, relation: 'bootstrap', live: false },
          { subject: `principal:${target}`, relation: `granted:${BIND_OLD}`, live: false },
          { subject: `principal:${target}`, relation: `granted:${BIND_READ_OWN}`, live: false },
        ]);
        expect(await reads(target, id)).toBe(false);
        const unbound = (await outbox(ENTITY_HOLDER_UNBOUND)).filter((e) => e.entity_id === id);
        expect(unbound).toEqual([
          { actor: clerk, entity_type: 'brecord', entity_id: id, payload: { entity: rec(id), principal: target, removed: [BIND_OLD, BIND_READ_OWN] } },
        ]);
        // Nothing left to unbind: an answer, and nothing written.
        const before = await snapshot();
        expect(await fixture.verbs.unbindEntityHolderBounded(t1, s1, clerk, rec(id))).toEqual({ ok: true, unbound: [] });
        expect(await snapshot()).toEqual(before);
        // The record is free again: a new invite binds a new person.
        const next = await invitee();
        expect((await exchange((await minted(clerk, next, rec(id))).secret))?.kind).toBe('principal');
        expect(await reads(next, id)).toBe(true);
        expect(await reads(target, id)).toBe(false);
      });

      it('releases from the spine: the person a link bound, though module code has since rewritten the column', async () => {
        const { id, target } = await claimed();
        const other = p();
        await put('UPDATE bind_records SET principal = ? WHERE id = ?', [other, id]);
        // `other` holds no marker here — the column alone is no holding — so only the bound person is released.
        expect(await fixture.verbs.unbindEntityHolderBounded(t1, s1, clerk, rec(id))).toEqual({ ok: true, unbound: [target] });
        expect((await rowOf(id))?.principal).toBeNull();
        expect(await reads(target, id)).toBe(false);
        expect((await tuplesOn(id)).filter((t) => t.live)).toEqual([]);
      });

      it('takes back a key the shape has since dropped without retiring it — everything the holder holds on the record', async () => {
        const kept = { ...BIND_SHAPE, permissions: [BIND_OLD, BIND_READ_OWN], retired: undefined };
        await reconcile([kept]);
        try {
          const { id, target } = await claimed();
          await reconcile([{ ...BIND_SHAPE, retired: undefined }]);
          expect((await tuplesOn(id)).filter((t) => t.live).map((t) => t.relation)).toEqual(['bootstrap', `granted:${BIND_OLD}`, `granted:${BIND_READ_OWN}`]);
          expect(await fixture.verbs.unbindEntityHolderBounded(t1, s1, clerk, rec(id))).toEqual({ ok: true, unbound: [target] });
          expect((await tuplesOn(id)).filter((t) => t.live)).toEqual([]);
          const event = (await outbox(ENTITY_HOLDER_UNBOUND)).find((e) => e.entity_id === id);
          expect(event?.payload).toMatchObject({ removed: [BIND_OLD, BIND_READ_OWN] });
        } finally {
          await reconcile([BIND_SHAPE]);
        }
      });

      it('answers bind-not-declared for a type the registry binds nothing on', async () => {
        expect(await fixture.verbs.unbindEntityHolderBounded(t1, s1, clerk, { entityType: 'other', entityId: ulid() })).toEqual({
          ok: false,
          refused: 'bind-not-declared',
        });
      });
    });

    describe('the erasure', () => {
      const claimed = async (fate: string | null = null) => {
        const id = await record(fate);
        const target = await invitee();
        await exchange((await minted(clerk, target, rec(id))).secret);
        return { id, target };
      };
      const live = async (id: string) => (await tuplesOn(id)).filter((t) => t.live);

      it("erasing the RECORD releases its person: column cleared, shape taken back; another record's binding stays", async () => {
        const { id, target } = await claimed();
        const bystander = await claimed();
        await host.admin.shredSubject(staff, t1, s1, dataSubjectId.parse(id));
        expect((await rowOf(id))?.principal).toBeNull();
        expect(await live(id)).toEqual([]);
        expect(await reads(target, id)).toBe(false);
        expect((await rowOf(bystander.id))?.principal).toBe(bystander.target);
        expect(await reads(bystander.target, bystander.id)).toBe(true);
      });

      it('erasing the PERSON releases them — after the hook has found their record by the column', async () => {
        const { id, target } = await claimed();
        await host.admin.shredSubject(staff, t1, s1, dataSubjectId.parse(target));
        expect(await sql('SELECT record_id FROM bind_seen WHERE subject = ?', [target])).toEqual([{ record_id: id }]);
        expect((await rowOf(id))?.principal).toBeNull();
        expect(await live(id)).toEqual([]);
      });

      it('a version that drops `bind` but keeps the shape: nobody may mint or unbind, and an erasure still releases', async () => {
        const { id, target } = await claimed();
        await reconcile([{ ...BIND_SHAPE, bind: undefined }]);
        try {
          expect(await mint(clerk, await invitee(), rec(await record()))).toEqual({ ok: false, refused: 'bind-not-declared' });
          expect(await fixture.verbs.unbindEntityHolderBounded(t1, s1, clerk, rec(id))).toEqual({ ok: false, refused: 'bind-not-declared' });
          // What was bound stays bound, as a shape holder does when a key is dropped without being retired…
          expect(await reads(target, id)).toBe(true);
          // …and the column still decides: a direct grant of the shape's key is still refused.
          await expect(() =>
            host.admin.grant(staff, { principalId: p(), permission: BIND_READ_OWN, node: node(), entity: rec(id), grantedBy: clerk }),
          ).rejects.toThrow(/given only by the shape grant/);
          await host.admin.shredSubject(staff, t1, s1, dataSubjectId.parse(target));
          expect((await rowOf(id))?.principal).toBeNull();
          expect(await live(id)).toEqual([]);
        } finally {
          await reconcile([BIND_SHAPE]);
        }
      });

      it('a version that drops the shape drops its facts with it: an erasure then releases nothing, as for any dropped shape', async () => {
        const { id, target } = await claimed();
        await reconcile([]);
        try {
          await host.admin.shredSubject(staff, t1, s1, dataSubjectId.parse(target));
          expect((await rowOf(id))?.principal).toBe(target);
          expect((await live(id)).map((t) => t.relation)).toEqual(['bootstrap', `granted:${BIND_READ_OWN}`]);
        } finally {
          await reconcile([BIND_SHAPE]);
        }
      });

      it('releases a record the hook deleted, from what was read before it ran', async () => {
        const { id, target } = await claimed('drop');
        await host.admin.shredSubject(staff, t1, s1, dataSubjectId.parse(target));
        expect(await rowOf(id)).toBeUndefined();
        expect(await live(id)).toEqual([]);
        expect(await tuplesOn(id)).toEqual([
          { subject: `principal:${target}`, relation: 'bootstrap', live: false },
          { subject: `principal:${target}`, relation: `granted:${BIND_READ_OWN}`, live: false },
        ]);
      });
    });
  });
}
