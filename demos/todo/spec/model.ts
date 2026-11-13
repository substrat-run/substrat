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
  entityStateOutput,
  personResolveInput,
  personResolveOutput,
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

  /**
   * A list. Private to its owner until a share exists for someone else.
   *
   * Archivable and trashable (#119), each under its own key: filing a finished list away and
   * putting one in the bin are different acts, and an owner may be given one without the
   * other. The kernel adds the two columns and leaves archived and binned lists out of
   * `my-lists` unless they are asked for.
   *
   * A list left in the bin for 30 days is deleted for good, by `delete-list` — the same
   * delete a person empties the bin with, so its items and shares go with it exactly as they
   * would by hand.
   */
  list: {
    table: 'todo_lists',
    fields: z.object({
      id: z.string(),
      owner_id: z.string(),
      name: z.string(),
      created_at: z.string(),
    }),
    parents: ['owner'],
    archive: { permission: 'list:archive' },
    trash: { permission: 'list:trash', purgeAfterDays: 30 },
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

  /**
   * An address invited to a list, until that person joins. Its own entity rather than a share
   * with no principal, because a share IS a person's access and this is nobody's yet.
   */
  invite: {
    table: 'todo_invites',
    fields: z.object({
      id: z.string(),
      list_id: z.string(),
      email: z.string(),
      invited_by: z.string(),
      created_at: z.string(),
    }),
    parents: ['list'],
    key: ['list_id', 'email'],
    erasable: ['email'],
  },

  /**
   * A member who may use this workspace's plugins: the other apps of the tenant that take their
   * people from here. A row is the access, and removing it takes the access away.
   *
   * Its own entity rather than a column on `owner`, because it is a decision somebody else made
   * about a person, with its own author and date. `id` is the member's `owner` id.
   */
  access: {
    table: 'todo_plugin_access',
    fields: z.object({
      id: z.string(),
      granted_by: z.string(),
      created_at: z.string(),
    }),
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
 *
 * Two more are about people rather than lists. `people:manage` is the workspace admin's:
 * who may use the plugins. `people:resolve` is held by no person at all: a plugin holds it,
 * as a peer, to ask who somebody signing in to it is.
 */
export const TODO_PERMISSIONS = [
  'list:create',
  'list:manage',
  'list:contribute',
  'list:archive',
  'list:trash',
  'people:manage',
  'people:resolve',
] as const;

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
    input: z.object({ displayName: z.string().min(1) }),
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
    // #119: the active lists unless the archive is asked for. The bin is its own read,
    // `trashed-lists`, because who may look in it is a different question.
    input: z.object({ view: z.enum(['active', 'archived']).optional() }),
    output: todoEntities.list.fields,
    // #811. The underlying walk IS kernel-composed — `created_at` with the id
    // tie-break is exactly the `ORDER BY created_at, id` this shipped with — but
    // visibility is decided by a per-row proof walk on top of it, so the handler
    // walks with `pageVisible`, whose continuation hides the examined position (#2074).
    // A short page can still carry a continuation at the scan budget.
    paged: { over: { entity: 'list', sortable: ['created_at', 'name'] } },
    http: { method: 'GET', path: '/lists' },
  },

  'todo/rename-list': {
    summary: 'Rename a list',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), name: z.string().min(1) }),
    output: todoEntities.list.fields,
    http: { method: 'PATCH', path: '/lists/{listId}' },
    patchException: 'This rename command requires a name; its handler writes only name.',
    emits: {
      entity: 'list',
      entityIdFrom: 'id',
      type: 'todo.list-renamed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'name'],
    },
  },

  /**
   * File a list away (#119). It leaves `my-lists` and stays readable — through the archive
   * view, and by anyone it is shared with. The kernel checks `list:archive` on the list itself,
   * so this cannot be done under `list:manage`.
   *
   * The four moves and the bin are DERIVED (#1773): each is the check and one kernel verb, so the
   * platform writes them from the `archive` / `trash` declaration on `list`, and todo writes none.
   */
  'todo/archive-list': {
    summary: 'Archive a list',
    derive: 'archive',
    permission: { key: 'list:archive', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string() }),
    output: entityStateOutput,
    http: { method: 'POST', path: '/lists/{listId}/archive' },
  },

  'todo/unarchive-list': {
    summary: 'Bring an archived list back',
    derive: 'unarchive',
    permission: { key: 'list:archive', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string() }),
    output: entityStateOutput,
    http: { method: 'POST', path: '/lists/{listId}/unarchive' },
  },

  /**
   * Put a list in the bin (#119) — the delete a person can take back. Its items and shares
   * are untouched, so a restore brings the whole list back as it was; `delete-list` is still
   * the delete that cannot be undone.
   */
  'todo/trash-list': {
    summary: 'Move a list to the trash',
    derive: 'trash',
    permission: { key: 'list:trash', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string() }),
    output: entityStateOutput,
    http: { method: 'POST', path: '/lists/{listId}/trash' },
  },

  /** Take a list out of the bin, back to where it was — archived, if it was archived. */
  'todo/restore-list': {
    summary: 'Restore a list from the trash',
    derive: 'restore',
    permission: { key: 'list:trash', entity: 'list', idFrom: 'listId' },
    // The one operation besides the delete that reaches a binned list; every other is refused
    // `not_found` by the host before it runs.
    trashed: 'admits',
    input: z.object({ listId: z.string() }),
    output: entityStateOutput,
    http: { method: 'POST', path: '/lists/{listId}/restore' },
  },

  /**
   * What is in YOUR bin. The kernel checks `list:trash` on every list it reads here, so a
   * list somebody else binned never shows, however it reached the walk.
   */
  'todo/trashed-lists': {
    summary: 'The lists in your trash',
    derive: 'trashed',
    narrows: {
      reason: 'Returns only binned lists the caller may restore',
      checks: ['list:trash'],
    },
    output: todoEntities.list.fields,
    paged: { over: { entity: 'list', sortable: ['created_at', 'name'] } },
    http: { method: 'GET', path: '/lists/trash' },
  },

  'todo/delete-list': {
    summary: 'Delete a list and everything on it',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    // The permanent delete: it empties the bin, and it is what the 30-day horizon runs.
    trashed: 'purges',
    // Strict: a purge's parsed input is the id and nothing else (#119).
    input: z.strictObject({ listId: z.string() }),
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
    // Kernel-composed: the WHERE, the keyset walk, the count and the indexes behind them are
    // derived from `paged.over`, so there is no handler to keep in step with this declaration.
    derive: 'list',
    permission: { key: 'list:contribute', entity: 'list', idFrom: 'listId' },
    // `limit` and `cursor` are NOT declared here: since #811 the platform parses
    // the page trio with the one shared schema and merges it into the input, so
    // the default and the `LIST_PAGE_MAX` ceiling are true of every paged read
    // rather than of the ones whose author remembered to restate them.
    //
    // `done` is the one filter a person asks of a long list — what is left to do — and an
    // equality on a declared column, so the kernel indexes it rather than the handler
    // scanning. A number because SQLite has no boolean (see the entity).
    input: z.object({ listId: z.string(), done: z.number().int().min(0).max(1).optional() }),
    // The ENTRY, not the envelope: `paged` is what wraps it, here and in the document.
    output: todoEntities.item.fields,
    // A list's items are the one table here that grows without bound — one per line of
    // shopping, forever. Keyset over the ULID id by default, which is creation-ordered
    // for free and keeps every cursor handed out before this was kernel-composed valid
    // (a walk whose sort is the id carries the id alone). `text` sorts alphabetically.
    // `total` because the app renders a count beside the list; it costs a second
    // query per request, which is why it is asked for rather than assumed.
    paged: { over: { entity: 'item', sortable: ['id', 'text'], filterable: ['list_id', 'done'] }, total: true },
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

  /**
   * Find one of your lists by name — the search beside `my-lists`, for when there are
   * more lists than one page shows.
   *
   * The same `narrows` walk as `my-lists`, over search hits instead of every row: the
   * index is scope-wide and checks nothing, so the per-list check after it is what keeps
   * someone else's list out of the answer. Active lists only — the kernel leaves archived
   * and binned rows out of `ctx.search`, as it does out of `ctx.page`.
   */
  'todo/search-lists': {
    summary: 'Find your lists by name',
    narrows: {
      reason: 'Returns only lists the caller owns or has been shared',
      checks: ['list:contribute'],
    },
    input: z.object({
      q: z.string().min(2),
      limit: z.number().int().positive().max(TODO_SEARCH_MAX).optional(),
    }),
    output: z.object({
      results: z.array(todoEntities.list.fields),
      limit: z.number().int(),
      capped: z.boolean(),
    }),
    http: { method: 'GET', path: '/lists/search' },
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
   * Invite an address to a list. Someone who has joined gets the share at once; anyone else gets
   * an email, and the share when they join. `status` says which, because the sharing screen
   * shows the two differently.
   */
  'todo/invite': {
    summary: 'Invite someone to a list by email',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), email: z.string().email() }),
    output: z.object({ status: z.enum(['shared', 'invited']), id: z.string(), email: z.string() }),
    http: { method: 'POST', path: '/lists/{listId}/invites' },
    emits: {
      entity: 'invite',
      entityIdFrom: 'id',
      type: 'todo.invite-sent',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },

  /** Who is invited and has not joined yet. Owner-only, as `list-shares` is. */
  'todo/list-invites': {
    summary: 'Who is invited to this list and has not joined',
    derive: 'list',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string() }),
    output: todoEntities.invite.fields,
    paged: { over: { entity: 'invite', sortable: ['created_at'], filterable: ['list_id'] } },
    http: { method: 'GET', path: '/lists/{listId}/invites' },
  },

  'todo/cancel-invite': {
    summary: 'Withdraw an invitation',
    permission: { key: 'list:manage', entity: 'list', resolved: 'the list the invite is on' },
    input: z.object({ inviteId: z.string() }),
    output: z.object({ id: z.string(), cancelled: z.boolean() }),
    http: { method: 'DELETE', path: '/invites/{inviteId}' },
    emits: {
      entity: 'invite',
      entityIdFrom: 'id',
      type: 'todo.invite-cancelled',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },

  /**
   * Who a list is shared with. Owner-only: the members of a share are the
   * owner's business, not each other's.
   */
  'todo/list-shares': {
    summary: 'Who this list is shared with',
    derive: 'list',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string() }),
    output: todoEntities.share.fields,
    // A share list is short in every plausible app and unbounded all the same —
    // one row per person a list is shared with, and nothing caps that. `list_id`
    // is the filter the route already narrows by, declared so the kernel composes
    // it and indexes `(list_id, created_at, id)` behind it.
    paged: { over: { entity: 'share', sortable: ['created_at'], filterable: ['list_id'] } },
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

  /**
   * The workspace's members, each with whether they may use its plugins: the admin's screen for
   * deciding plugin access. Members only, never list invitations, which are no person yet.
   */
  'todo/list-members': {
    summary: 'The workspace’s members, and which of them may use its plugins',
    permission: 'people:manage',
    output: todoEntities.owner.fields.extend({ plugin_access: z.boolean() }),
    paged: { over: { entity: 'owner', sortable: ['created_at', 'display_name'] } },
    http: { method: 'GET', path: '/members' },
  },

  /**
   * Let a member use the plugins. Idempotent: a member who has access keeps the row they have.
   * The event is about a person, so it is classified and keyed on them.
   */
  'todo/grant-plugin-access': {
    summary: 'Let a member use this workspace’s plugins',
    permission: 'people:manage',
    input: z.object({ memberId: z.string() }),
    output: todoEntities.access.fields,
    http: { method: 'POST', path: '/members/{memberId}/plugin-access' },
    emits: {
      entity: 'access',
      entityIdFrom: 'id',
      type: 'todo.plugin-access-granted',
      schemaVersion: 1,
      piiClass: 'pseudonymous',
      subjectId: 'id',
      payload: ['id'],
    },
  },

  /**
   * Take it away again. A plugin learns of it the next time it asks about the person, which is
   * within the time it keeps an answer for.
   */
  'todo/revoke-plugin-access': {
    summary: 'Stop a member using this workspace’s plugins',
    permission: 'people:manage',
    input: z.object({ memberId: z.string() }),
    output: z.object({ id: z.string(), revoked: z.boolean() }),
    http: { method: 'DELETE', path: '/members/{memberId}/plugin-access' },
    emits: {
      entity: 'access',
      entityIdFrom: 'id',
      type: 'todo.plugin-access-revoked',
      schemaVersion: 1,
      piiClass: 'pseudonymous',
      subjectId: 'id',
      payload: ['id'],
    },
  },

  /**
   * The person contract (`identity.person@1`): who is this login, asked by a plugin when
   * somebody signs in to it. The shapes are the contract's own, so a plugin written against
   * the contract works against this app unchanged.
   *
   * No `http`: it is called through the peer door and nowhere else, and `people:resolve` is
   * held by the peers the manifest names, never by a person.
   */
  'todo/resolve-person': {
    summary: 'Who a login is here, for a plugin of this workspace',
    permission: 'people:resolve',
    input: personResolveInput,
    output: personResolveOutput,
  },
});

export const todoModel = emitModel(todoEntities, { operations: todoOperations });
