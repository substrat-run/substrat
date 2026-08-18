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
import { defineEntities, defineOperations, emitModel } from '@substrat-run/contracts';
import { z } from 'zod';

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
   * Uniqueness (one share per person per list) is enforced in the handler rather
   * than declared: `key` emits one UNIQUE per named field, so `['list_id',
   * 'principal']` would mean "a list may be shared once, ever" and "a person may
   * receive one share, ever" — two wrong constraints instead of the composite.
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
    input: z.object({ listId: z.string() }),
    output: z.array(todoEntities.item.fields),
    http: { method: 'GET', path: '/lists/{listId}/items' },
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
