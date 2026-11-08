/**
 * Shared Lists — what exists, declared once. Behaviour (who may delete whose
 * items, the seed cast) stays prose in spec/concept.md.
 *
 * No engine is composed. Invites by email (engine-invites) handle joining the
 * workspace; sharing a list is an owner operation naming someone who joined.
 */
import { defineEntities, defineOperations, emitModel, z } from '@substrat-run/contracts';

export const entities = defineEntities({
  /**
   * A person with an account in this scope; their lists hang off them, so the
   * permission walk reaches list → person. `id` is the principal id.
   */
  person: {
    table: 'lists_people',
    fields: z.object({
      id: z.string(),
      email: z.string(),
      display_name: z.string(),
      created_at: z.string(),
    }),
    key: ['email'],
    erasable: ['email', 'display_name'],
  },

  /** A list, private to its owner until a share exists. */
  list: {
    table: 'lists_lists',
    fields: z.object({
      id: z.string(),
      owner_id: z.string(),
      name: z.string(),
      created_at: z.string(),
    }),
    parents: ['person'],
  },

  /** An item. `done` is 0/1 because SQLite has no boolean. */
  item: {
    table: 'lists_items',
    fields: z.object({
      id: z.string(),
      list_id: z.string(),
      text: z.string(),
      done: z.number(),
      done_by: z.string().nullable(),
      created_by: z.string(),
      created_at: z.string(),
    }),
    parents: ['list'],
  },

  /** One person's access to one list (grants cannot be listed). */
  share: {
    table: 'lists_shares',
    fields: z.object({
      id: z.string(),
      list_id: z.string(),
      principal: z.string(),
      email: z.string(),
      shared_by: z.string(),
      created_at: z.string(),
    }),
    parents: ['list'],
    key: ['list_id', 'principal'],
    erasable: ['email'],
  },
  invite: {
    table: 'lists_invites',
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
});

/**
 * - `list:create` is scope-wide for every member.
 * - `list:manage` is held by a person on their own `person` entity and reaches
 *   their lists through the parent edge: rename, delete, share, delete any item.
 * - `list:contribute` is held by owners the same way, and by a collaborator
 *   narrowed onto ONE list by a share: see it, add, tick, edit/delete own items.
 */
export const PERMISSIONS = ['list:create', 'list:manage', 'list:contribute'] as const;

const deleted = z.object({ id: z.string(), deleted: z.boolean() });

export const operations = defineOperations(entities, PERMISSIONS)({
  /** The address is the issuer's verified one (`ctx.verifiedEmail`), never input: sharing finds people by it. */
  'lists/join': {
    summary: 'Claim your account in this workspace',
    permission: 'list:create',
    input: z.object({ displayName: z.string().min(1) }),
    output: entities.person.fields,
    http: { method: 'POST', path: '/join' },
    emits: {
      entity: 'person',
      entityIdFrom: 'id',
      type: 'lists.person-joined',
      schemaVersion: 1,
      piiClass: 'pseudonymous',
      subjectId: 'id',
      payload: ['id'],
    },
  },

  'lists/create-list': {
    summary: 'Create a list',
    permission: 'list:create',
    input: z.object({ name: z.string().min(1) }),
    output: entities.list.fields,
    http: { method: 'POST', path: '/lists' },
    emits: {
      entity: 'list',
      entityIdFrom: 'id',
      type: 'lists.list-created',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'name', 'owner_id'],
    },
  },

  'lists/my-lists': {
    summary: 'Lists you own or have been shared',
    narrows: {
      reason: 'Returns only lists the caller owns or has been shared',
      checks: ['list:contribute'],
    },
    input: z.object({}),
    output: entities.list.fields,
    paged: { over: { entity: 'list', sortable: ['created_at', 'name'] } },
    http: { method: 'GET', path: '/lists' },
  },

  'lists/rename-list': {
    summary: 'Rename a list',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), name: z.string().min(1) }),
    output: entities.list.fields,
    http: { method: 'PUT', path: '/lists/{listId}' },
    emits: {
      entity: 'list',
      entityIdFrom: 'id',
      type: 'lists.list-renamed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'name'],
    },
  },

  'lists/delete-list': {
    summary: 'Delete a list with its items and shares',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string() }),
    output: deleted,
    http: { method: 'DELETE', path: '/lists/{listId}' },
    emits: {
      entity: 'list',
      entityIdFrom: 'id',
      type: 'lists.list-deleted',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },

  'lists/list-items': {
    summary: 'The items on a list',
    derive: 'list',
    permission: { key: 'list:contribute', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), done: z.number().int().min(0).max(1).optional() }),
    output: entities.item.fields,
    paged: {
      over: { entity: 'item', sortable: ['id', 'text'], filterable: ['list_id', 'done'] },
      total: true,
    },
    http: { method: 'GET', path: '/lists/{listId}/items' },
  },

  'lists/add-item': {
    summary: 'Add an item to a list',
    permission: { key: 'list:contribute', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), text: z.string().min(1) }),
    output: entities.item.fields,
    http: { method: 'POST', path: '/lists/{listId}/items' },
    emits: {
      entity: 'item',
      entityIdFrom: 'id',
      type: 'lists.item-added',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'list_id', 'created_by'],
    },
  },

  'lists/edit-item': {
    summary: 'Change an item’s text (own items; the owner may edit any)',
    permission: { key: 'list:contribute', entity: 'list', resolved: 'the list the item is on' },
    input: z.object({ itemId: z.string(), text: z.string().min(1) }),
    output: entities.item.fields,
    http: { method: 'PUT', path: '/items/{itemId}' },
    emits: {
      entity: 'item',
      entityIdFrom: 'id',
      type: 'lists.item-edited',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'list_id'],
    },
  },

  'lists/set-item-done': {
    summary: 'Tick an item off, or put it back',
    permission: { key: 'list:contribute', entity: 'list', resolved: 'the list the item is on' },
    input: z.object({ itemId: z.string(), done: z.boolean() }),
    output: entities.item.fields,
    http: { method: 'POST', path: '/items/{itemId}/done' },
    emits: {
      entity: 'item',
      entityIdFrom: 'id',
      type: 'lists.item-done-changed',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'list_id', 'done', 'done_by'],
    },
  },

  'lists/delete-item': {
    summary: 'Delete an item (own items; the owner may delete any)',
    permission: { key: 'list:contribute', entity: 'list', resolved: 'the list the item is on' },
    input: z.object({ itemId: z.string() }),
    output: deleted,
    http: { method: 'DELETE', path: '/items/{itemId}' },
    emits: {
      entity: 'item',
      entityIdFrom: 'id',
      type: 'lists.item-deleted',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },

  'lists/share-list': {
    summary: 'Share a list with someone who has joined, by email',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), email: z.string().email() }),
    output: entities.share.fields,
    http: { method: 'POST', path: '/lists/{listId}/shares' },
    emits: {
      entity: 'share',
      entityIdFrom: 'id',
      type: 'lists.list-shared',
      schemaVersion: 1,
      piiClass: 'pseudonymous',
      subjectId: 'principal',
      payload: ['id', 'list_id', 'principal', 'shared_by'],
    },
  },

  'lists/invite': {
    summary: 'Invite someone to a list by email; if they have joined, share it at once',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string(), email: z.string().email() }),
    output: z.object({ status: z.enum(['shared', 'invited']), id: z.string(), email: z.string() }),
    http: { method: 'POST', path: '/lists/{listId}/invites' },
    emits: {
      entity: 'invite',
      entityIdFrom: 'id',
      type: 'lists.invite-sent',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },

  'lists/list-invites': {
    summary: 'Who is invited to this list and has not joined yet (owner only)',
    derive: 'list',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string() }),
    output: entities.invite.fields,
    paged: { over: { entity: 'invite', sortable: ['created_at'], filterable: ['list_id'] } },
    http: { method: 'GET', path: '/lists/{listId}/invites' },
  },

  'lists/cancel-invite': {
    summary: 'Withdraw an invitation',
    permission: { key: 'list:manage', entity: 'list', resolved: 'the list the invite is on' },
    input: z.object({ inviteId: z.string() }),
    output: z.object({ id: z.string(), cancelled: z.boolean() }),
    http: { method: 'DELETE', path: '/invites/{inviteId}' },
    emits: {
      entity: 'invite',
      entityIdFrom: 'id',
      type: 'lists.invite-cancelled',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },

  'lists/list-shares': {
    summary: 'Who this list is shared with (owner only)',
    derive: 'list',
    permission: { key: 'list:manage', entity: 'list', idFrom: 'listId' },
    input: z.object({ listId: z.string() }),
    output: entities.share.fields,
    paged: { over: { entity: 'share', sortable: ['created_at'], filterable: ['list_id'] } },
    http: { method: 'GET', path: '/lists/{listId}/shares' },
  },

  'lists/revoke-share': {
    summary: 'Remove someone’s access to a list',
    permission: { key: 'list:manage', entity: 'list', resolved: 'the list the share is on' },
    input: z.object({ shareId: z.string() }),
    output: z.object({ id: z.string(), revoked: z.boolean() }),
    http: { method: 'DELETE', path: '/shares/{shareId}' },
    emits: {
      entity: 'share',
      entityIdFrom: 'id',
      type: 'lists.share-revoked',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id'],
    },
  },
});

export const model = emitModel(entities, { operations });
