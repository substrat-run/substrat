/**
 * Contract suite for entity archive and trash (#119): `ctx.archive`, `ctx.unarchive`,
 * `ctx.trash`, `ctx.restore`, `ctx.entityState`, the views `ctx.page`/`ctx.search` compose,
 * the permission-checked trashed readers, and `ctx.sql`'s refusal to write the columns.
 *
 * The REAL tuple checker on purpose: the property under test is that the kernel checks the
 * DECLARED key, and an allow-all checker would pass a verb that checked nothing.
 *
 * Every refusal here has its positive twin beside it, so a test cannot pass by a verb that
 * refuses everything.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  PAGE_CURSOR_RESTART,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type CountedPage,
  type HistoryEntry,
  type Page,
  type PrincipalId,
  type ScopeId,
  type TenantId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub, type SearchHit } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { stateMod } from './entity-state-module.js';

const READ = permissionKey.parse('doc:read');
const ARCHIVE = permissionKey.parse('doc:archive');
const TRASH = permissionKey.parse('doc:trash');

type Row = Record<string, unknown>;

/**
 * Raw SQL on one scope's own database, past `ctx.sql` and its guard — the adapter's test
 * harness supplies it. Used once: to prove the trigger under the guard holds on its own.
 */
export type RawScopeSql = (tenant: TenantId, scope: ScopeId, sql: string, params?: readonly unknown[]) => Promise<void>;

