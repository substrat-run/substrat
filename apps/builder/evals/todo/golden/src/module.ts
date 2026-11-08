import {
  dataSubjectId,
  pageVisible,
  substratError,
  z,
  type EntityRow,
  type PrincipalId,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  operationsFor,
  requestEmail,
  ulid,
  type ConsumerHandler,
  type ModuleRegistration,
  type OperationContext,
} from '@substrat-run/kernel';
import { entities, operations } from '../spec/model.js';
import { LISTS_PERM, listsManifest } from './manifest.js';
import { listsMigrations } from './migrations.js';

type PersonRow = EntityRow<typeof entities, 'person'>;
type ListRow = EntityRow<typeof entities, 'list'>;
type ItemRow = EntityRow<typeof entities, 'item'>;
type ShareRow = EntityRow<typeof entities, 'share'>;

const listRef = (id: string) => ({ entityType: 'list', entityId: id });

function listOrThrow(ctx: OperationContext, id: string): ListRow {
  const row = ctx.sql.query<ListRow>('SELECT * FROM lists_lists WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `list not found: ${id}`);
  return row;
}

function itemOrThrow(ctx: OperationContext, id: string): ItemRow {
  const row = ctx.sql.query<ItemRow>('SELECT * FROM lists_items WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `item not found: ${id}`);
  return row;
}

const itemById = (ctx: OperationContext, id: string) =>
  ctx.sql.query<ItemRow>('SELECT * FROM lists_items WHERE id = ?', [id])[0]!;

/**
 * Edit/delete rule: contribute on the list, and either the item is yours or you manage the list.
 * Throws the kernel's permission-denied for a collaborator touching the owner's item.
 */
async function assertMayChangeItem(ctx: OperationContext, item: ItemRow): Promise<void> {
  assertAllowed(await ctx.check(LISTS_PERM.listContribute, listRef(item.list_id)));
  if (item.created_by === ctx.principal) return;
  assertAllowed(await ctx.check(LISTS_PERM.listManage, listRef(item.list_id)));
}

interface InviteRow {
  id: string;
  list_id: string;
  email: string;
  invited_by: string;
  created_at: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const personByEmail = (ctx: OperationContext, email: string): PersonRow | undefined =>
  ctx.sql.query<PersonRow>('SELECT * FROM lists_people WHERE email = ? COLLATE NOCASE', [email])[0];

/** One share, with its grant and event. `sharedBy` is who decided it, also when a consumer writes it. */
async function shareWith(ctx: OperationContext, listId: string, person: PersonRow, sharedBy: string): Promise<ShareRow> {
  const existing = ctx.sql.query<ShareRow>('SELECT * FROM lists_shares WHERE list_id = ? AND principal = ?', [
    listId,
    person.id,
  ])[0];
  if (existing) return existing;

  const id = ulid();
  ctx.sql.exec(
    'INSERT INTO lists_shares (id, list_id, principal, email, shared_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, listId, person.id, person.email, sharedBy, ctx.now()],
  );
  await ctx.grant(person.id as PrincipalId, LISTS_PERM.listContribute, listRef(listId));

  const row = ctx.sql.query<ShareRow>('SELECT * FROM lists_shares WHERE id = ?', [id])[0]!;
  ctx.emit({
    type: 'lists.list-shared',
    schemaVersion: 1,
    entity: { entityType: 'share', entityId: row.id },
    piiClass: 'pseudonymous',
    subjectId: dataSubjectId.parse(row.principal),
    payload: { id: row.id, list_id: row.list_id, principal: row.principal, shared_by: row.shared_by },
  });
  return row;
}

/**
 * Someone joined: their open invitations become shares. A consumer, because a grant delegates:
 * the person joining holds nothing on the list, and the owner decided this when they invited.
 */
const shareInvitedLists: ConsumerHandler = async (ctx, event) => {
  const { id } = z.object({ id: z.string() }).parse(event.payload);
  const person = ctx.sql.query<PersonRow>('SELECT * FROM lists_people WHERE id = ?', [id])[0];
  if (!person) return;
  const invites = ctx.sql.query<InviteRow>('SELECT * FROM lists_invites WHERE email = ? COLLATE NOCASE', [person.email]);
  for (const invite of invites) {
    await shareWith(ctx, invite.list_id, person, invite.invited_by);
    ctx.sql.exec('DELETE FROM lists_invites WHERE id = ?', [invite.id]);
  }
};

const bound = operationsFor(operations)({
  'lists/join': async (ctx, input) => {
    assertAllowed(await ctx.check(LISTS_PERM.listCreate));
    const existing = ctx.sql.query<PersonRow>('SELECT * FROM lists_people WHERE id = ?', [
      ctx.principal,
    ])[0];
    if (existing) return existing;
    // Sharing finds a person by this address, so it is the issuer's word for it (K-61) and
    // never something the caller typed.
    if (ctx.verifiedEmail === null) {
      throw substratError('permission_denied', 'joining needs a verified email address');
    }
    ctx.sql.exec(
      'INSERT INTO lists_people (id, email, display_name, created_at) VALUES (?, ?, ?, ?)',
      [ctx.principal, ctx.verifiedEmail, input.displayName, ctx.now()],
    );
    const row = ctx.sql.query<PersonRow>('SELECT * FROM lists_people WHERE id = ?', [
      ctx.principal,
    ])[0]!;
    ctx.emit({
      type: 'lists.person-joined',
      schemaVersion: 1,
      entity: { entityType: 'person', entityId: row.id },
      piiClass: 'pseudonymous',
      subjectId: dataSubjectId.parse(row.id),
      payload: { id: row.id },
    });
    return row;
  },

  'lists/create-list': async (ctx, input) => {
    assertAllowed(await ctx.check(LISTS_PERM.listCreate));
    const person = ctx.sql.query<PersonRow>('SELECT * FROM lists_people WHERE id = ?', [
      ctx.principal,
    ])[0];
    if (!person)
      throw substratError('precondition_failed', 'no account here — join before creating a list');
    const id = ulid();
    ctx.sql.exec(
      'INSERT INTO lists_lists (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)',
      [id, person.id, input.name, ctx.now()],
    );
    ctx.link(listRef(id), { entityType: 'person', entityId: person.id });
    const row = listOrThrow(ctx, id);
    ctx.emit({
      type: 'lists.list-created',
      schemaVersion: 1,
      entity: listRef(id),
      piiClass: 'none',
      payload: { id: row.id, name: row.name, owner_id: row.owner_id },
    });
    return row;
  },

  'lists/my-lists': async (ctx, input) =>
    pageVisible(
      (p) => ctx.page<ListRow>('list', { ...input, ...p }),
      input,
      async (list) => (await ctx.check(LISTS_PERM.listContribute, listRef(list.id))).allowed,
      { continuation: ctx.pageContinuation('list:my-lists', input) },
    ),

  'lists/rename-list': async (ctx, input) => {
    assertAllowed(await ctx.check(LISTS_PERM.listManage, listRef(input.listId)));
    listOrThrow(ctx, input.listId);
    ctx.sql.exec('UPDATE lists_lists SET name = ? WHERE id = ?', [input.name, input.listId]);
    const row = listOrThrow(ctx, input.listId);
    ctx.emit({
      type: 'lists.list-renamed',
      schemaVersion: 1,
      entity: listRef(row.id),
      piiClass: 'none',
      payload: { id: row.id, name: row.name },
    });
    return row;
  },

  'lists/delete-list': async (ctx, input) => {
    assertAllowed(await ctx.check(LISTS_PERM.listManage, listRef(input.listId)));
    listOrThrow(ctx, input.listId);
    ctx.sql.exec('DELETE FROM lists_items WHERE list_id = ?', [input.listId]);
    ctx.sql.exec('DELETE FROM lists_shares WHERE list_id = ?', [input.listId]);
    ctx.sql.exec('DELETE FROM lists_lists WHERE id = ?', [input.listId]);
    ctx.emit({
      type: 'lists.list-deleted',
      schemaVersion: 1,
      entity: listRef(input.listId),
      piiClass: 'none',
      payload: { id: input.listId },
    });
    return { id: input.listId, deleted: true };
  },

  // `lists/list-items` and `lists/list-shares` are `derive: 'list'`: kernel-composed.

  'lists/add-item': async (ctx, input) => {
    assertAllowed(await ctx.check(LISTS_PERM.listContribute, listRef(input.listId)));
    listOrThrow(ctx, input.listId);
    const id = ulid();
    ctx.sql.exec(
      'INSERT INTO lists_items (id, list_id, text, done, done_by, created_by, created_at) VALUES (?, ?, ?, 0, NULL, ?, ?)',
      [id, input.listId, input.text, ctx.principal, ctx.now()],
    );
    const row = itemById(ctx, id);
    ctx.emit({
      type: 'lists.item-added',
      schemaVersion: 1,
      entity: { entityType: 'item', entityId: id },
      piiClass: 'none',
      payload: { id: row.id, list_id: row.list_id, created_by: row.created_by },
    });
    return row;
  },

  'lists/edit-item': async (ctx, input) => {
    const item = itemOrThrow(ctx, input.itemId);
    await assertMayChangeItem(ctx, item);
    ctx.sql.exec('UPDATE lists_items SET text = ? WHERE id = ?', [input.text, item.id]);
    const row = itemById(ctx, item.id);
    ctx.emit({
      type: 'lists.item-edited',
      schemaVersion: 1,
      entity: { entityType: 'item', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, list_id: row.list_id },
    });
    return row;
  },

  'lists/set-item-done': async (ctx, input) => {
    const item = itemOrThrow(ctx, input.itemId);
    assertAllowed(await ctx.check(LISTS_PERM.listContribute, listRef(item.list_id)));
    ctx.sql.exec('UPDATE lists_items SET done = ?, done_by = ? WHERE id = ?', [
      input.done ? 1 : 0,
      input.done ? ctx.principal : null,
      item.id,
    ]);
    const row = itemById(ctx, item.id);
    ctx.emit({
      type: 'lists.item-done-changed',
      schemaVersion: 1,
      entity: { entityType: 'item', entityId: row.id },
      piiClass: 'none',
      payload: { id: row.id, list_id: row.list_id, done: row.done, done_by: row.done_by },
    });
    return row;
  },

  'lists/delete-item': async (ctx, input) => {
    const item = itemOrThrow(ctx, input.itemId);
    await assertMayChangeItem(ctx, item);
    ctx.sql.exec('DELETE FROM lists_items WHERE id = ?', [item.id]);
    ctx.emit({
      type: 'lists.item-deleted',
      schemaVersion: 1,
      entity: { entityType: 'item', entityId: item.id },
      piiClass: 'none',
      payload: { id: item.id },
    });
    return { id: item.id, deleted: true };
  },

  'lists/share-list': async (ctx, input) => {
    assertAllowed(await ctx.check(LISTS_PERM.listManage, listRef(input.listId)));
    listOrThrow(ctx, input.listId);
    const invitee = personByEmail(ctx, input.email);
    if (!invitee) throw substratError('not_found', `nobody here with that address: ${input.email}`);
    return await shareWith(ctx, input.listId, invitee, ctx.principal);
  },

  'lists/invite': async (ctx, input) => {
    assertAllowed(await ctx.check(LISTS_PERM.listManage, listRef(input.listId)));
    // A grant delegates, but the share an invitation becomes is made by a consumer, where nothing
    // re-checks the inviter. So what they hand on is asked here, whether or not the address has joined.
    assertAllowed(await ctx.check(LISTS_PERM.listContribute, listRef(input.listId)));
    const list = listOrThrow(ctx, input.listId);
    const invitee = personByEmail(ctx, input.email);
    if (invitee) {
      const share = await shareWith(ctx, input.listId, invitee, ctx.principal);
      return { status: 'shared' as const, id: share.id, email: share.email };
    }
    const open = ctx.sql.query<InviteRow>('SELECT * FROM lists_invites WHERE list_id = ? AND email = ?', [
      input.listId,
      input.email,
    ])[0];
    if (open) return { status: 'invited' as const, id: open.id, email: open.email };

    const id = ulid();
    ctx.sql.exec(
      'INSERT INTO lists_invites (id, list_id, email, invited_by, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, input.listId, input.email, ctx.principal, ctx.now()],
    );
    // In this transaction: an operation that fails after this line sends nothing.
    requestEmail(ctx, {
      to: input.email,
      subject: `You have been invited to the list ${list.name}`,
      text: `You have been invited to the list ${list.name}. Sign in with this address to open it.`,
      html: `<p>You have been invited to the list <strong>${escapeHtml(list.name)}</strong>.</p><p>Sign in with this address to open it.</p>`,
      about: { entityType: 'invite', entityId: id },
    });
    ctx.emit({
      type: 'lists.invite-sent',
      schemaVersion: 1,
      entity: { entityType: 'invite', entityId: id },
      piiClass: 'none',
      payload: { id },
    });
    return { status: 'invited' as const, id, email: input.email };
  },

  'lists/cancel-invite': async (ctx, input) => {
    const invite = ctx.sql.query<InviteRow>('SELECT * FROM lists_invites WHERE id = ?', [input.inviteId])[0];
    if (!invite) throw substratError('not_found', `invite not found: ${input.inviteId}`);
    assertAllowed(await ctx.check(LISTS_PERM.listManage, listRef(invite.list_id)));
    ctx.sql.exec('DELETE FROM lists_invites WHERE id = ?', [invite.id]);
    ctx.emit({
      type: 'lists.invite-cancelled',
      schemaVersion: 1,
      entity: { entityType: 'invite', entityId: invite.id },
      piiClass: 'none',
      payload: { id: invite.id },
    });
    return { id: invite.id, cancelled: true };
  },

  'lists/revoke-share': async (ctx, input) => {
    const share = ctx.sql.query<ShareRow>('SELECT * FROM lists_shares WHERE id = ?', [
      input.shareId,
    ])[0];
    if (!share) throw substratError('not_found', `share not found: ${input.shareId}`);
    assertAllowed(await ctx.check(LISTS_PERM.listManage, listRef(share.list_id)));
    ctx.sql.exec('DELETE FROM lists_shares WHERE id = ?', [share.id]);
    await ctx.revoke(share.principal as PrincipalId, LISTS_PERM.listContribute, listRef(share.list_id));
    ctx.emit({
      type: 'lists.share-revoked',
      schemaVersion: 1,
      entity: { entityType: 'share', entityId: share.id },
      piiClass: 'none',
      payload: { id: share.id },
    });
    return { id: share.id, revoked: true };
  },
});

export const listsModule: ModuleRegistration = {
  manifest: listsManifest,
  migrations: listsMigrations,
  ...bound,
  consumers: { 'lists.person-joined': shareInvitedLists },
};
