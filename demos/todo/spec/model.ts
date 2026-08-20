/**
 * Todo's model — what exists, declared once (#697/#707).
 *
 * The concept is approved (`spec/concept.md`); this is its entity and operation
 * surface, and everything downstream is derived from it: the migrations, the
 * manifest, the route table, the permission registry, the API document.
 *
 * This vertical composes **no engine**. Nothing here has an invariant beyond
 * "you cannot touch a list nobody shared with you", and that one is the
 * platform's. An absent `engines` argument is a fact about the app, not an
 * omission.
 */
import {
  defineEntities,
  defineOperations,
  emitModel,
  LIST_PAGE_MAX,
  z,
} from '@substrat-run/contracts';
import { MAX_SEARCH_LIMIT } from '@substrat-run/kernel';

/**
 * How much wider than the answer the handlers ask the index for.
 *
 * Every search here filters hits AFTER ranking — by list, or by which lists the
 * caller reaches — and a ranked top-N filtered afterwards returns fewer than N.
 * Asking for more is the only defence.
 */
export const SEARCH_OVERFETCH = 4;

/**
 * This vertical's own cap, and deliberately NOT the kernel's.
 *
 * `ctx.search` clamps every ask to `MAX_SEARCH_LIMIT`, so a caller allowed to
 * request the ceiling leaves the over-fetch no headroom at all: the ask and the
 * answer become the same number and the filter above eats into the result. Deriving
 * the bound keeps the two from drifting apart — raise the ceiling and this follows.
 */
export const TODO_SEARCH_MAX = Math.floor(MAX_SEARCH_LIMIT / SEARCH_OVERFETCH);

export const todoEntities = defineEntities({
  /**
   * A person who has an account in this scope — the thing their lists hang off.
   *
   * It exists because ownership has to be reachable by the permission walk. A
   * list's owner cannot be a grant made by the operation that creates it:
   * `ctx.grant` delegates what the caller already holds, and nobody holds
   * anything on a list that did not exist a moment ago. So the grant is made
   * once, per person, on THIS entity when they join, and every list they create
   * links to it. The walk reaches list → owner and the answer follows.
   *
   * `id` is the principal id. One row per person, not per login.
   */
  owner: {
    table: 'todo_owners',
    fields: z.object({
      id: z.string(),
      email: z.string(),
      display_name: z.string(),
      created_at: z.string(),
    }),
    key: ['email'],
    erasable: ['email', 'display_name'],
  },

  /** A list. Private to its owner until a share exists for someone else. */
  list: {
    table: 'todo_lists',
    fields: z.object({
      id: z.string(),
      owner_id: z.string(),
      name: z.string(),
      created_at: z.string(),
    }),
    parents: ['owner'],
  },

  /**
   * An item on a list. `done` is a number because SQLite has no boolean and the
   * row comes back as 0/1 — declaring `z.boolean()` here would emit the same
   * INTEGER column while promising the reader a type the database cannot return.
   */
  item: {
    table: 'todo_items',
    fields: z.object({
      id: z.string(),
      list_id: z.string(),
      text: z.string(),
      done: z.number(),
      added_by: z.string(),
      created_at: z.string(),
    }),
    parents: ['list'],
  },

  /**
   * One person's access to one list.
   *
   * The email is here because the sharing screen promises "shared with
   * björn@example.com" and principals are opaque ids — a promised string with no
   * source table is a missing table. It is the only directly personal field in
   * the app, so it is `erasable`, which also makes it uncarryable by any event.
   *
   * `key` is the composite it reads as: one share per person per list.
   */
  share: {
    table: 'todo_shares',
    fields: z.object({
      id: z.string(),
      list_id: z.string(),
      principal: z.string(),
      email: z.string(),
      created_at: z.string(),
    }),
    parents: ['list'],
    key: ['list_id', 'principal'],
    erasable: ['email'],
  },
});

/**
 * Three keys, and the split is the app's whole permission model.
 *
 * - `list:create` is held scope-wide by every member. It is the only one that
 *   can be, because creating a list is the one act with no entity to narrow to.
 * - `list:manage` and `list:contribute` are granted per person on their OWN
 *   `owner` entity when they join, and reach their lists through the declared
 *   parent edge. Nobody holds either one scope-wide, which is what makes one
 *   member's lists unreachable to another.
 * - Sharing narrows `list:contribute` onto ONE list for one person, so what
 *   Björn may do is a fact about *that list* rather than about Björn.
 */