export function entityStateContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
  raw: RawScopeSql,
): void {
  describe(`entity archive and trash (#119): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    const t1 = tenantId.parse(ulid());
    const scope = scopeId.parse(ulid());
    const staff = platformActorId.parse(ulid());
    /** Every key, scope-wide. */
    const alice: PrincipalId = principalId.parse(ulid());
    /** Archive but NOT trash — the two keys are distinct, and this is who proves it. */
    const bob: PrincipalId = principalId.parse(ulid());
    /** Trash on ONE document only, entity-narrowed — whose bin holds that one and nothing else. */
    const carol: PrincipalId = principalId.parse(ulid());
    let as: Record<'alice' | 'bob' | 'carol', ScopeStub>;
    const carolsDoc = `01CAROL${ulid().slice(7)}`;

    /** A fresh document, so each case starts from `active` whatever ran before it. */
    const doc = async (title = `doc ${ulid()}`, owner = 'o1'): Promise<string> => {
      const id = ulid();
      await as.alice.invoke('state/add', { id, title, owner });
      return id;
    };
    const errOf = async (call: Promise<unknown>): Promise<unknown> =>
      call.then(
        () => {
          throw new Error('expected a refusal, got an answer');
        },
        (e: unknown) => e,
      );
    const ids = (page: Page<Row>) => page.entries.map((r) => String(r['id']));
    const activeIds = async () => ids(await as.alice.invoke<Page<Row>>('state/page', {}));
    const archivedIds = async () => ids(await as.alice.invoke<Page<Row>>('state/page', { view: 'archived' }));
    const trashedIds = async () => ids(await as.alice.invoke<Page<Row>>('state/page-trashed', {}));

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(stateMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'state-tenant', name: 'State Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'state');
      await host.admin.defineRole(staff, t1, { key: 'keeper', permissions: [READ, ARCHIVE, TRASH], source: 'vertical' });
      await host.admin.defineRole(staff, t1, { key: 'filer', permissions: [READ, ARCHIVE], source: 'vertical' });
      await host.admin.assignRole(staff, { principalId: alice, roleKey: 'keeper', node: { tenantId: t1, scopeId: null } });
      await host.admin.assignRole(staff, { principalId: bob, roleKey: 'filer', node: { tenantId: t1, scopeId: null } });
      await host.provisionScope(staff, { tenantId: t1, scopeId: scope, vertical: 'state-vertical' });
      await host.admin.activateScope(staff, t1, scope);
      await host.admin.grant(staff, {
        principalId: carol,
        permission: TRASH,
        node: { tenantId: t1, scopeId: scope },
        entity: { entityType: 'stdoc', entityId: carolsDoc },
        grantedBy: alice,
      });
      as = {
        alice: await host.getScope(alice, t1, scope),
        bob: await host.getScope(bob, t1, scope),
        carol: await host.getScope(carol, t1, scope),
      };
      await as.alice.invoke('state/add', { id: carolsDoc, title: 'carol owns this', owner: 'o3' });
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    // -- transitions ---------------------------------------------------------------------

    it('archives an active entity, and unarchives it back', async () => {
      const id = await doc();
      expect(await as.alice.invoke('state/archive', { id })).toBe('archived');
      expect(await as.alice.invoke('state/state', { id })).toBe('archived');
      expect(await as.alice.invoke('state/unarchive', { id })).toBe('active');
    });

    it('trashes an active entity, and restore brings it back ACTIVE', async () => {
      const id = await doc();
      expect(await as.alice.invoke('state/trash', { id })).toBe('trashed');
      expect(await as.alice.invoke('state/restore', { id })).toBe('active');
    });

    it('trashes an ARCHIVED entity, and restore brings it back ARCHIVED — never silently active', async () => {
      const id = await doc();
      await as.alice.invoke('state/archive', { id });
      expect(await as.alice.invoke('state/trash', { id })).toBe('trashed');
      expect(await as.alice.invoke('state/restore', { id })).toBe('archived');
      expect(await activeIds()).not.toContain(id);
      expect(await archivedIds()).toContain(id);
    });

    it('answers null for a row that does not exist', async () => {
      expect(await as.alice.invoke('state/state', { id: ulid() })).toBeNull();
    });

    // -- refusals ------------------------------------------------------------------------

    const expectConflict = async (call: Promise<unknown>) => {
      const err = await errOf(call);
      expect(errorCodeOf(err)).toBe('conflict');
      expect(err).toMatchObject({ extensions: { reason: 'invalid_transition' } });
    };

    it('refuses every move out of a state it does not start from', async () => {
      const id = await doc();
      await expectConflict(as.alice.invoke('state/unarchive', { id })); // active
      await expectConflict(as.alice.invoke('state/restore', { id })); // active
      await as.alice.invoke('state/archive', { id });
      await expectConflict(as.alice.invoke('state/archive', { id })); // archived
      await expectConflict(as.alice.invoke('state/restore', { id })); // archived, not trashed
      await as.alice.invoke('state/trash', { id });
      await expectConflict(as.alice.invoke('state/archive', { id })); // trashed: restore first
      await expectConflict(as.alice.invoke('state/unarchive', { id })); // trashed
      await expectConflict(as.alice.invoke('state/trash', { id })); // trashed
      // …and the state is exactly what the last legal move left.
      expect(await as.alice.invoke('state/state', { id })).toBe('trashed');
    });

    it('answers not_found for a row that does not exist, after the key check', async () => {
      expect(errorCodeOf(await errOf(as.alice.invoke('state/archive', { id: ulid() })))).toBe('not_found');
      expect(errorCodeOf(await errOf(as.alice.invoke('state/trash', { id: ulid() })))).toBe('not_found');
    });

    it('refuses a verb on an entity that declares no such state', async () => {
      await as.alice.invoke('state/add', { entityType: 'stnote', id: 'N-trash', title: 'note' });
      await as.alice.invoke('state/add', { entityType: 'stplain', id: 'P-1', title: 'plain' });
      expect(errorCodeOf(await errOf(as.alice.invoke('state/trash', { entityType: 'stnote', id: 'N-trash' })))).toBe(
        'validation_failed',
      );
      expect(
        errorCodeOf(await errOf(as.alice.invoke('state/archive', { entityType: 'stplain', id: 'P-1' }))),
      ).toBe('validation_failed');
      // Positive twin: the note's declared archive works.
      expect(await as.alice.invoke('state/archive', { entityType: 'stnote', id: 'N-trash' })).toBe('archived');
    });

    it('rolls the move back with an operation that throws after it', async () => {
      const id = await doc();
      await errOf(as.alice.invoke('state/archive-then-throw', { id }));
      expect(await as.alice.invoke('state/state', { id })).toBe('active');
      const events = await as.alice.invoke<HistoryEntry[]>('state/history', { id });
      expect(events.map((e) => e.type)).not.toContain('entity.archived');
    });

    // -- the declared keys ---------------------------------------------------------------

    it('checks the declared ARCHIVE key: a holder may archive', async () => {
      const id = await doc();
      expect(await as.bob.invoke('state/archive', { id })).toBe('archived');
      expect(await as.bob.invoke('state/unarchive', { id })).toBe('active');
    });

    it('checks the declared TRASH key — archive authority is not trash authority', async () => {
      const id = await doc();
      expect(errorCodeOf(await errOf(as.bob.invoke('state/trash', { id })))).toBe('permission_denied');
      await as.alice.invoke('state/trash', { id });
      expect(errorCodeOf(await errOf(as.bob.invoke('state/restore', { id })))).toBe('permission_denied');
      expect(await as.alice.invoke('state/state', { id })).toBe('trashed');
    });

    it('checks the key on THE entity: an entity-narrowed trash grant reaches that one row only', async () => {
      const other = await doc();
      expect(errorCodeOf(await errOf(as.carol.invoke('state/trash', { id: other })))).toBe('permission_denied');
      // …and trash authority is not archive authority either.
      expect(errorCodeOf(await errOf(as.carol.invoke('state/archive', { id: carolsDoc })))).toBe('permission_denied');
      expect(await as.carol.invoke('state/trash', { id: carolsDoc })).toBe('trashed');
      expect(await as.carol.invoke('state/restore', { id: carolsDoc })).toBe('active');
    });

    it('refuses before it reveals: a caller without the key learns nothing about a missing id', async () => {
      expect(errorCodeOf(await errOf(as.carol.invoke('state/trash', { id: ulid() })))).toBe('permission_denied');
    });

    // -- recording -----------------------------------------------------------------------

    it('records each move as a kernel event carrying who, when, from and to', async () => {
      const id = await doc();
      await as.alice.invoke('state/archive', { id });
      await as.alice.invoke('state/trash', { id });
      await as.alice.invoke('state/restore', { id });
      await as.bob.invoke('state/unarchive', { id });
      const events = (await as.alice.invoke<HistoryEntry[]>('state/history', { id })).filter((e) =>
        e.type.startsWith('entity.'),
      );
      expect(events.map((e) => [e.type, e.payload])).toEqual([
        ['entity.archived', { entity: { entityType: 'stdoc', entityId: id }, from: 'active', to: 'archived' }],
        ['entity.trashed', { entity: { entityType: 'stdoc', entityId: id }, from: 'archived', to: 'trashed' }],
        ['entity.restored', { entity: { entityType: 'stdoc', entityId: id }, from: 'trashed', to: 'archived' }],
        ['entity.unarchived', { entity: { entityType: 'stdoc', entityId: id }, from: 'archived', to: 'active' }],
      ]);
      expect(events.map((e) => e.actor)).toEqual([alice, alice, alice, bob]);
      expect(events.every((e) => typeof e.occurredAt === 'string')).toBe(true);
      // The declared key is what authorized it, on the entity (K-34).
      expect(JSON.stringify(events[3]!.authorization)).toContain('doc:archive');
    });

    // -- views ---------------------------------------------------------------------------

    it('leaves archived and trashed rows out of the active page, and its count', async () => {
      const [a, b, c] = [await doc('view a', 'ov'), await doc('view b', 'ov'), await doc('view c', 'ov')];
      await as.alice.invoke('state/archive', { id: b });
      await as.alice.invoke('state/trash', { id: c });
      const page = await as.alice.invoke<CountedPage<Row>>('state/page', { filters: { owner: 'ov' }, total: true });
      expect(ids(page)).toEqual([a]);
      expect(page.total).toBe(1);
      const archived = await as.alice.invoke<CountedPage<Row>>('state/page', {
        view: 'archived',
        filters: { owner: 'ov' },
        total: true,
      });
      expect(ids(archived)).toEqual([b]);
      expect(archived.total).toBe(1);
      expect(await trashedIds()).toContain(c);
      expect(await trashedIds()).not.toContain(b);
    });

    it('keeps a trashed ARCHIVED row out of the archive view — trash wins', async () => {
      const id = await doc();
      await as.alice.invoke('state/archive', { id });
      await as.alice.invoke('state/trash', { id });
      expect(await archivedIds()).not.toContain(id);
      expect(await trashedIds()).toContain(id);
    });

    it('refuses the trashed view on the unchecked ctx.page, and a view an entity does not declare', async () => {
      expect(errorCodeOf(await errOf(as.alice.invoke('state/page', { view: 'trashed' })))).toBe('validation_failed');
      expect(
        errorCodeOf(await errOf(as.alice.invoke('state/page', { entityType: 'stplain', view: 'archived' }))),
      ).toBe('validation_failed');
      // Positive twins: the archive-only note has an archived view, and a plain entity pages.
      await as.alice.invoke('state/page', { entityType: 'stnote', view: 'archived' });
      await as.alice.invoke('state/page', { entityType: 'stplain' });
    });

    it('reads the bin with the declared trash key checked on EVERY row', async () => {
      const mine = carolsDoc;
      const someoneElses = await doc('not carols');
      await as.alice.invoke('state/trash', { id: mine });
      await as.alice.invoke('state/trash', { id: someoneElses });
      const carols = ids(await as.carol.invoke<Page<Row>>('state/page-trashed', {}));
      expect(carols).toEqual([mine]);
      // A key holder scope-wide sees both; a caller with no trash key sees nothing.
      expect(await trashedIds()).toEqual(expect.arrayContaining([mine, someoneElses]));
      expect(ids(await as.bob.invoke<Page<Row>>('state/page-trashed', {}))).toEqual([]);
      await as.alice.invoke('state/restore', { id: mine });
    });

    it('keeps walking the bin past a page whose rows were all refused', async () => {
      // Pages of one: carol is refused every row but her own, and the walk must reach it.
      const seen: string[] = [];
      let cursor: string | undefined;
      await as.alice.invoke('state/trash', { id: carolsDoc });
      for (let guard = 0; guard < 200; guard++) {
        const got = await as.carol.invoke<Page<Row>>('state/page-trashed', { limit: 1, cursor });
        seen.push(...ids(got));
        if (got.nextCursor === null) break;
        cursor = got.nextCursor;
      }
      expect(seen).toEqual([carolsDoc]);
      await as.alice.invoke('state/restore', { id: carolsDoc });
    });

    it('hands a caller denied every binned row an empty bin and NO cursor — no position of a hidden row leaks', async () => {
      const hidden = await doc('hidden from bob');
      await as.alice.invoke('state/trash', { id: hidden });
      for (const limit of [1, 2, 50]) {
        expect(await as.bob.invoke<Page<Row>>('state/page-trashed', { limit })).toEqual({ entries: [], nextCursor: null });
      }
      await as.alice.invoke('state/restore', { id: hidden });
    });

    it('seals a bin cursor and binds it to the caller, including across both adapters', async () => {
      const others = [await doc('aaa other'), await doc('zzz other')];
      for (const id of [...others, carolsDoc]) await as.alice.invoke('state/trash', { id });
      const first = await as.carol.invoke<Page<Row>>('state/page-trashed', { limit: 1 });
      expect(ids(first)).toEqual([carolsDoc]);
      expect(first.nextCursor).not.toBeNull();
      expect(first.nextCursor).toMatch(/^sc1\./);
      expect(first.nextCursor).not.toContain(carolsDoc);
      expect(first.nextCursor).not.toContain('carol owns this');
      // Both adapters keep the key outside the scope SQL module code can read.
      expect(await as.carol.invoke('state/sql', {
        sql: "SELECT name FROM sqlite_master WHERE name LIKE 'private_continuation_%'",
      })).toEqual([]);
      expect(await errOf(as.carol.invoke('state/sql', {
        sql: 'SELECT keyring FROM private_continuation_keys',
      }))).toBeTruthy();
      if (adapterName === 'adapter-cloudflare') {
        // DO KV shares workerd's SQLite internals. The module SQL wrapper must
        // refuse their names before workerd can hand the keyring back.
        const internal = await errOf(as.carol.invoke('state/sql', { sql: 'SELECT * FROM _cf_KV' }));
        expect(errorCodeOf(internal)).toBe('forbidden');
        expect(await as.carol.invoke('state/sql', { sql: 'SELECT 1 AS ok /* _cf_KV */' })).toEqual([{ ok: 1 }]);
        const consoleRead = await errOf(host.admin.queryScope(staff, t1, scope, { sql: 'SELECT * FROM _cf_KV' }));
        expect(errorCodeOf(consoleRead)).toBe('forbidden');
        await expect(host.admin.readScopeTable(staff, t1, scope, { table: '_cf_KV', limit: 1, offset: 0 }))
          .rejects.toBeTruthy();
        expect((await host.admin.listScopeTables(staff, t1, scope)).some((table) => table.name.startsWith('_cf_'))).toBe(false);
      } else {
        // The private directory database is a distinct file, unreachable through the
        // scope console as well as the module SQL seam.
        await expect(host.admin.queryScope(staff, t1, scope, {
          sql: 'SELECT keyring FROM private_continuation_keys',
        })).rejects.toBeTruthy();
      }
      const replay = await errOf(as.bob.invoke('state/page-trashed', { limit: 1, cursor: first.nextCursor }));
      expect(replay).toMatchObject({ extensions: { reason: PAGE_CURSOR_RESTART } });
      expect(await as.carol.invoke<Page<Row>>('state/page-trashed', { limit: 1, cursor: first.nextCursor })).toEqual({
        entries: [],
        nextCursor: null,
      });
      for (const id of [...others, carolsDoc]) await as.alice.invoke('state/restore', { id });
    });

    it("refuses a cursor from one view in another — a position among the active rows means nothing in the archive", async () => {
      const [a, b] = [await doc('cursor a', 'ocur'), await doc('cursor b', 'ocur')];
      const [c, d] = [await doc('cursor c', 'ocur'), await doc('cursor d', 'ocur')];
      await as.alice.invoke('state/archive', { id: c });
      await as.alice.invoke('state/archive', { id: d });
      const restart = async (call: Promise<unknown>) => {
        const err = await errOf(call);
        expect(errorCodeOf(err)).toBe('validation_failed');
        expect(err).toMatchObject({ extensions: { reason: PAGE_CURSOR_RESTART } });
      };
      const filters = { owner: 'ocur' };
      const active = await as.alice.invoke<Page<Row>>('state/page', { limit: 1, filters });
      expect(ids(active)).toEqual([a]);
      await restart(as.alice.invoke('state/page', { limit: 1, filters, view: 'archived', cursor: active.nextCursor }));
      await restart(as.alice.invoke('state/page-trashed', { limit: 1, cursor: active.nextCursor }));
      const archived = await as.alice.invoke<Page<Row>>('state/page', { limit: 1, filters, view: 'archived' });
      expect(ids(archived)).toEqual([c]);
      await restart(as.alice.invoke('state/page', { limit: 1, filters, cursor: archived.nextCursor }));
      // The twins: each cursor continues the view that minted it.
      expect(ids(await as.alice.invoke<Page<Row>>('state/page', { limit: 1, filters, cursor: active.nextCursor }))).toEqual([b]);
      expect(
        ids(await as.alice.invoke<Page<Row>>('state/page', { limit: 1, filters, view: 'archived', cursor: archived.nextCursor })),
      ).toEqual([d]);
    });

    it('carries no total on the bin — a count would disclose rows the caller cannot see', async () => {
      expect(errorCodeOf(await errOf(as.alice.invoke('state/page-trashed', { total: true })))).toBe(
        'validation_failed',
      );
    });

    it('searches the active rows by default, the archive on request, and the bin key-checked', async () => {
      const tag = `zq${ulid().slice(-6).toLowerCase()}`;
      const [live, filed, binned] = [
        await doc(`${tag} live`),
        await doc(`${tag} filed`),
        await doc(`${tag} binned`),
      ];
      await as.alice.invoke('state/archive', { id: filed });
      await as.alice.invoke('state/trash', { id: binned });
      const found = async (op: string, extra: Record<string, unknown> = {}, who = as.alice) =>
        (await who.invoke<SearchHit[]>(op, { term: tag, ...extra })).map((h) => h.id);
      expect(await found('state/search')).toEqual([live]);
      expect(await found('state/search', { view: 'archived' })).toEqual([filed]);
      expect(await found('state/search-trashed')).toEqual([binned]);
      expect(await found('state/search-trashed', {}, as.bob)).toEqual([]);
      expect(errorCodeOf(await errOf(as.alice.invoke('state/search', { term: tag, view: 'trashed' })))).toBe(
        'validation_failed',
      );
    });

    // -- the columns are the kernel's -----------------------------------------------------

    const expectGuarded = async (sql: string) => {
      const err = await errOf(as.alice.invoke('state/sql', { sql }));
      expect(errorCodeOf(err), sql).toBe('forbidden');
      expect(err).toMatchObject({ extensions: { reason: 'spine_write' } });
    };

    it('refuses a module write to either column, in every position a write names one', async () => {
      const id = await doc();
      await as.alice.invoke('state/trash', { id });
      const before = await as.alice.invoke<HistoryEntry[]>('state/history', { id });
      await expectGuarded(`UPDATE state_docs SET _substrat_trashed_at = NULL WHERE id = '${id}'`);
      await expectGuarded(`UPDATE state_docs SET title = 'x', _substrat_archived_at = '2026' WHERE id = '${id}'`);
      await expectGuarded(
        `UPDATE state_docs SET title = (SELECT title FROM state_docs WHERE id = 'x'), _substrat_trashed_at = NULL`,
      );
      await expectGuarded(`UPDATE state_docs SET (title, _substrat_trashed_at) = ('x', NULL)`);
      // Codex r2: a CASE … END before the target ended the first scanner's list at its END.
      await expectGuarded(`UPDATE state_docs SET title = CASE WHEN 1 THEN 'x' ELSE title END, _substrat_trashed_at = NULL WHERE id = '${id}'`);
      await expectGuarded(
        `UPDATE state_docs SET title = (SELECT CASE WHEN 1 THEN 'END' END), "_substrat_trashed_at" = NULL WHERE id = '${id}'`,
      );
      await expectGuarded(`UPDATE state_docs SET "_substrat_trashed_at" = NULL`);
      await expectGuarded(
        `INSERT INTO state_docs (id, title, owner, _substrat_archived_at) VALUES ('${ulid()}', 't', 'o', '2026')`,
      );
      await expectGuarded(
        `INSERT INTO state_docs (id, title, owner) VALUES ('${id}', 't', 'o')
         ON CONFLICT (id) DO UPDATE SET _substrat_trashed_at = NULL`,
      );
      await expectGuarded('ALTER TABLE state_docs DROP COLUMN _substrat_trashed_at');
      await expectGuarded('ALTER TABLE state_docs RENAME COLUMN _substrat_trashed_at TO gone');
      // Nothing above reached the row, or its history.
      expect(await as.alice.invoke('state/state', { id })).toBe('trashed');
      expect(await as.alice.invoke<HistoryEntry[]>('state/history', { id })).toEqual(before);
    });

    it('lets a module READ the columns, in a SELECT and in the WHERE of its own write', async () => {
      const id = await doc();
      await as.alice.invoke('state/archive', { id });
      const rows = await as.alice.invoke<Row[]>('state/sql', {
        sql: 'SELECT _substrat_archived_at AS at FROM state_docs WHERE id = ?',
        params: [id],
      });
      expect(typeof rows[0]!['at']).toBe('string');
      await as.alice.invoke('state/sql', {
        sql: `UPDATE state_docs SET title = 'renamed' WHERE id = ? AND _substrat_trashed_at IS NULL`,
        params: [id],
      });
      await as.alice.invoke('state/sql', {
        sql: `UPDATE state_docs SET title = (SELECT title FROM state_docs WHERE _substrat_archived_at IS NOT NULL LIMIT 1) WHERE id = ?`,
        params: [id],
      });
      const after = await as.alice.invoke<Row[]>('state/sql', { sql: 'SELECT title FROM state_docs WHERE id = ?', params: [id] });
      expect(after[0]!['title']).toBeTypeOf('string');
    });

    it('refuses every write that would set the state by position or reset it by REPLACE — and none moves it', async () => {
      const binned = await doc();
      await as.alice.invoke('state/trash', { id: binned });
      const before = await as.alice.invoke<HistoryEntry[]>('state/history', { id: binned });
      const born = ulid();
      // Columns are (id, title, owner, _substrat_archived_at, _substrat_trashed_at).
      for (const sql of [
        `INSERT INTO state_docs VALUES ('${born}', 't', 'o', '2026', NULL)`,
        `insert into STATE_DOCS values ('${born}', 't', 'o', NULL, '2026')`,
        `INSERT INTO main.state_docs VALUES ('${born}', 't', 'o', '2026', NULL)`,
        `INSERT INTO state_docs SELECT '${born}', 't', 'o', '2026', NULL`,
        `INSERT OR IGNORE INTO state_docs VALUES ('${born}', 't', 'o', '2026', NULL)`,
        // REPLACE deletes the binned row and writes it back with both columns NULL: a restore
        // without the key and without a record.
        `REPLACE INTO state_docs (id, title, owner) VALUES ('${binned}', 't', 'o')`,
        `INSERT OR REPLACE INTO state_docs (id, title, owner) VALUES ('${binned}', 't', 'o')`,
        `REPLACE INTO state_docs VALUES ('${binned}', 't', 'o', NULL, NULL)`,
      ]) {
        await expectGuarded(sql);
      }
      expect(await as.alice.invoke('state/state', { id: binned })).toBe('trashed');
      expect(await as.alice.invoke('state/state', { id: born })).toBeNull();
      expect(await as.alice.invoke<HistoryEntry[]>('state/history', { id: binned })).toEqual(before);
    });

    it('still lets a module write a stateful table by naming its columns, and any other table by position', async () => {
      const named = ulid();
      await as.alice.invoke('state/sql', { sql: `INSERT INTO state_docs (id, title, owner) VALUES ('${named}', 't', 'o')` });
      expect(await as.alice.invoke('state/state', { id: named })).toBe('active');
      const selected = ulid();
      await as.alice.invoke('state/sql', {
        sql: `INSERT INTO state_docs (id, title, owner) SELECT '${selected}', title, owner FROM state_docs WHERE id = '${named}'`,
      });
      expect(await as.alice.invoke('state/state', { id: selected })).toBe('active');
      await as.alice.invoke('state/sql', { sql: `INSERT INTO state_plain VALUES ('${ulid()}', 'plain')` });
      await as.alice.invoke('state/sql', { sql: `REPLACE INTO state_plain VALUES ('P-1', 'replaced')` });
    });

    it('never lets a row be born archived or trashed, even by SQL the guard never sees', async () => {
      const born = ulid();
      for (const sql of [
        `INSERT INTO state_docs (id, title, owner, _substrat_archived_at) VALUES ('${born}', 't', 'o', '2026')`,
        `INSERT INTO state_docs (id, title, owner, _substrat_trashed_at) VALUES ('${born}', 't', 'o', '2026')`,
        `INSERT INTO state_notes (id, title, _substrat_archived_at) VALUES ('${born}', 't', '2026')`,
      ]) {
        await expect(raw(t1, scope, sql), sql).rejects.toThrow(/never inserted archived or trashed/);
      }
      expect(await as.alice.invoke('state/state', { id: born })).toBeNull();
      // The twin: the same raw path inserts an active row.
      await raw(t1, scope, `INSERT INTO state_docs (id, title, owner) VALUES ('${born}', 't', 'o')`);
      expect(await as.alice.invoke('state/state', { id: born })).toBe('active');
    });

    it('never lets a state column change outside a kernel move, even by SQL the guard never sees', async () => {
      const id = await doc();
      await as.alice.invoke('state/trash', { id });
      const before = await as.alice.invoke<HistoryEntry[]>('state/history', { id });
      for (const sql of [
        `UPDATE state_docs SET _substrat_trashed_at = NULL WHERE id = '${id}'`,
        `UPDATE state_docs SET title = CASE WHEN 1 THEN 'x' ELSE title END, _substrat_trashed_at = NULL WHERE id = '${id}'`,
        `UPDATE state_docs SET _substrat_archived_at = '2026' WHERE id = '${id}'`,
      ]) {
        await expect(raw(t1, scope, sql), sql).rejects.toThrow(/moves only through ctx\.archive/);
      }
      expect(await as.alice.invoke('state/state', { id })).toBe('trashed');
      expect(await as.alice.invoke<HistoryEntry[]>('state/history', { id })).toEqual(before);
      // The twins: an update that leaves the columns alone is untouched by the trigger, and the
      // kernel's own move still passes it.
      await raw(t1, scope, `UPDATE state_docs SET title = 'renamed raw' WHERE id = '${id}'`);
      expect(await as.alice.invoke('state/restore', { id })).toBe('active');
    });

    it('carries archived and binned rows through an export and import, and the trigger comes back after them', async () => {
      const filed = await doc('carried filed');
      const binned = await doc('carried binned');
      await as.alice.invoke('state/archive', { id: filed });
      await as.alice.invoke('state/archive', { id: binned });
      await as.alice.invoke('state/trash', { id: binned });
      const fork = scopeId.parse(ulid());
      await host.importScope(staff, { tenantId: t1, scopeId: fork, vertical: 'state-vertical' }, await host.admin.exportScope(staff, t1, scope));
      const there = await host.getScope(alice, t1, fork);
      expect(await there.invoke('state/state', { id: filed })).toBe('archived');
      expect(await there.invoke('state/state', { id: binned })).toBe('trashed');
      expect(await there.invoke('state/restore', { id: binned })).toBe('archived');
      await expect(
        raw(t1, fork, `INSERT INTO state_docs (id, title, owner, _substrat_trashed_at) VALUES ('${ulid()}', 't', 'o', '2026')`),
      ).rejects.toThrow(/never inserted archived or trashed/);
      await expect(raw(t1, fork, `UPDATE state_docs SET _substrat_archived_at = NULL WHERE id = '${filed}'`)).rejects.toThrow(
        /moves only through ctx\.archive/,
      );
      // The derived list indexes came back with the load too: the walk still plans on them, and
      // a module's runtime DDL in the copy passes the kernel's integrity check.
      const rt = `rt_${ulid().toLowerCase()}`;
      await there.invoke('state/sql', { sql: `CREATE TABLE ${rt} (id TEXT)` });
      expect((await there.invoke<string[]>('state/explain', { view: 'archived' })).join(' | ')).toMatch(
        /INDEX _substrat_list_test_state_stdoc_title_archived\b/,
      );
    });

    it("refuses runtime DDL that would move a stateful table's rows out from under its triggers", async () => {
      const id = await doc('ddl victim');
      await as.alice.invoke('state/trash', { id });
      const before = await as.alice.invoke<HistoryEntry[]>('state/history', { id });
      const copy = `SELECT id, title, owner, NULL AS _substrat_archived_at, NULL AS _substrat_trashed_at FROM main.state_docs`;
      for (const sql of [
        // Codex r3's sequence, statement by statement.
        'ALTER TABLE state_docs RENAME TO state_docs_old',
        `CREATE TABLE state_docs AS ${copy}`,
        'DROP TABLE state_docs',
        'DROP TABLE IF EXISTS main.state_docs',
        // Every spelling of the name.
        'ALTER TABLE "State_Docs" RENAME TO x',
        'ALTER TABLE main.state_docs RENAME TO x',
        'ALTER TABLE state_plain RENAME TO state_docs',
        'ALTER TABLE state_docs RENAME COLUMN title TO heading',
        'ALTER TABLE state_docs DROP COLUMN title',
        // A temp object of the same name shadows the table in every unqualified reference.
        `CREATE TEMP TABLE state_docs AS ${copy}`,
        `CREATE TEMPORARY TABLE IF NOT EXISTS "STATE_DOCS" (id TEXT)`,
        `CREATE TEMP VIEW state_docs AS ${copy}`,
        `CREATE TABLE temp.state_docs AS ${copy}`,
        'CREATE TEMP TRIGGER t_shadow AFTER INSERT ON state_docs BEGIN SELECT 1; END',
        'CREATE TRIGGER t_on AFTER UPDATE ON main.state_docs BEGIN SELECT 1; END',
        // `begin` as an identifier ahead of the trigger (CodeRabbit on #2070) — on a DO, one exec
        // runs every statement in the string.
        'SELECT 1 AS begin; CREATE TRIGGER t_hidden BEFORE UPDATE OF _substrat_trashed_at ON state_docs BEGIN SELECT RAISE(IGNORE); END',
        // The kernel's derived objects, by their reserved prefix.
        'DROP TRIGGER _substrat_state_state_docs_moved',
        'DROP TRIGGER IF EXISTS _substrat_state_state_docs_born',
        'DROP INDEX _substrat_list_test_state_stdoc_title',
        "ATTACH DATABASE ':memory:' AS other",
      ]) {
        await expectGuarded(sql);
      }
      expect(await as.alice.invoke('state/state', { id })).toBe('trashed');
      expect(await as.alice.invoke<HistoryEntry[]>('state/history', { id })).toEqual(before);
      expect(ids(await as.alice.invoke<Page<Row>>('state/page-trashed', {}))).toContain(id);
    });

    it("still runs a module's ordinary runtime DDL (#1811), and checks the stateful tables after it", async () => {
      const t = `rt_${ulid().toLowerCase()}`;
      await as.alice.invoke('state/sql', { sql: `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY)` });
      await as.alice.invoke('state/sql', { sql: `INSERT INTO ${t} VALUES ('a')` });
      await as.alice.invoke('state/sql', { sql: `ALTER TABLE ${t} ADD COLUMN note TEXT` });
      await as.alice.invoke('state/sql', { sql: `CREATE INDEX ${t}_note ON ${t} (note)` });
      await as.alice.invoke('state/sql', { sql: `CREATE INDEX IF NOT EXISTS state_docs_owner_rt ON state_docs (owner)` });
      expect(await as.alice.invoke<Row[]>('state/sql', { sql: `SELECT id FROM ${t}` })).toEqual([{ id: 'a' }]);
      await as.alice.invoke('state/sql', { sql: `DROP TABLE ${t}` });
    });

    it('refuses to record a move whose update a foreign trigger swallowed', async () => {
      // Past every guard, a trigger that turns the kernel's UPDATE into a no-op (CodeRabbit on #2070).
      const id = await doc('swallowed');
      await as.alice.invoke('state/trash', { id });
      const before = await as.alice.invoke<HistoryEntry[]>('state/history', { id });
      await raw(t1, scope, 'CREATE TRIGGER t_swallow BEFORE UPDATE OF _substrat_trashed_at ON state_docs BEGIN SELECT RAISE(IGNORE); END');
      try {
        const err = await errOf(as.alice.invoke('state/restore', { id }));
        expect(String((err as Error).message)).toMatch(/changed no row/);
        expect(await as.alice.invoke('state/state', { id })).toBe('trashed');
        expect(await as.alice.invoke<HistoryEntry[]>('state/history', { id })).toEqual(before);
      } finally {
        await raw(t1, scope, 'DROP TRIGGER t_swallow');
      }
      expect(await as.alice.invoke('state/restore', { id })).toBe('active');
    });

    it('repairs, in the same operation, a guard trigger missing when runtime DDL runs (#2090)', async () => {
      // Past the guard, take one derived trigger away — what a form nobody foresaw would do.
      await raw(t1, scope, 'DROP TRIGGER _substrat_state_state_docs_born');
      const t = `rt_${ulid().toLowerCase()}`;
      await as.alice.invoke('state/sql', { sql: `CREATE TABLE ${t} (id TEXT)` });
      // The trigger is back as the kernel derives it: a row is never born binned again.
      await expect(
        raw(t1, scope, `INSERT INTO state_docs (id, title, owner, _substrat_trashed_at) VALUES ('${ulid()}', 't', 'o', '2026')`),
      ).rejects.toThrow(/never inserted archived or trashed/);
      await as.alice.invoke('state/sql', { sql: `DROP TABLE ${t}` });
    });

    // -- the indexes -------------------------------------------------------------------------

    const planOf = (view?: string, extra: Record<string, unknown> = {}) =>
      as.alice.invoke<string[]>('state/explain', { ...(view ? { view } : {}), ...extra });

    it('walks each view on its own PARTIAL index, never a table scan', async () => {
      const active = (await planOf()).join(' | ');
      expect(active).toMatch(/USING (COVERING )?INDEX _substrat_list_test_state_stdoc_title\b/);
      expect(active).not.toMatch(/SCAN state_docs\b(?! USING)/);
      expect((await planOf('archived')).join(' | ')).toMatch(/INDEX _substrat_list_test_state_stdoc_title_archived\b/);
      expect((await planOf('trashed')).join(' | ')).toMatch(/INDEX _substrat_list_test_state_stdoc_title_trashed\b/);
      expect((await planOf(undefined, { filters: { owner: 'o1' } })).join(' | ')).toMatch(
        /INDEX _substrat_list_test_state_stdoc_owner_title\b/,
      );
      // An archive-only entity: one column, one-term predicate, still partial.
      expect((await planOf(undefined, { entityType: 'stnote' })).join(' | ')).toMatch(
        /INDEX _substrat_list_test_state_stnote_title\b/,
      );
    });
  });
}
