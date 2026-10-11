/**
 * The saved-reply trash (#2161, K-45): a deleted canned answer goes to a bin first, and is
 * deleted for good 30 days later or when somebody empties it.
 *
 * Five rules, each driven with its positive twin:
 *
 *  - A BINNED REPLY IS GONE FROM THE LIBRARY. The list, the picker, every read and edit by id,
 *    and the two that reach a reply through a conversation (`render-`, `apply-saved-reply`,
 *    `alsoUsed`) answer `not_found`, as for an id naming nothing. Restored, it is all back.
 *  - WHO MAY BIN IT IS WHO MAY CHANGE IT. Its owner for a personal reply, `saved-reply:manage`
 *    for a shared one; a colleague's personal reply is `not_found` here as everywhere.
 *  - THE BIN FOLLOWS THE LIBRARY'S RULE. Shared or mine, never a colleague's.
 *  - A BINNED REPLY KEEPS ITS TITLE. Creating, renaming or sharing onto it is a `conflict`
 *    with reason `title_in_trash`, never the binned reply handed back as if it were listed.
 *  - THE HORIZON IS THE DESK'S. After 30 days the purge sweep deletes it, under a key no role
 *    holds and nobody but the sweep can use.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { permissionKey, platformActorId, type Page, type PrincipalId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { createClient } from '../app/src/api.generated.js';
import { mountApi } from '../src/routes.js';
import { createKit, TICKET0, type Desk } from './desk-kit.js';

const kit = createKit('ticket0-saved-reply-trash-');
afterAll(() => kit.dispose());

const DAY = 86_400_000;

interface SavedReply {
  id: string;
  title: string;
  owner: string | null;
  use_count: number;
}

type Named = Desk & { anna: PrincipalId; bo: PrincipalId };

async function freshDesk(): Promise<Named> {
  const desk = await kit.freshDesk({ agents: 2 });
  return { ...desk, anna: desk.agents[0]!, bo: desk.agents[1]! };
}

async function create(desk: Desk, who: PrincipalId, input: Record<string, unknown>): Promise<SavedReply> {
  return (await (await kit.as(desk, who)).invoke('ticket0/create-saved-reply', { body: 'Hi {{contact.name}}.', ...input })) as SavedReply;
}

const call = async (desk: Desk, who: PrincipalId, op: string, input: Record<string, unknown>) =>
  (await kit.as(desk, who)).invoke(`ticket0/${op}`, input);

const titles = async (desk: Desk, who: PrincipalId, op: 'list-saved-replies' | 'trashed-saved-replies') =>
  ((await call(desk, who, op, {})) as Page<SavedReply>).entries.map((r) => r.title);

const library = (desk: Desk, who: PrincipalId) => titles(desk, who, 'list-saved-replies');
const bin = (desk: Desk, who: PrincipalId) => titles(desk, who, 'trashed-saved-replies');

const sweep = (desk: Desk) => kit.host.runDueSchedules(TICKET0, desk.tenant, desk.scope);

const notFound = { code: 'not_found' };
const denied = { code: 'permission_denied' };

describe('a binned reply is gone from the library, and comes back whole', () => {
  it('leaves the list and every read and edit by id, then restores to exactly what it was', async () => {
    const desk = await freshDesk();
    const reply = await create(desk, desk.anna, { title: 'Refund', personal: true });
    const before = await call(desk, desk.anna, 'get-saved-reply', { savedReplyId: reply.id });

    expect(await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: reply.id })).toEqual({ id: reply.id, state: 'trashed' });
    expect(await library(desk, desk.anna)).toEqual([]);
    expect(await bin(desk, desk.anna)).toEqual(['Refund']);
    for (const [op, input] of [
      ['get-saved-reply', {}],
      ['update-saved-reply', { body: 'Changed.' }],
      ['share-saved-reply', {}],
      // Binned twice is not a second move: it is not there to move.
      ['trash-saved-reply', {}],
    ] as const) {
      await expect(call(desk, desk.anna, op, { savedReplyId: reply.id, ...input })).rejects.toMatchObject(notFound);
    }

    expect(await call(desk, desk.anna, 'restore-saved-reply', { savedReplyId: reply.id })).toEqual({ id: reply.id, state: 'active' });
    expect(await call(desk, desk.anna, 'get-saved-reply', { savedReplyId: reply.id })).toEqual(before);
    expect(await library(desk, desk.anna)).toEqual(['Refund']);
    expect(await bin(desk, desk.anna)).toEqual([]);
    // Restoring a reply that is not in the bin is a wrong move, not a silent no-op.
    await expect(call(desk, desk.anna, 'restore-saved-reply', { savedReplyId: reply.id })).rejects.toMatchObject({
      code: 'conflict',
      extensions: { reason: 'invalid_transition' },
    });
  });

  it('is not rendered or sent through a conversation, and counts nothing — until it is restored', async () => {
    const desk = await freshDesk();
    const conversation = await kit.mail(desk);
    const reply = await create(desk, desk.anna, { title: 'Greeting' });
    const other = await create(desk, desk.anna, { title: 'Sign-off' });
    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: reply.id });

    const render = { conversationId: conversation, savedReplyId: reply.id };
    await expect(call(desk, desk.anna, 'render-saved-reply', render)).rejects.toMatchObject(notFound);
    await expect(call(desk, desk.anna, 'apply-saved-reply', render)).rejects.toMatchObject(notFound);
    // Named as also used, it refuses the whole send, as a colleague's reply does.
    await expect(
      call(desk, desk.anna, 'apply-saved-reply', { conversationId: conversation, savedReplyId: other.id, alsoUsed: [reply.id] }),
    ).rejects.toMatchObject(notFound);
    expect(kit.events(desk, 'ticket0.saved-reply-applied')).toEqual([]);

    await call(desk, desk.anna, 'restore-saved-reply', { savedReplyId: reply.id });
    await call(desk, desk.anna, 'render-saved-reply', render);
    await call(desk, desk.anna, 'apply-saved-reply', { conversationId: conversation, savedReplyId: other.id, alsoUsed: [reply.id] });
    const counts = ((await call(desk, desk.anna, 'list-saved-replies', {})) as Page<SavedReply>).entries.map((r) => [r.title, r.use_count]);
    expect(counts).toEqual([
      ['Greeting', 1],
      ['Sign-off', 1],
    ]);
  });

  it('hands out no state column: a reply read back has exactly the fields it had before the bin', async () => {
    const desk = await freshDesk();
    const reply = await create(desk, desk.anna, { title: 'Fields', personal: true });
    const keys = Object.keys(reply).sort();
    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: reply.id });
    const [binned] = ((await call(desk, desk.anna, 'trashed-saved-replies', {})) as Page<SavedReply>).entries;
    expect(Object.keys(binned!).sort()).toEqual(keys);
    await call(desk, desk.anna, 'restore-saved-reply', { savedReplyId: reply.id });
    const read = await call(desk, desk.anna, 'get-saved-reply', { savedReplyId: reply.id });
    expect(Object.keys(read as object).sort()).toEqual(keys);
    expect(keys).not.toContain('_substrat_trashed_at');
  });

  it('announces the move by id alone, through the kernel, as whoever made it', async () => {
    const desk = await freshDesk();
    const reply = await create(desk, desk.anna, { title: 'Private wording', personal: true });
    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: reply.id });
    await call(desk, desk.anna, 'restore-saved-reply', { savedReplyId: reply.id });
    const moves = kit.sql(desk, (db) =>
      db
        .prepare(
          `SELECT type, actor, payload FROM _substrat_outbox
            WHERE entity_type = 'savedReply' AND entity_id = ? AND type IN ('entity.trashed', 'entity.restored') ORDER BY id`,
        )
        .all(reply.id),
    ) as { type: string; actor: string; payload: string }[];
    expect(moves.map((m) => m.type)).toEqual(['entity.trashed', 'entity.restored']);
    for (const m of moves) {
      expect(m.actor).toContain(desk.anna);
      expect(m.payload).not.toContain('Private wording');
    }
  });
});

describe('who may bin a reply is who may change it', () => {
  it('lets the owner bin a personal reply, and to a colleague it does not exist — binned or not', async () => {
    const desk = await freshDesk();
    const own = await create(desk, desk.anna, { title: 'Mine', personal: true });

    // Bo holds saved-reply:manage, and it does not matter: Anna's reply is Anna's.
    await expect(call(desk, desk.bo, 'trash-saved-reply', { savedReplyId: own.id })).rejects.toMatchObject(notFound);
    await expect(call(desk, desk.admin, 'trash-saved-reply', { savedReplyId: own.id })).rejects.toMatchObject(notFound);
    expect(await library(desk, desk.anna)).toEqual(['Mine']);

    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: own.id });
    for (const op of ['restore-saved-reply', 'delete-saved-reply', 'get-saved-reply'] as const) {
      await expect(call(desk, desk.bo, op, { savedReplyId: own.id })).rejects.toMatchObject(notFound);
    }
    expect(await bin(desk, desk.bo)).toEqual([]);
    expect(await bin(desk, desk.anna)).toEqual(['Mine']);
  });

  it('bins and restores a shared reply only with saved-reply:manage, which an assistant does not hold', async () => {
    const desk = await freshDesk();
    const shared = await create(desk, desk.anna, { title: 'Desk-wide' });
    const own = await create(desk, desk.assistant, { title: 'Bot’s', personal: true });

    await expect(call(desk, desk.assistant, 'trash-saved-reply', { savedReplyId: shared.id })).rejects.toMatchObject(denied);
    expect(await library(desk, desk.anna)).toEqual(['Desk-wide']);
    // Its own are its own, binned and restored without curation.
    await call(desk, desk.assistant, 'trash-saved-reply', { savedReplyId: own.id });
    await call(desk, desk.assistant, 'restore-saved-reply', { savedReplyId: own.id });

    // A colleague with the key bins the desk's reply; everyone who may use it sees it in the bin.
    await call(desk, desk.bo, 'trash-saved-reply', { savedReplyId: shared.id });
    expect(await bin(desk, desk.assistant)).toEqual(['Desk-wide']);
    expect(await bin(desk, desk.anna)).toEqual(['Desk-wide']);
    await expect(call(desk, desk.assistant, 'restore-saved-reply', { savedReplyId: shared.id })).rejects.toMatchObject(denied);
    await expect(call(desk, desk.assistant, 'delete-saved-reply', { savedReplyId: shared.id })).rejects.toMatchObject(denied);
    await call(desk, desk.admin, 'restore-saved-reply', { savedReplyId: shared.id });
    expect(await library(desk, desk.assistant)).toEqual(['Desk-wide', 'Bot’s']);
  });
});

describe('the bin is emptied for good by the person’s delete', () => {
  it('deletes a binned reply, which then cannot be restored, and still deletes an active one outright', async () => {
    const desk = await freshDesk();
    const binned = await create(desk, desk.anna, { title: 'Old', personal: true });
    const active = await create(desk, desk.anna, { title: 'Current', personal: true });
    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: binned.id });

    expect(await call(desk, desk.anna, 'delete-saved-reply', { savedReplyId: binned.id })).toEqual({ id: binned.id, title: 'Old' });
    expect(await bin(desk, desk.anna)).toEqual([]);
    await expect(call(desk, desk.anna, 'restore-saved-reply', { savedReplyId: binned.id })).rejects.toMatchObject(notFound);

    // A caller that deleted outright before the bin existed still does.
    expect(await call(desk, desk.anna, 'delete-saved-reply', { savedReplyId: active.id })).toEqual({ id: active.id, title: 'Current' });
    expect(await library(desk, desk.anna)).toEqual([]);
    expect(kit.events(desk, 'ticket0.saved-reply-deleted').map((e) => JSON.parse(e.payload))).toEqual([
      { id: binned.id },
      { id: active.id },
    ]);
  });
});

describe('a binned reply keeps its title', () => {
  it('refuses to create, rename or share onto it with title_in_trash, and frees it once deleted for good', async () => {
    const desk = await freshDesk();
    const shared = await create(desk, desk.anna, { title: 'Refund' });
    // The positive twin first: the same title from the same owner answers the listed reply.
    expect((await create(desk, desk.bo, { title: 'Refund' })).id).toBe(shared.id);

    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: shared.id });
    const inTrash = { code: 'conflict', extensions: { reason: 'title_in_trash' } };
    await expect(create(desk, desk.bo, { title: 'Refund' })).rejects.toMatchObject(inTrash);
    const other = await create(desk, desk.bo, { title: 'Returns' });
    await expect(call(desk, desk.bo, 'update-saved-reply', { savedReplyId: other.id, title: 'Refund' })).rejects.toMatchObject(inTrash);
    const mine = await create(desk, desk.bo, { title: 'Refund', personal: true });
    await expect(call(desk, desk.bo, 'share-saved-reply', { savedReplyId: mine.id })).rejects.toMatchObject(inTrash);

    // A listed reply holding the title is the plain conflict it always was.
    await expect(call(desk, desk.bo, 'update-saved-reply', { savedReplyId: other.id, title: 'Returns' })).resolves.toBeDefined();
    const listed = await create(desk, desk.bo, { title: 'Exchange' });
    const plain = call(desk, desk.bo, 'update-saved-reply', { savedReplyId: other.id, title: 'Exchange' });
    await expect(plain).rejects.toMatchObject({ code: 'conflict' });
    await expect(plain).rejects.not.toMatchObject(inTrash);
    expect(listed.title).toBe('Exchange');

    await call(desk, desk.anna, 'delete-saved-reply', { savedReplyId: shared.id });
    const again = await create(desk, desk.bo, { title: 'Refund' });
    expect(again.id).not.toBe(shared.id);
  });
});

describe('the bin’s 30-day horizon', () => {
  it('deletes a reply binned 30 days ago, as the desk, and leaves a younger one and a restored one alone', async () => {
    const desk = await freshDesk();
    const old = await create(desk, desk.anna, { title: 'Old', personal: true });
    const restored = await create(desk, desk.anna, { title: 'Second thoughts' });
    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: old.id });
    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: restored.id });
    kit.clock.advance(29 * DAY);
    const young = await create(desk, desk.anna, { title: 'Young', personal: true });
    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: young.id });
    await call(desk, desk.anna, 'restore-saved-reply', { savedReplyId: restored.id });

    // Day 29: nothing is due yet.
    expect(await sweep(desk)).toMatchObject({ failed: 0, errors: [] });
    expect(await bin(desk, desk.anna)).toEqual(['Old', 'Young']);

    kit.clock.advance(2 * DAY);
    expect(await sweep(desk)).toMatchObject({ failed: 0, errors: [] });
    expect(await bin(desk, desk.anna)).toEqual(['Young']);
    expect(await library(desk, desk.anna)).toEqual(['Second thoughts']);
    await expect(call(desk, desk.anna, 'restore-saved-reply', { savedReplyId: old.id })).rejects.toMatchObject(notFound);
    const deleted = kit.sql(desk, (db) =>
      db
        .prepare(`SELECT actor, payload FROM _substrat_outbox WHERE type = 'ticket0.saved-reply-deleted' AND entity_id = ?`)
        .all(old.id),
    );
    expect(deleted).toEqual([{ actor: JSON.stringify({ system: '@substrat-run/demo-ticket0' }), payload: JSON.stringify({ id: old.id }) }]);
  });

  it('is nobody’s key but the sweep’s: no role holds it, and the desk’s own principal cannot use it outside a purge', async () => {
    const desk = await freshDesk();
    const reply = await create(desk, desk.anna, { title: 'Binned', personal: true });
    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: reply.id });
    for (const who of [desk.anna, desk.admin]) {
      await expect(call(desk, who, 'purge-saved-reply', { savedReplyId: reply.id })).rejects.toMatchObject(denied);
    }
    await expect((await kit.system(desk)).invoke('ticket0/purge-saved-reply', { savedReplyId: reply.id })).rejects.toMatchObject(denied);
    expect(await bin(desk, desk.anna)).toEqual(['Binned']);
  });

  it('purges only a binned reply, even for a caller granted the key directly', async () => {
    const desk = await freshDesk();
    const active = await create(desk, desk.anna, { title: 'Still in use', personal: true });
    const binned = await create(desk, desk.anna, { title: 'Binned', personal: true });
    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: binned.id });
    // Not through any role: a grant of the purge key, straight onto the principal.
    await kit.host.admin.grant(platformActorId.parse(ulid()), {
      principalId: desk.bo,
      permission: permissionKey.parse('saved-reply:purge'),
      node: { tenantId: desk.tenant, scopeId: desk.scope },
      grantedBy: desk.admin,
    });

    // An active reply is not the bin's to delete, whoever holds the key.
    await expect(call(desk, desk.bo, 'purge-saved-reply', { savedReplyId: active.id })).rejects.toMatchObject(notFound);
    expect(await library(desk, desk.anna)).toEqual(['Still in use']);

    // A binned one inside its horizon is not: one day in the bin is nowhere near thirty.
    kit.clock.advance(1 * DAY);
    await expect(call(desk, desk.bo, 'purge-saved-reply', { savedReplyId: binned.id })).rejects.toMatchObject(notFound);
    expect(await bin(desk, desk.anna)).toEqual(['Binned']);

    // Past its horizon it is, as the sweep deletes it.
    kit.clock.advance(30 * DAY);
    expect(await call(desk, desk.bo, 'purge-saved-reply', { savedReplyId: binned.id })).toEqual({ id: binned.id, title: 'Binned' });
    expect(await bin(desk, desk.anna)).toEqual([]);
    expect(await library(desk, desk.anna)).toEqual(['Still in use']);
  });

  it('on a desk not yet holding the purge tuple, purges nothing and loses nothing — the reply stays in the bin', async () => {
    const desk = await freshDesk();
    // As a desk provisioned before the bin is, until the provision reconcile seats the key.
    kit.revokeSystemGrant(desk, 'saved-reply:purge');
    // With nothing due, the sweep has nothing to do and nothing fails.
    expect(await sweep(desk)).toMatchObject({ failed: 0, errors: [] });

    const reply = await create(desk, desk.anna, { title: 'Kept', personal: true });
    await call(desk, desk.anna, 'trash-saved-reply', { savedReplyId: reply.id });
    kit.clock.advance(31 * DAY);
    const report = await sweep(desk);
    expect(report.failed).toBe(1);
    expect(await bin(desk, desk.anna)).toEqual(['Kept']);
    // And the owner can still take it back.
    await call(desk, desk.anna, 'restore-saved-reply', { savedReplyId: reply.id });
    expect(await library(desk, desk.anna)).toEqual(['Kept']);
  });
});

describe('over HTTP, as the settings screen calls it', () => {
  it('moves to the trash, lists the bin at its own path, restores, and answers 404 for a colleague', async () => {
    const desk = await freshDesk();
    let caller: PrincipalId = desk.anna;
    const app = new Hono();
    mountApi(app, async () => kit.host.getScope(caller, desk.tenant, desk.scope));
    const req = (method: string, path: string) => app.request(`/api${path}`, { method });

    const reply = await create(desk, desk.anna, { title: 'Over the wire', personal: true });
    expect(await (await req('POST', `/saved-replies/${reply.id}/trash`)).json()).toEqual({ id: reply.id, state: 'trashed' });
    // A static segment, so the bin is never read as a reply whose id is "trash".
    const listed = (await (await req('GET', '/saved-replies/trash')).json()) as SavedReply[];
    expect(listed.map((r) => r.id)).toEqual([reply.id]);
    expect((await req('GET', `/saved-replies/${reply.id}`)).status).toBe(404);

    caller = desk.bo;
    expect((await req('POST', `/saved-replies/${reply.id}/restore`)).status).toBe(404);

    caller = desk.anna;
    expect((await req('POST', `/saved-replies/${reply.id}/restore`)).status).toBe(200);
    expect((await req('GET', `/saved-replies/${reply.id}`)).status).toBe(200);
  });
});

describe('through the generated client, as the picker holds it', () => {
  /** The client the app builds, wired to the real routes, as one person. */
  const clientFor = (desk: Desk, who: PrincipalId) => {
    const app = new Hono();
    mountApi(app, async () => kit.host.getScope(who, desk.tenant, desk.scope));
    return createClient({ fetch: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch });
  };

  it('deletes for good a reply it edited and then moved to the trash, with no 412', async () => {
    const desk = await freshDesk();
    const api = clientFor(desk, desk.anna);
    const reply = await api.createSavedReply({ title: 'Edited, then binned', body: 'Hi.', personal: true });
    // Edit: the read arms the guard, the save moves the tag the client holds.
    await api.getSavedReply({ savedReplyId: reply.id });
    await api.updateSavedReply({ savedReplyId: reply.id, body: 'Hello.' });
    // The picker's Move to trash. The client keeps the tag the save handed back: a move leaves
    // the version where it was (#2191), so the tag is still current.
    await api.trashSavedReply({ savedReplyId: reply.id });
    expect(api.versions.has(`savedReply:${reply.id}`)).toBe(true);
    // Delete for good from the trash pane, sent with that tag.
    await expect(api.deleteSavedReply({ savedReplyId: reply.id })).resolves.toEqual({ id: reply.id, title: 'Edited, then binned' });
  });

  it('edits a reply restored after an edit, with no 412', async () => {
    const desk = await freshDesk();
    const api = clientFor(desk, desk.anna);
    const reply = await api.createSavedReply({ title: 'Back again', body: 'Hi.', personal: true });
    await api.getSavedReply({ savedReplyId: reply.id });
    await api.updateSavedReply({ savedReplyId: reply.id, body: 'Hello.' });
    await api.trashSavedReply({ savedReplyId: reply.id });
    await api.restoreSavedReply({ savedReplyId: reply.id });
    await expect(api.updateSavedReply({ savedReplyId: reply.id, body: 'Hello again.' })).resolves.toMatchObject({ body: 'Hello again.' });
  });

  it('refuses my delete for good over a colleague’s restore, edit and re-bin', async () => {
    const desk = await freshDesk();
    const anna = clientFor(desk, desk.anna);
    const bo = clientFor(desk, desk.bo);
    const reply = await anna.createSavedReply({ title: 'Binned, rescued, binned', body: 'Hi.' });
    await anna.getSavedReply({ savedReplyId: reply.id });
    await anna.updateSavedReply({ savedReplyId: reply.id, body: 'Hello.' });
    await anna.trashSavedReply({ savedReplyId: reply.id });
    // Bo takes it back out, rewrites it, and bins it again.
    await bo.restoreSavedReply({ savedReplyId: reply.id });
    await bo.getSavedReply({ savedReplyId: reply.id });
    await bo.updateSavedReply({ savedReplyId: reply.id, body: 'Bo’s wording.' });
    await bo.trashSavedReply({ savedReplyId: reply.id });
    // Anna's held tag predates Bo's edit, so her delete for good is refused rather than taking it.
    await expect(anna.deleteSavedReply({ savedReplyId: reply.id })).rejects.toMatchObject({ status: 412 });
    await bo.restoreSavedReply({ savedReplyId: reply.id });
    expect((await bo.getSavedReply({ savedReplyId: reply.id })).body).toBe('Bo’s wording.');
  });

  it('still refuses a delete over a colleague’s edit when nothing was moved', async () => {
    const desk = await freshDesk();
    const anna = clientFor(desk, desk.anna);
    const bo = clientFor(desk, desk.bo);
    const reply = await anna.createSavedReply({ title: 'Shared, edited twice', body: 'Hi.' });
    await anna.getSavedReply({ savedReplyId: reply.id });
    await bo.getSavedReply({ savedReplyId: reply.id });
    await bo.updateSavedReply({ savedReplyId: reply.id, body: 'Bo’s wording.' });
    await expect(anna.deleteSavedReply({ savedReplyId: reply.id })).rejects.toMatchObject({ status: 412 });
    expect((await bo.getSavedReply({ savedReplyId: reply.id })).body).toBe('Bo’s wording.');
  });
});
