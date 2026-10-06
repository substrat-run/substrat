/**
 * Contract suite for the trash, held by the host (#119 PR 2): the refusal of an operation on a
 * trashed entity it did not declare it reaches, `ctx.link`/`ctx.relink` refusing a trashed
 * parent, and the purge horizon's sweep.
 *
 * The DEFAULT tuple checker on purpose: the order of the refusal — the declared key before the
 * bin is revealed — is a permission property, and an allow-all checker would pass a refusal that
 * leaked the bin to anyone.
 *
 * Every refusal has its positive twin beside it, so a case cannot pass by a host that refuses
 * everything. Purge cases each run on a FRESH scope: a pass writes the schedule's cadence row,
 * and a later case on the same scope would only see its own work skipped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type HistoryEntry,
  type PrincipalId,
  type ScopeId,
} from '@substrat-run/contracts';
import { PURGE_BATCH, runPlatformSweep, ulid, type FetchLike, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import type { RawScopeSql } from './entity-state-suite.js';
import { EXPLODING_BOX, TBOX_PURGE_DAYS, TRASH_MODULE_ID, trashMod } from './entity-trash-module.js';

const KEYS = ['box:read', 'box:write', 'box:archive', 'box:trash', 'box:delete'].map((k) => permissionKey.parse(k));
const READ = permissionKey.parse('box:read');
const MODULE = moduleId.parse(TRASH_MODULE_ID);
const DAY = 86_400_000;
const noFetch: FetchLike = async () => {
  throw new Error('no outbound fetch in this suite');
};

export function entityTrashContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
  raw: RawScopeSql,
  options: {
    /**
     * Whether a whole `runPlatformSweep` is affordable on this fixture. It walks every active
     * scope its directory holds, so on a directory SHARED by every suite in the file (the
     * Cloudflare fixture's control plane) one pass takes minutes and starves the suites after
     * it. The property it holds — a copy that is not primary never runs a schedule, the purge's
     * included — is the kernel sweep's `isPrimaryScope` filter, the same code on both adapters.
     */
    platformSweep?: boolean;
  } = {},
): void {
  describe(`the trash, held by the host (#119 PR 2): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t = tenantId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    /** Every key, tenant-wide. */
    const alice: PrincipalId = principalId.parse(ulid());
    /** Read only — holds no write key anywhere, so every write on a box is `forbidden` to her. */
    const dave: PrincipalId = principalId.parse(ulid());
    let scope: ScopeId;
    let as: Record<'alice' | 'dave', ScopeStub>;

    const errOf = async (call: Promise<unknown>): Promise<unknown> =>
      call.then(
        () => {
          throw new Error('expected a refusal, got an answer');
        },
        (e: unknown) => e,
      );

    /** A new primary scope — the schedule's cadence row starts empty, and the system grant is seated. */
    const freshScope = async (extra: Record<string, unknown> = {}): Promise<ScopeId> => {
      const s = scopeId.parse(ulid());
      await host.provisionScope(staff, { tenantId: t, scopeId: s, ...extra });
      await host.admin.activateScope(staff, t, s);
      return s;
    };
    const stub = (who: PrincipalId, s: ScopeId = scope) => host.getScope(who, t, s);
    const addBox = async (s: ScopeId = scope, name = `box ${ulid()}`): Promise<string> => {
      const id = ulid();
      await (await stub(alice, s)).invoke('trash/add-box', { id, name });
      return id;
    };
    const binnedBox = async (s: ScopeId = scope, name?: string): Promise<string> => {
      const id = await addBox(s, name);
      await (await stub(alice, s)).invoke('trash/trash-box', { boxId: id });
      return id;
    };
    /**
     * Move a binned row's trash instant into the past, past the guard and the trigger — the way
     * a row that has sat in the bin for days looks. The kernel's own authorization row is what
     * the trigger asks for, written and removed around the one UPDATE exactly as a move does.
     */
    const backdate = async (s: ScopeId, table: string, type: string, id: string, days: number) => {
      const at = new Date(Date.now() - days * DAY - 60_000).toISOString();
      await raw(t, s, `INSERT INTO _substrat_state_moves (entity_type, entity_id) VALUES (?, ?)`, [type, id]);
      await raw(t, s, `UPDATE ${table} SET _substrat_trashed_at = ? WHERE id = ?`, [at, id]);
      await raw(t, s, `DELETE FROM _substrat_state_moves WHERE entity_type = ? AND entity_id = ?`, [type, id]);
    };
    const dueBox = async (s: ScopeId, name?: string) => {
      const id = await binnedBox(s, name);
      await backdate(s, 'trash_boxes', 'tbox', id, TBOX_PURGE_DAYS + 1);
      return id;
    };
    const exists = async (s: ScopeId, boxId: string) =>
      ((await (await stub(alice, s)).invoke('trash/box-exists', { boxId })) as { exists: boolean }).exists;
    const sweep = (s: ScopeId) => host.runDueSchedules(MODULE, t, s);

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(trashMod);
      await host.admin.createTenant(staff, { id: t, slug: `trash-${t.slice(-10).toLowerCase()}`, name: 'Trash' });
      await host.admin.grantEntitlement(staff, t, 'trash');
      await host.admin.defineRole(staff, t, { key: 'boxer', permissions: KEYS, source: 'vertical' });
      await host.admin.defineRole(staff, t, { key: 'looker', permissions: [READ], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'boxer', node: { tenantId: t, scopeId: null } });
      await host.admin.assignRole(staff, { principalId: dave, roleKey: 'looker', node: { tenantId: t, scopeId: null } });
      scope = await freshScope();
      as = { alice: await stub(alice), dave: await stub(dave) };
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    // -- the refusal ---------------------------------------------------------------------

    describe('an operation that does not declare `trashed`', () => {
      it('is refused not_found on a trashed entity, to a caller who holds its key', async () => {
        const id = await binnedBox();
        const e = await errOf(as.alice.invoke('trash/rename-box', { boxId: id, name: 'x' }));
        expect(errorCodeOf(e)).toBe('not_found');
      });

      it('twin: runs on an active entity, and on an ARCHIVED one — archive is not a delete', async () => {
        const id = await addBox();
        await as.alice.invoke('trash/rename-box', { boxId: id, name: 'renamed' });
        await as.alice.invoke('trash/archive-box', { boxId: id });
        await expect(as.alice.invoke('trash/rename-box', { boxId: id, name: 'again' })).resolves.toEqual({ ok: true });
      });

      it('gives a caller WITHOUT the key the same refusal on a trashed entity as on an active or missing one', async () => {
        const active = await addBox();
        const trashed = await binnedBox();
        const refusal = async (boxId: string) => {
          const e = (await errOf(as.dave.invoke('trash/rename-box', { boxId, name: 'x' }))) as Error & { permission?: unknown };
          return { code: errorCodeOf(e), name: e.name, message: e.message, permission: e.permission };
        };
        const onActive = await refusal(active);
        expect(onActive.code).toBe('permission_denied');
        // Status, body and the key named: identical, so the bin is not something to probe.
        expect(await refusal(trashed)).toEqual(onActive);
        expect(await refusal(ulid())).toEqual(onActive);
      });

      it('is refused whoever calls — the refusal is the host\'s, not the handler\'s', async () => {
        // The system principal holds no `box:write`; it meets the same declared check first.
        const id = await binnedBox();
        const system = await host.getSystemScope(MODULE, t, scope);
        expect(errorCodeOf(await errOf(system.invoke('trash/rename-box', { boxId: id, name: 'x' })))).toBe('permission_denied');
      });

      it('and the state is untouched by the refused call', async () => {
        const id = await binnedBox();
        await errOf(as.alice.invoke('trash/rename-box', { boxId: id, name: 'changed' }));
        expect(await as.alice.invoke('trash/peek-box', { boxId: id })).toEqual({ state: 'trashed' });
      });
    });

    describe("`trashed: 'admits'` and `'purges'`", () => {
      it("'admits' reaches a trashed entity: the restore, and a read of the bin", async () => {
        const id = await binnedBox();
        expect(await as.alice.invoke('trash/peek-box', { boxId: id })).toEqual({ state: 'trashed' });
        await as.alice.invoke('trash/restore-box', { boxId: id });
        expect(await as.alice.invoke('trash/peek-box', { boxId: id })).toEqual({ state: 'active' });
      });

      it("'admits' still checks its key — the opt-in is not an exemption from the permission", async () => {
        const id = await binnedBox();
        expect(errorCodeOf(await errOf(as.dave.invoke('trash/restore-box', { boxId: id })))).toBe('permission_denied');
      });

      it("'purges' is the permanent delete — a person may empty the bin with it", async () => {
        const id = await binnedBox();
        await as.alice.invoke('trash/delete-box', { boxId: id });
        expect(await exists(scope, id)).toBe(false);
      });
    });

    it('does not reach an operation whose check is resolved in the handler — the stated gap', async () => {
      const boxId = await addBox();
      const thingId = ulid();
      await as.alice.invoke('trash/link-thing', { boxId, thingId });
      await as.alice.invoke('trash/trash-box', { boxId });
      // The host cannot see which box `touch-thing` reaches; the handler would have to ask.
      await expect(as.alice.invoke('trash/touch-thing', { thingId })).resolves.toEqual({ ok: true });
    });

    // -- ctx.link and ctx.relink -----------------------------------------------------------

    describe('ctx.link and ctx.relink', () => {
      it('link refuses a trashed parent not_found, and writes nothing', async () => {
        const boxId = await binnedBox();
        const thingId = ulid();
        const e = await errOf(as.alice.invoke('trash/link-thing', { boxId, thingId }));
        expect(errorCodeOf(e)).toBe('not_found');
        await as.alice.invoke('trash/restore-box', { boxId });
        expect(((await as.alice.invoke('trash/box-exists', { boxId })) as { things: number }).things).toBe(0);
      });

      it('a trashed parent and a missing one are refused identically — the trash cannot be probed through link', async () => {
        const trashed = await binnedBox();
        const missing = ulid();
        const refusal = async (who: ScopeStub, boxId: string) => {
          const e = (await errOf(who.invoke('trash/link-thing', { boxId, thingId: ulid() }))) as Error;
          // Everything but the id the caller named itself.
          return { code: errorCodeOf(e), name: e.name, message: e.message.replace(boxId, '<id>') };
        };
        // A caller who may write the box learns only "not found", whichever it was.
        expect(await refusal(as.alice, trashed)).toEqual(await refusal(as.alice, missing));
        expect((await refusal(as.alice, trashed)).code).toBe('not_found');
        // A caller without access to the parent is stopped before link, the same way for both.
        expect(await refusal(as.dave, trashed)).toEqual(await refusal(as.dave, missing));
        expect((await refusal(as.dave, trashed)).code).toBe('permission_denied');
      });

      it('twin: link accepts an active parent and an ARCHIVED one', async () => {
        const active = await addBox();
        await expect(as.alice.invoke('trash/link-thing', { boxId: active, thingId: ulid() })).resolves.toEqual({ ok: true });
        const archived = await addBox();
        await as.alice.invoke('trash/archive-box', { boxId: archived });
        await expect(as.alice.invoke('trash/link-thing', { boxId: archived, thingId: ulid() })).resolves.toEqual({ ok: true });
      });

      it('relink refuses a trashed `to`, and lets a child be moved OUT from under a trashed `from`', async () => {
        const from = await addBox();
        const thingId = ulid();
        await as.alice.invoke('trash/link-thing', { boxId: from, thingId });
        const binned = await binnedBox();
        const e = await errOf(as.alice.invoke('trash/move-thing', { boxId: binned, thingId, fromBoxId: from }));
        expect(errorCodeOf(e)).toBe('not_found');
        // The rescue: the parent goes in the bin, the child is moved to a live one.
        await as.alice.invoke('trash/trash-box', { boxId: from });
        const to = await addBox();
        await expect(as.alice.invoke('trash/move-thing', { boxId: to, thingId, fromBoxId: from })).resolves.toEqual({ ok: true });
      });
    });

    // -- the purge horizon -----------------------------------------------------------------

    describe('the purge horizon', () => {
      it('purges what has been in the bin past the horizon, and nothing else', async () => {
        const s = await freshScope();
        const due = await dueBox(s);
        const recent = await binnedBox(s);
        const active = await addBox(s);
        const archived = await addBox(s);
        await (await stub(alice, s)).invoke('trash/archive-box', { boxId: archived });
        // A trashable entity with no horizon: in the bin for a year, and kept.
        const keep = ulid();
        await (await stub(alice, s)).invoke('trash/add-keep', { id: keep });
        await (await stub(alice, s)).invoke('trash/trash-keep', { keepId: keep });
        await backdate(s, 'trash_keeps', 'tkeep', keep, 365);

        const report = await sweep(s);
        expect(report).toMatchObject({ fired: 1, failed: 0, errors: [] });
        expect(await exists(s, due)).toBe(false);
        expect(await exists(s, recent)).toBe(true);
        expect(await exists(s, active)).toBe(true);
        expect(await exists(s, archived)).toBe(true);
        expect(await (await stub(alice, s)).invoke('trash/peek-box', { boxId: recent })).toEqual({ state: 'trashed' });
      });

      it("runs the vertical's own delete as the module's system principal, and every event stays", async () => {
        const s = await freshScope();
        const id = await dueBox(s);
        await sweep(s);
        const { entries } = (await (await stub(alice, s)).invoke('trash/history', { boxId: id })) as { entries: HistoryEntry[] };
        expect(entries.map((e) => e.type)).toEqual(expect.arrayContaining(['entity.trashed', 'trashbox.deleted']));
        const deleted = entries.find((e) => e.type === 'trashbox.deleted')!;
        expect(deleted.actor).toEqual({ system: TRASH_MODULE_ID });
        expect(deleted.operation).toBe('trash/delete-box');
        // K-34: the seated system grant is what authorized it, recorded on the event.
        expect(deleted.authorization?.map((a) => a.permission)).toEqual(['box:delete']);
      });

      it('a purge that fails rolls back alone: the rest commit, it stays in the bin, the pass reports it', async () => {
        const s = await freshScope();
        const a = await dueBox(s);
        const boom = await dueBox(s, EXPLODING_BOX);
        const b = await dueBox(s);
        const report = await sweep(s);
        expect(report.failed).toBe(1);
        expect(report.errors).toEqual([expect.objectContaining({ operation: `trash/delete-box (tbox:${boom})` })]);
        expect(await exists(s, a)).toBe(false);
        expect(await exists(s, b)).toBe(false);
        // Its delete ran and threw: the transaction took the delete back with it.
        expect(await exists(s, boom)).toBe(true);
        expect(await (await stub(alice, s)).invoke('trash/peek-box', { boxId: boom })).toEqual({ state: 'trashed' });
      });

      it('a restored entity is not purged, and the next pass leaves it alone', async () => {
        const s = await freshScope();
        const restored = await dueBox(s);
        await (await stub(alice, s)).invoke('trash/restore-box', { boxId: restored });
        await sweep(s);
        expect(await exists(s, restored)).toBe(true);
        expect(await (await stub(alice, s)).invoke('trash/peek-box', { boxId: restored })).toEqual({ state: 'active' });
      });

      it('purge authority is never a caller\'s option: an invoke naming a cutoff is refused on every door', async () => {
        const s = await freshScope();
        const system = await host.getSystemScope(MODULE, t, s);
        // A box binned a moment ago: a cutoff in the future would make it "due" if one were honoured.
        const recent = await binnedBox(s);
        const future = new Date(Date.now() + 365 * DAY).toISOString();
        for (const [who, call] of [
          ['the system principal', system.invoke('trash/delete-box', { boxId: recent }, { purgeCutoff: future } as never)],
          ['a person holding the key', (await stub(alice, s)).invoke('trash/other-delete', { boxId: recent }, { purgeCutoff: future } as never)],
        ] as const) {
          expect(errorCodeOf(await errOf(call)), who).toBe('validation_failed');
        }
        // Outside the sweep the system principal holds no purge authority at all, cutoff or not.
        expect(errorCodeOf(await errOf(system.invoke('trash/delete-box', { boxId: recent })))).toBe('permission_denied');
        expect(await exists(s, recent)).toBe(true);
        // Twin: the sweep — the one path that may purge — leaves it too, because it is not due.
        await sweep(s);
        expect(await exists(s, recent)).toBe(true);
      });

      it('the purge grant runs ONLY the purge: the system principal cannot use its key anywhere else', async () => {
        const s = await freshScope();
        const system = await host.getSystemScope(MODULE, t, s);
        const active = await addBox(s);
        const due = await dueBox(s);
        // Another operation checking the same key, and the purge operation called outside a purge.
        expect(errorCodeOf(await errOf(system.invoke('trash/other-delete', { boxId: active })))).toBe('permission_denied');
        expect(errorCodeOf(await errOf(system.invoke('trash/delete-box', { boxId: due })))).toBe('permission_denied');
        expect(await exists(s, due)).toBe(true);
        // Twin: a person holding the key runs both; the sweep purges.
        await expect((await stub(alice, s)).invoke('trash/other-delete', { boxId: active })).resolves.toEqual({ ok: true });
        await sweep(s);
        expect(await exists(s, due)).toBe(false);
      });

      it('a full batch leaves the schedule due; the next pass finishes the bin, and then it waits its cadence', async () => {
        const s = await freshScope();
        // One call bins the whole batch and one set-based backdate makes it due, so the case
        // spends its time on the sweep it asserts rather than on setting it up.
        const prefix = ulid().slice(0, 20);
        const { ids: boxes } = (await (await stub(alice, s)).invoke('trash/bin-many', { prefix, count: PURGE_BATCH + 1 })) as {
          ids: string[];
        };
        const at = new Date(Date.now() - (TBOX_PURGE_DAYS + 1) * DAY).toISOString();
        const mine = `id >= '${prefix}' AND id < '${prefix}~'`;
        await raw(t, s, `INSERT INTO _substrat_state_moves (entity_type, entity_id) SELECT 'tbox', id FROM trash_boxes WHERE ${mine}`);
        await raw(t, s, `UPDATE trash_boxes SET _substrat_trashed_at = ? WHERE ${mine}`, [at]);
        await raw(t, s, `DELETE FROM _substrat_state_moves WHERE entity_type = 'tbox'`);
        const left = async () => (await Promise.all(boxes.map((b) => exists(s, b)))).filter(Boolean).length;
        expect((await sweep(s)).fired).toBe(1);
        expect(await left()).toBe(1);
        await sweep(s);
        expect(await left()).toBe(0);
        // Not full this time, so the cadence row was written: a third pass is inside its window.
        const late = await dueBox(s);
        expect(await sweep(s)).toMatchObject({ fired: 0, skipped: 1 });
        expect(await exists(s, late)).toBe(true);
      }, 60_000);

      it('a scope with the module switched off purges nothing, and purges once it is restored', async () => {
        const s = await freshScope();
        const id = await dueBox(s);
        await host.admin.revokeFromSystem(staff, { moduleId: MODULE, node: { tenantId: t, scopeId: s }, reason: 'legal hold' });
        expect(await sweep(s)).toMatchObject({ fired: 0, switchedOff: true });
        expect(await exists(s, id)).toBe(true);
        await host.admin.restoreToSystem(staff, { moduleId: MODULE, node: { tenantId: t, scopeId: s }, reason: 'released' });
        await sweep(s);
        expect(await exists(s, id)).toBe(false);
      });

      it('an export and import keeps the purge index: runtime DDL in the copy finds the bin intact, and the copy purges', async () => {
        const s = await freshScope();
        await dueBox(s);
        const copy = scopeId.parse(ulid());
        await host.importScope(staff, { tenantId: t, scopeId: copy }, await host.admin.exportScope(staff, t, s));
        await host.admin.activateScope(staff, t, copy);
        const there = await stub(alice, copy);
        // The kernel's post-DDL check requires every derived object, the purge index among them.
        await expect(there.invoke('trash/ddl', { table: `rt_${ulid().toLowerCase()}` })).resolves.toEqual({ ok: true });
      });

      it.runIf(options.platformSweep !== false)('a preview copy never purges; the primary beside it does, in the same platform sweep', async () => {
        const primary = await freshScope();
        const preview = await freshScope({ kind: 'preview' });
        const onPrimary = await dueBox(primary);
        const onPreview = await dueBox(preview);
        await runPlatformSweep(host, {
          actor: staff,
          fetch: noFetch,
          sweepers: {},
          drainRetries: false,
          gcSnapshots: false,
          reconcileMigrations: false,
        });
        expect(await exists(primary, onPrimary)).toBe(false);
        expect(await exists(preview, onPreview)).toBe(true);
      });
    });

    // -- registration ----------------------------------------------------------------------

    describe('registration', () => {
      const variant = (patch: (m: typeof trashMod) => typeof trashMod) => {
        const copy = patch({ ...trashMod, manifest: { ...trashMod.manifest, id: moduleId.parse(`@test/trash-${ulid().toLowerCase()}`) } });
        return () => host.registerModule(copy);
      };

      it('refuses a module with a trashable entity and no operationTargets', () => {
        expect(variant(({ operationTargets: _, ...m }) => m)).toThrow(/operationTargets/);
      });

      it('refuses a purge schedule that runs anything but the purging operation', () => {
        expect(
          variant((m) => ({
            ...m,
            manifest: {
              ...m.manifest,
              schedules: m.manifest.schedules!.map((sch) => ({ ...sch, operation: 'trash/other-delete' })),
            },
          })),
        ).toThrow(/purge schedule/);
      });

      it('refuses a horizon with no purge schedule', () => {
        expect(variant((m) => ({ ...m, manifest: { ...m.manifest, schedules: [] } }))).toThrow(/purge horizon/);
      });
    });
  });
}
