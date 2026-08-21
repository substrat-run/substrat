/**
 * Todo's operations — the business logic, and nothing else.
 *
 * Everything structural is derived from `spec/model.ts`: the migrations were
 * emitted from the entities, the manifest is assembled from both halves of the
 * model, and the route table is derived at mount time. What is left in this file
 * is what only a person could decide — what it MEANS to share a list, and who
 * may do what to one.
 *
 * `satisfies OperationImpl<…>` is the join: a handler whose input or return
 * disagrees with the declared operation, one declared and not implemented, or
 * one implemented and not declared, is a compile error naming the exact method.
 */
import {
  countedPageOf,
  dataSubjectId,
  LIST_PAGE_DEFAULT,
  substratError,
  type HandlerInput,
  type HandlerOutput,
  z,
  type EntityRow,
  type PrincipalId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import { SEARCH_OVERFETCH, todoEntities, todoOperations } from '../spec/model.js';
import { TODO_PERM, todoManifest } from './manifest.js';
import { todoMigrations } from './migrations.generated.js';

type OwnerRow = EntityRow<typeof todoEntities, 'owner'>;
type ListRow = EntityRow<typeof todoEntities, 'list'>;
type ItemRow = EntityRow<typeof todoEntities, 'item'>;
type ShareRow = EntityRow<typeof todoEntities, 'share'>;
const listRef = (id: string) => ({ entityType: 'list', entityId: id });

/**
 * Ask the index for more than the caller wants (#827).
 *
 * `SEARCH_OVERFETCH` is a guess, and an honest one: it is not a guarantee, which is
 * why both handlers still report `capped` rather than pretending the answer is
 * complete. The `min` is a backstop rather than the design — `TODO_SEARCH_MAX` is
 * derived so that the widened ask stays inside the kernel's ceiling, and the clamp
 * only ever fires if that derivation is broken.
 */
const overfetch = (limit: number) => Math.min(limit * SEARCH_OVERFETCH, MAX_SEARCH_LIMIT);

/** Hits carry the rank; rows carry the shape. Re-join them in the index's order. */
function rankOrder(hits: readonly { id: string }[], rows: readonly ItemRow[]): ItemRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return hits.map((hit) => byId.get(hit.id)).filter((row): row is ItemRow => row !== undefined);
}