export const TODO_PERMISSIONS = ['list:create', 'list:manage', 'list:contribute'] as const;

export const todoOperations = defineOperations(todoEntities, TODO_PERMISSIONS)({
  /**
   * Claim your account in this scope — the row every list hangs off.
   *
   * It exists because ownership is an entity, and an entity needs a moment it
   * comes into being. Self-service and idempotent: joining twice is joining.
   */
  'todo/join': {
    summary: 'Claim your account in this workspace',
    permission: 'list:create',
    input: z.object({ email: z.string().email(), displayName: z.string().min(1) }),
    output: todoEntities.owner.fields,
    http: { method: 'POST', path: '/join' },
    emits: {
      entity: 'owner',
      entityIdFrom: 'id',
      type: 'todo.owner-joined',
      schemaVersion: 1,
      piiClass: 'pseudonymous',
      subjectId: 'id',
      // `email` and `display_name` are erasable, so neither can ride here.
      payload: ['id'],
    },
  },

  'todo/create-list': {
    summary: 'Create a list',
    permission: 'list:create',
    input: z.object({ name: z.string().min(1) }),
    output: todoEntities.list.fields,
    http: { method: 'POST', path: '/lists' },
    emits: {
      entity: 'list',
      entityIdFrom: 'id',
      type: 'todo.list-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'name', 'owner_id'],
    },
  },

  /**
   * The proof walk. Owned lists and shared-with lists arrive in one answer, and
   * a list nobody shared is not in it — filtered by a per-entity check, never by
   * a WHERE clause on ownership.
   */
  'todo/my-lists': {
    summary: 'List the lists you own or have been shared',
    narrows: {
      reason: 'Returns only lists the caller owns or has been shared',
      checks: ['list:contribute'],
    },
    output: z.array(todoEntities.list.fields),
    http: { method: 'GET', path: '/lists' },
  },

  'todo/rename-list': {
    summary: 'Rename a list',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), name: z.string().min(1) }),
    output: todoEntities.list.fields,
    http: { method: 'PATCH', path: '/lists/{listId}' },
    emits: {
      entity: 'list',
      entityIdFrom: 'id',
      type: 'todo.list-renamed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'name'],
    },
  },

  'todo/delete-list': {
    summary: 'Delete a list and everything on it',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string() }),
    output: z.object({ id: z.string(), deleted: z.boolean() }),
    http: { method: 'DELETE', path: '/lists/{listId}' },
    emits: {
      entity: 'list',
      entityIdFrom: 'id',
      type: 'todo.list-deleted',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },

  'todo/list-items': {
    summary: 'The items on a list',
    permission: { key: 'list:contribute', entity: 'list', idFrom: 'listId' },
    input: z.object({
      listId: z.string(),
      limit: z.number().int().positive().max(LIST_PAGE_MAX).optional(),
      cursor: z.string().optional(),
    }),
    // The ENTRY, not the envelope: `paged` is what wraps it, here and in the document.
    output: todoEntities.item.fields,
    // A list's items are the one table here that grows without bound — one per line of
    // shopping, forever. Keyset over the ULID id, which is creation-ordered for free.
    // `total` because the app renders a count beside the list; it costs a second
    // query per request, which is why it is asked for rather than assumed.
    paged: { sortKey: 'id', total: true },
    http: { method: 'GET', path: '/lists/{listId}/items' },
  },

  /**
   * Search on ONE list (#827) — the read that `paged` above took away.
   *
   * Filtering `list-items` in the browser searched whatever page had loaded, which
   * at forty items looked like search and at four thousand looked like a bug. This
   * asks the index instead.
   *
   * A separate operation rather than a `q` on `list-items`: that read is sorted and
   * paged, this one is ranked and capped, and one endpoint cannot carry both
   * contracts. `GET /lists/{listId}/items/search` does not collide with the paged
   * read — `mountOperations` registers a static segment ahead of its parameter
   * sibling (#785).
   *
   * Permission is the ordinary entity-narrowed one: the caller either reaches this
   * list or they do not, and one check settles it.
   */
  'todo/search-list-items': {
    summary: 'Find items on a list by text',
    permission: { key: 'list:contribute', entity: 'list', idFrom: 'listId' },
    input: z.object({
      listId: z.string(),
      // Two characters is the prefix index's floor. Declared here so a short term is
      // a 400 naming the field, not a throw from inside the kernel.
      q: z.string().min(2),
      limit: z.number().int().positive().max(TODO_SEARCH_MAX).optional(),
    }),
    // Not a bare array: a capped read has to say it was capped, or the screen shows
    // the first twenty of two hundred matches as though that were all of them.
    output: z.object({
      results: z.array(todoEntities.item.fields),
      limit: z.number().int(),
      capped: z.boolean(),
    }),
    http: { method: 'GET', path: '/lists/{listId}/items/search' },
  },

  /**
   * Search across every list the caller can reach — "where did I put milk?".
   *
   * The same `narrows` shape as `my-lists`, and for the same reason: nobody holds
   * `list:contribute` scope-wide, so the answer is assembled by asking, per list,
   * whether this caller reaches it. The index is scope-wide and checks nothing —
   * `ctx.search` never does — so the filter after it is what keeps one member's
   * items out of another's results.
   *
   * The trap here is real and documented (concepts/reads.md): a ranked top-N
   * filtered afterwards returns FEWER than N. The handler over-fetches on purpose.
   */
  'todo/search-items': {
    summary: 'Find items across the lists you can see',
    narrows: {
      reason: 'Returns only items on lists the caller owns or has been shared',
      checks: ['list:contribute'],
    },
    input: z.object({
      q: z.string().min(2),
      limit: z.number().int().positive().max(TODO_SEARCH_MAX).optional(),
    }),
    output: z.object({
      results: z.array(todoEntities.item.fields),
      limit: z.number().int(),
      capped: z.boolean(),
    }),
    http: { method: 'GET', path: '/items/search' },
  },

  'todo/add-item': {
    summary: 'Add an item to a list',
    permission: { key: 'list:contribute', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), text: z.string().min(1) }),
    output: todoEntities.item.fields,
    http: { method: 'POST', path: '/lists/{listId}/items' },
    emits: {
      entity: 'item',
      entityIdFrom: 'id',
      type: 'todo.item-added',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'list_id', 'text', 'added_by'],
    },
  },

  /** Ticking is reversible, so this sets the state rather than completing. */
  'todo/set-item-done': {
    summary: 'Tick an item off, or put it back',
    // The id is not in the input: the check is on the LIST this item sits on.
    permission: { key: 'list:contribute', entity: 'list', resolved: 'the list the item is on' },
    input: z.object({ itemId: z.string(), done: z.boolean() }),
    output: todoEntities.item.fields,
    http: { method: 'POST', path: '/items/{itemId}/done' },
    emits: {
      entity: 'item',
      entityIdFrom: 'id',
      type: 'todo.item-done-changed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'list_id', 'done'],
    },
  },

  'todo/delete-item': {
    summary: 'Delete an item',
    permission: { key: 'list:manage', entity: 'list', resolved: 'the list the item is on' },
    input: z.object({ itemId: z.string() }),
    output: z.object({ id: z.string(), deleted: z.boolean() }),
    http: { method: 'DELETE', path: '/items/{itemId}' },
    emits: {
      entity: 'item',
      entityIdFrom: 'id',
      type: 'todo.item-deleted',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },

  /**
   * Sharing. The event is about a share, whose subject is a person, so it is
   * classified and keyed — and the address itself cannot ride along, because
   * `share.email` is erasable. `principal` is what an erasure would key on.
   */
  'todo/share-list': {
    summary: 'Share a list with someone by email',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), email: z.string().email() }),
    output: todoEntities.share.fields,
    http: { method: 'POST', path: '/lists/{listId}/shares' },
    emits: {
      entity: 'share',
      entityIdFrom: 'id',
      type: 'todo.list-shared',
      schemaVersion: 1,
      piiClass: 'pseudonymous',
      subjectId: 'principal',
      payload: ['id', 'list_id', 'principal'],
    },
  },

  /**
   * Who a list is shared with. Owner-only: the members of a share are the
   * owner's business, not each other's.
   */
  'todo/list-shares': {
    summary: 'Who this list is shared with',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string() }),
    output: z.array(todoEntities.share.fields),
    http: { method: 'GET', path: '/lists/{listId}/shares' },
  },

  'todo/revoke-share': {
    summary: 'Revoke someone’s access to a list',
    permission: { key: 'list:manage', entity: 'list', resolved: 'the list the share is on' },
    input: z.object({ shareId: z.string() }),
    output: z.object({ id: z.string(), revoked: z.boolean() }),
    http: { method: 'DELETE', path: '/shares/{shareId}' },
    emits: {
      entity: 'share',
      entityIdFrom: 'id',
      type: 'todo.share-revoked',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },
});

export const todoModel = emitModel(todoEntities);