/** The list, or a refusal — never a silent empty answer. */
function listOrThrow(ctx: OperationContext, id: string): ListRow {
  const row = ctx.sql.query<ListRow>('SELECT * FROM todo_lists WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `list not found: ${id}`);
  return row;
}

/** The list an item sits on — every item permission is really the list's. */
function itemAndList(ctx: OperationContext, itemId: string): { item: ItemRow; list: ListRow } {
  const item = ctx.sql.query<ItemRow>('SELECT * FROM todo_items WHERE id = ?', [itemId])[0];
  if (!item) throw substratError('not_found', `item not found: ${itemId}`);
  return { item, list: listOrThrow(ctx, item.list_id) };
}

const operations = {
  'todo/join': async (ctx, input) => {
    assertAllowed(await ctx.check(TODO_PERM.listCreate));
    const existing = ctx.sql.query<OwnerRow>('SELECT * FROM todo_owners WHERE id = ?', [
      ctx.principal,
    ])[0];
    if (existing) return existing;

    ctx.sql.exec(
      'INSERT INTO todo_owners (id, email, display_name, created_at) VALUES (?, ?, ?, ?)',
      [ctx.principal, input.email, input.displayName, ctx.now()],
    );
    const row = ctx.sql.query<OwnerRow>('SELECT * FROM todo_owners WHERE id = ?', [
      ctx.principal,
    ])[0]!;
    ctx.emit({
      type: 'todo.owner-joined',
      schemaVersion: 1,
      entity: { entityType: 'owner', entityId: row.id },
      piiClass: 'pseudonymous',
      subjectId: dataSubjectId.parse(row.id),
      payload: { id: row.id },
    });
    return row;
  },

  'todo/create-list': async (ctx, input) => {
    assertAllowed(await ctx.check(TODO_PERM.listCreate));
    // The person's own entity must exist: it is what their lists hang off, and
    // what carries the grant that reaches them. Created when they join.
    const owner = ctx.sql.query<OwnerRow>('SELECT * FROM todo_owners WHERE id = ?', [
      ctx.principal,
    ])[0];
    if (!owner)
      throw substratError(
        'precondition_failed',
        'no account here — join before creating a list',
      );

    const id = ulid();
    ctx.sql.exec(
      'INSERT INTO todo_lists (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)',
      [id, owner.id, input.name, ctx.now()],
    );
    // The edge the permission walk follows. Without it the owner's grant on
    // their own entity would reach nothing.
    ctx.link(listRef(id), { entityType: 'owner', entityId: owner.id });

    const row = listOrThrow(ctx, id);
    ctx.emit({
      type: 'todo.list-created',
      schemaVersion: 1,
      entity: listRef(id),
      piiClass: 'none',
      payload: { id: row.id, name: row.name, owner_id: row.owner_id },
    });
    return row;
  },

  /**
   * The proof walk. Every list is a candidate and each one is asked; a list
   * nobody shared simply never answers yes.
   *
   * Deliberately NOT a `WHERE owner_id = ?` — that would be a second, hand-kept
   * description of who may see what, and the one that gets forgotten.
   */
  'todo/my-lists': async (ctx) => {
    const all = ctx.sql.query<ListRow>('SELECT * FROM todo_lists ORDER BY created_at, id');
    const mine: ListRow[] = [];
    for (const list of all) {
      if ((await ctx.check(TODO_PERM.listContribute, listRef(list.id))).allowed) mine.push(list);
    }
    return mine;
  },

  'todo/rename-list': async (ctx, input) => {
    assertAllowed(await ctx.check(TODO_PERM.listManage, listRef(input.listId)));
    listOrThrow(ctx, input.listId);
    ctx.sql.exec('UPDATE todo_lists SET name = ? WHERE id = ?', [input.name, input.listId]);
    const row = listOrThrow(ctx, input.listId);
    ctx.emit({
      type: 'todo.list-renamed',
      schemaVersion: 1,
      entity: listRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, name: row.name },
    });
    return row;
  },

  'todo/delete-list': async (ctx, input) => {
    assertAllowed(await ctx.check(TODO_PERM.listManage, listRef(input.listId)));
    listOrThrow(ctx, input.listId);
    ctx.sql.exec('DELETE FROM todo_items WHERE list_id = ?', [input.listId]);
    ctx.sql.exec('DELETE FROM todo_shares WHERE list_id = ?', [input.listId]);
    ctx.sql.exec('DELETE FROM todo_lists WHERE id = ?', [input.listId]);
    ctx.emit({
      type: 'todo.list-deleted',
      schemaVersion: 1,
      entity: listRef(input.listId),
      piiClass: 'none',
      payload: { id: input.listId },
    });
    return { id: input.listId, deleted: true };
  },

  'todo/list-items': async (ctx, input) => {
    assertAllowed(await ctx.check(TODO_PERM.listContribute, listRef(input.listId)));
    // Keyset, not offset: the cursor is the last row's id and the walk is exclusive, so
    // an item added mid-walk cannot push a row onto a page the caller already read.
    // `ORDER BY id` alone — a ULID is creation-ordered, so the old `created_at, id`
    // ordering is the same sequence with a second column the cursor could not name.
    const limit = input.limit ?? LIST_PAGE_DEFAULT;
    const rows = input.cursor
      ? ctx.sql.query<ItemRow>(
          'SELECT * FROM todo_items WHERE list_id = ? AND id > ? ORDER BY id LIMIT ?',
          [input.listId, input.cursor, limit],
        )
      : ctx.sql.query<ItemRow>('SELECT * FROM todo_items WHERE list_id = ? ORDER BY id LIMIT ?', [
          input.listId,
          limit,
        ]);
    // Counted over the SAME filter the page ran under. Counting the table instead
    // would put a number beside the list that is wrong the moment there are two lists.
    const total = ctx.sql.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM todo_items WHERE list_id = ?',
      [input.listId],
    )[0]!.n;
    return countedPageOf(rows, limit, (row) => row.id, total);
  },

  /**
   * Search on one list (#827) — one check, then hydrate.
   *
   * The index is SCOPE-wide: `ctx.search` knows nothing about lists, so the hits
   * arrive from every list in the scope and the `list_id` in the WHERE is what
   * narrows them. That filter runs AFTER the ranking, which is why the index is
   * asked for more than the caller wants — a top-20 that loses 18 rows to the
   * filter would answer with two and call it the whole result.
   */
  'todo/search-list-items': async (ctx, input) => {
    assertAllowed(await ctx.check(TODO_PERM.listContribute, listRef(input.listId)));
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const fetch = overfetch(limit);
    const hits = ctx.search('item', input.q, { limit: fetch });
    if (hits.length === 0) return { results: [], limit, capped: false };

    const rows = ctx.sql.query<ItemRow>(
      `SELECT * FROM todo_items WHERE list_id = ? AND id IN (${hits.map(() => '?').join(', ')})`,
      [input.listId, ...hits.map((h) => h.id)],
    );
    // `IN (…)` returns rows in whatever order the table hands them back, so the
    // rank has to be put back deliberately: a search that lists the best match
    // third is a search people stop using.
    const ordered = rankOrder(hits, rows);
    return {
      results: ordered.slice(0, limit),
      limit,
      capped: ordered.length > limit || hits.length === fetch,
    };
  },

  /**
   * Search across every list the caller reaches — the same proof walk as
   * `my-lists`, run over search hits instead of over every row.
   *
   * `narrows` rather than a node-level check, because there is no node-level
   * answer: nobody holds `list:contribute` scope-wide, so "may you see this item"
   * is only ever a question about the list it sits on. Asked once per distinct
   * list rather than once per hit — forty matching items on one list is one
   * question, not forty.
   *
   * Stopping at `limit` is what makes this cheap: the walk ends as soon as the
   * answer is full, so a scope with many unreachable matches costs the checks it
   * takes to find `limit` reachable ones, not one per hit.
   */
  'todo/search-items': async (ctx, input) => {
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const fetch = overfetch(limit);
    const hits = ctx.search('item', input.q, { limit: fetch });
    if (hits.length === 0) return { results: [], limit, capped: false };

    const rows = ctx.sql.query<ItemRow>(
      `SELECT * FROM todo_items WHERE id IN (${hits.map(() => '?').join(', ')})`,
      hits.map((h) => h.id),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const reachable = new Map<string, boolean>();
    const results: ItemRow[] = [];
    for (const hit of hits) {
      const row = byId.get(hit.id);
      if (!row) continue;
      let allowed = reachable.get(row.list_id);
      if (allowed === undefined) {
        allowed = (await ctx.check(TODO_PERM.listContribute, listRef(row.list_id))).allowed;
        reachable.set(row.list_id, allowed);
      }
      if (!allowed) continue;
      results.push(row);
      if (results.length === limit) break;
    }
    // Full either because the walk stopped early or because the index itself
    // capped — both mean there may be more, and neither can be paged past.
    return { results, limit, capped: results.length === limit || hits.length === fetch };
  },

  'todo/add-item': async (ctx, input) => {
    assertAllowed(await ctx.check(TODO_PERM.listContribute, listRef(input.listId)));
    listOrThrow(ctx, input.listId);
    const id = ulid();
    ctx.sql.exec(
      'INSERT INTO todo_items (id, list_id, text, done, added_by, created_at) VALUES (?, ?, ?, 0, ?, ?)',
      [id, input.listId, input.text, ctx.principal, ctx.now()],
    );
    const row = ctx.sql.query<ItemRow>('SELECT * FROM todo_items WHERE id = ?', [id])[0]!;
    ctx.emit({
      type: 'todo.item-added',
      schemaVersion: 1,
      entity: { entityType: 'item', entityId: id },
      piiClass: 'none',
      payload: { id: row.id, list_id: row.list_id, text: row.text, added_by: row.added_by },
    });
    return row;
  },

  'todo/set-item-done': async (ctx, input) => {
    const { list } = itemAndList(ctx, input.itemId);
    assertAllowed(await ctx.check(TODO_PERM.listContribute, listRef(list.id)));
    ctx.sql.exec('UPDATE todo_items SET done = ? WHERE id = ?', [input.done ? 1 : 0, input.itemId]);
    const row = ctx.sql.query<ItemRow>('SELECT * FROM todo_items WHERE id = ?', [input.itemId])[0]!;
    ctx.emit({
      type: 'todo.item-done-changed',
      schemaVersion: 1,
      entity: { entityType: 'item', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, list_id: row.list_id, done: row.done },
    });
    return row;
  },

  /** Deleting is the owner's, which is what `list:manage` means here. */
  'todo/delete-item': async (ctx, input) => {
    const { list } = itemAndList(ctx, input.itemId);
    assertAllowed(await ctx.check(TODO_PERM.listManage, listRef(list.id)));
    ctx.sql.exec('DELETE FROM todo_items WHERE id = ?', [input.itemId]);
    ctx.emit({
      type: 'todo.item-deleted',
      schemaVersion: 1,
      entity: { entityType: 'item', entityId: input.itemId },
      piiClass: 'none',
      payload: { id: input.itemId },
    });
    return { id: input.itemId, deleted: true };
  },

  /**
   * Sharing — the whole point of the app, and one line of access control.
   *
   * `ctx.grant` narrows `list:contribute` onto THIS list for THIS person. It
   * delegates: the kernel re-checks that the caller holds it there, so an
   * operation can never hand out more than it was given. Nothing else in the
   * app has to remember that Björn may touch this list — the grant is the fact,
   * and every check reads it.
   */
  'todo/share-list': async (ctx, input) => {
    assertAllowed(await ctx.check(TODO_PERM.listManage, listRef(input.listId)));
    listOrThrow(ctx, input.listId);

    const invitee = ctx.sql.query<OwnerRow>('SELECT * FROM todo_owners WHERE email = ?', [
      input.email,
    ])[0];
    if (!invitee) throw substratError('not_found', `nobody here with that address: ${input.email}`);

    const existing = ctx.sql.query<ShareRow>(
      'SELECT * FROM todo_shares WHERE list_id = ? AND principal = ?',
      [input.listId, invitee.id],
    )[0];
    if (existing) return existing;

    const id = ulid();
    ctx.sql.exec(
      'INSERT INTO todo_shares (id, list_id, principal, email, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, input.listId, invitee.id, invitee.email, ctx.now()],
    );
    await ctx.grant(invitee.id as PrincipalId, TODO_PERM.listContribute, listRef(input.listId));

    const row = ctx.sql.query<ShareRow>('SELECT * FROM todo_shares WHERE id = ?', [id])[0]!;
    ctx.emit({
      type: 'todo.list-shared',
      schemaVersion: 1,
      entity: { entityType: 'share', entityId: row.id },
      piiClass: 'pseudonymous',
      subjectId: dataSubjectId.parse(row.principal),
      // The address cannot ride along: `share.email` is erasable, and an
      // immutable event is the one place an erasure cannot reach.
      payload: { id: row.id, list_id: row.list_id, principal: row.principal },
    });
    return row;
  },

  'todo/list-shares': async (ctx, input) => {
    assertAllowed(await ctx.check(TODO_PERM.listManage, listRef(input.listId)));
    return ctx.sql.query<ShareRow>(
      'SELECT * FROM todo_shares WHERE list_id = ? ORDER BY created_at, id',
      [input.listId],
    );
  },

  'todo/revoke-share': async (ctx, input) => {
    const share = ctx.sql.query<ShareRow>('SELECT * FROM todo_shares WHERE id = ?', [
      input.shareId,
    ])[0];
    if (!share) throw substratError('not_found', `share not found: ${input.shareId}`);
    assertAllowed(await ctx.check(TODO_PERM.listManage, listRef(share.list_id)));

    ctx.sql.exec('DELETE FROM todo_shares WHERE id = ?', [input.shareId]);
    await ctx.revoke(share.principal as PrincipalId, TODO_PERM.listContribute, listRef(share.list_id));
    ctx.emit({
      type: 'todo.share-revoked',
      schemaVersion: 1,
      entity: { entityType: 'share', entityId: share.id },
      piiClass: 'none',
      payload: { id: share.id },
    });
    return { id: share.id, revoked: true };
  },
} satisfies {
  // Derived by the platform, not restated here — `HandlerOutput` is what knows that a
  // `paged` declaration means the handler returns a Page of the declared entry.
  [K in keyof typeof todoOperations]: OperationHandler<
    HandlerInput<(typeof todoOperations)[K]>,
    HandlerOutput<(typeof todoOperations)[K]>
  >;
};

export const todoModule: ModuleRegistration = {
  manifest: todoManifest,
  migrations: todoMigrations,
  operations: operations as ModuleRegistration['operations'],
};
