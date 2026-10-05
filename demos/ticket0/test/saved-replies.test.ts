/**
 * Saved replies as a library (#1087): whose a reply is, where it is filed, and how often
 * it is actually sent.
 *
 * Three rules, each driven in both directions:
 *
 *  - USE IS COUNTED ON SEND. `apply-saved-reply` moves the count in the transaction that
 *    writes the message, so a preview, an insert or a refused send counts nothing, and a
 *    sent message counts each reply it used exactly once. Every id it is handed is
 *    resolved by the server, as a reply the caller may use, in this desk.
 *  - A PERSONAL REPLY IS ITS OWNER'S ALONE. To anybody else, desk-admin included, it is
 *    `not_found` on every operation, the answer an id naming nothing gets.
 *  - THE SHARED LIBRARY IS CURATED. Adding to it, changing it, and its folders need
 *    `saved-reply:manage`, which the assistant roles do not hold.
 *
 * Plus migration 0025, on a desk that has replies from before it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { platformActorId, scopeId, tenantId, type Page, type PrincipalId } from '@substrat-run/contracts';
import { ulid, type ScopeStub } from '@substrat-run/kernel';
import { ticket0Manifest } from '../src/manifest.js';
import { MODULES } from '../src/provision.js';
import { mountApi } from '../src/routes.js';
import { listsBefore0025 } from './before-0025.js';
import { createKit, type Desk } from './desk-kit.js';

const kit = createKit('ticket0-saved-replies-');
afterAll(() => kit.dispose());

interface SavedReply {
  id: string;
  title: string;
  body: string;
  owner: string | null;
  folder_id: string | null;
  use_count: number;
  last_used_at: string | null;
}

interface Folder {
  id: string;
  name: string;
}

/** The kit's desk, with its first two agents named for the scenarios that tell them apart. */
type Named = Desk & { anna: PrincipalId; bo: PrincipalId };

async function freshDesk(): Promise<Named> {
  const desk = await kit.freshDesk({ agents: 2 });
  return { ...desk, anna: desk.agents[0]!, bo: desk.agents[1]! };
}

const as = (desk: Desk, who: PrincipalId): Promise<ScopeStub> => kit.as(desk, who);
const mail = (desk: Desk): Promise<string> => kit.mail(desk);

async function create(desk: Desk, who: PrincipalId, input: Record<string, unknown>): Promise<SavedReply> {
  return (await (await as(desk, who)).invoke('ticket0/create-saved-reply', { body: 'Hi {{contact.name}}.', ...input })) as SavedReply;
}

async function get(desk: Desk, who: PrincipalId, id: string): Promise<SavedReply> {
  return (await (await as(desk, who)).invoke('ticket0/get-saved-reply', { savedReplyId: id })) as SavedReply;
}

async function listed(desk: Desk, who: PrincipalId, input: Record<string, unknown> = {}): Promise<SavedReply[]> {
  return ((await (await as(desk, who)).invoke('ticket0/list-saved-replies', input)) as Page<SavedReply>).entries;
}

async function messageCount(desk: Desk, conversationId: string): Promise<number> {
  const page = (await (await as(desk, desk.admin)).invoke('ticket0/list-messages', { conversationId })) as Page<unknown>;
  return page.entries.length;
}

/** Every event of this type on the desk's spine, payload parsed. */
const events = (desk: Desk, type: string): Record<string, unknown>[] =>
  kit.events(desk, type).map((e) => JSON.parse(e.payload) as Record<string, unknown>);

const notFound = { code: 'not_found' };
const denied = { code: 'permission_denied' };
const conflict = { code: 'conflict' };

describe('use is counted when a message is sent, and only then', () => {
  it('counts nothing for a preview or a read, and exactly one per sent message', async () => {
    const desk = await freshDesk();
    const conversation = await mail(desk);
    const reply = await create(desk, desk.anna, { title: 'Greeting' });
    const anna = await as(desk, desk.anna);

    // Previewing is not using: the agent may read it and pick another.
    await anna.invoke('ticket0/render-saved-reply', { conversationId: conversation, savedReplyId: reply.id });
    await anna.invoke('ticket0/get-saved-reply', { savedReplyId: reply.id });
    expect(await get(desk, desk.anna, reply.id)).toMatchObject({ use_count: 0, last_used_at: null });

    await anna.invoke('ticket0/apply-saved-reply', { conversationId: conversation, savedReplyId: reply.id, body: 'Hi Kim.' });
    const once = await get(desk, desk.anna, reply.id);
    expect(once.use_count).toBe(1);
    expect(once.last_used_at).not.toBeNull();

    // A note is a sent message too, and so is a second send.
    await anna.invoke('ticket0/apply-saved-reply', {
      conversationId: conversation,
      savedReplyId: reply.id,
      visibility: 'internal',
    });
    expect((await get(desk, desk.anna, reply.id)).use_count).toBe(2);
  });

  it('counts nothing when the send is refused', async () => {
    const desk = await freshDesk();
    const conversation = await mail(desk);
    // Everything in it resolves to nothing for a contact with no name, so it cannot send.
    const empty = await create(desk, desk.anna, { title: 'Empty', body: '{{agent.signature}}' });
    await expect(
      (await as(desk, desk.anna)).invoke('ticket0/apply-saved-reply', { conversationId: conversation, savedReplyId: empty.id }),
    ).rejects.toThrow(/renders to nothing/);
    expect((await get(desk, desk.anna, empty.id)).use_count).toBe(0);
  });

  it('counts each reply named in alsoUsed once, and runs none of their actions', async () => {
    const desk = await freshDesk();
    const conversation = await mail(desk);
    const main = await create(desk, desk.anna, { title: 'Answer' });
    const greeting = await create(desk, desk.anna, { title: 'Greeting' });
    const urgent = await create(desk, desk.anna, {
      title: 'Escalate',
      actions: [{ type: 'set-priority', priority: 'urgent' }],
    });

    const applied = (await (await as(desk, desk.anna)).invoke('ticket0/apply-saved-reply', {
      conversationId: conversation,
      savedReplyId: main.id,
      body: 'Hello. Here is the answer.',
      // Duplicates and the macro itself: each reply is counted once per message.
      alsoUsed: [greeting.id, urgent.id, greeting.id, main.id],
    })) as { also_used: string[]; actions: string[]; conversation: { priority: string } };

    expect(applied.also_used).toEqual([greeting.id, urgent.id]);
    expect(applied.actions).toEqual([]);
    expect(applied.conversation.priority).toBe('normal');
    for (const r of [main, greeting, urgent]) expect((await get(desk, desk.anna, r.id)).use_count, r.title).toBe(1);
    expect(events(desk, 'ticket0.saved-reply-applied').at(-1)).toMatchObject({
      saved_reply_id: main.id,
      also_used: [greeting.id, urgent.id],
    });
  });

  it('refuses the whole send when alsoUsed names a reply the caller may not use, and counts nothing', async () => {
    const desk = await freshDesk();
    const conversation = await mail(desk);
    const main = await create(desk, desk.anna, { title: 'Answer' });
    const bosOwn = await create(desk, desk.bo, { title: 'Bo’s own', personal: true });
    const before = await messageCount(desk, conversation);

    await expect(
      (await as(desk, desk.anna)).invoke('ticket0/apply-saved-reply', {
        conversationId: conversation,
        savedReplyId: main.id,
        alsoUsed: [bosOwn.id],
      }),
    ).rejects.toMatchObject(notFound);
    expect(await messageCount(desk, conversation)).toBe(before);
    expect((await get(desk, desk.anna, main.id)).use_count).toBe(0);
    expect((await get(desk, desk.bo, bosOwn.id)).use_count).toBe(0);

    // The positive twin: Bo may name his own.
    await (await as(desk, desk.bo)).invoke('ticket0/apply-saved-reply', {
      conversationId: conversation,
      savedReplyId: main.id,
      alsoUsed: [bosOwn.id],
    });
    expect((await get(desk, desk.bo, bosOwn.id)).use_count).toBe(1);
  });

  it('stays inside its desk: another desk’s reply is not one this desk can count', async () => {
    const a = await freshDesk();
    const b = await freshDesk();
    const conversation = await mail(a);
    const inA = await create(a, a.anna, { title: 'Answer' });
    const inB = await create(b, b.anna, { title: 'Answer' });

    // Desk B's id, handed to desk A, names nothing there: as the macro, and in alsoUsed.
    await expect(
      (await as(a, a.anna)).invoke('ticket0/apply-saved-reply', { conversationId: conversation, savedReplyId: inB.id }),
    ).rejects.toMatchObject(notFound);
    await expect(
      (await as(a, a.anna)).invoke('ticket0/apply-saved-reply', {
        conversationId: conversation,
        savedReplyId: inA.id,
        alsoUsed: [inB.id],
      }),
    ).rejects.toMatchObject(notFound);
    expect((await get(a, a.anna, inA.id)).use_count).toBe(0);

    await (await as(a, a.anna)).invoke('ticket0/apply-saved-reply', { conversationId: conversation, savedReplyId: inA.id });
    expect((await get(a, a.anna, inA.id)).use_count).toBe(1);
    // The same title in the other desk is another reply, and nobody used it.
    expect((await get(b, b.anna, inB.id)).use_count).toBe(0);
  });
});

describe('a personal reply is its owner’s alone', () => {
  it('is listed for its owner and nobody else; a shared one is listed for everyone', async () => {
    const desk = await freshDesk();
    const shared = await create(desk, desk.anna, { title: 'Desk-wide' });
    const own = await create(desk, desk.anna, { title: 'Mine', personal: true });
    expect(shared.owner).toBeNull();
    expect(own.owner).toBe(desk.anna);

    expect((await listed(desk, desk.anna)).map((r) => r.id)).toEqual([shared.id, own.id]);
    for (const who of [desk.bo, desk.admin, desk.assistant]) {
      expect((await listed(desk, who)).map((r) => r.id), who).toEqual([shared.id]);
    }
  });

  it('is not_found to anybody else on every operation, desk-admin included', async () => {
    const desk = await freshDesk();
    const conversation = await mail(desk);
    const own = await create(desk, desk.anna, { title: 'Mine', personal: true });
    for (const who of [desk.bo, desk.admin]) {
      const stub = await as(desk, who);
      const attempts: [string, Record<string, unknown>][] = [
        ['ticket0/get-saved-reply', { savedReplyId: own.id }],
        ['ticket0/update-saved-reply', { savedReplyId: own.id, body: 'Mine now.' }],
        ['ticket0/delete-saved-reply', { savedReplyId: own.id }],
        ['ticket0/share-saved-reply', { savedReplyId: own.id }],
        ['ticket0/render-saved-reply', { conversationId: conversation, savedReplyId: own.id }],
        ['ticket0/apply-saved-reply', { conversationId: conversation, savedReplyId: own.id }],
      ];
      for (const [op, input] of attempts) await expect(stub.invoke(op, input), `${op} as ${who}`).rejects.toMatchObject(notFound);
    }
    // Untouched, and still its owner's to use.
    expect(await get(desk, desk.anna, own.id)).toMatchObject({ body: 'Hi {{contact.name}}.', use_count: 0 });
    await (await as(desk, desk.anna)).invoke('ticket0/apply-saved-reply', { conversationId: conversation, savedReplyId: own.id });
    expect((await get(desk, desk.anna, own.id)).use_count).toBe(1);
  });

  it('keeps titles unique per owner: the desk and each agent may each have one "Refund"', async () => {
    const desk = await freshDesk();
    const shared = await create(desk, desk.anna, { title: 'Refund' });
    const annas = await create(desk, desk.anna, { title: 'Refund', personal: true });
    const bos = await create(desk, desk.bo, { title: 'Refund', personal: true });
    expect(new Set([shared.id, annas.id, bos.id]).size).toBe(3);
    // The same owner and title is the reply that already holds it.
    expect((await create(desk, desk.anna, { title: 'Refund', personal: true })).id).toBe(annas.id);
    expect((await create(desk, desk.bo, { title: 'Refund' })).id).toBe(shared.id);

    // A rename onto a title the same owner holds is a conflict; another owner's is not.
    const other = await create(desk, desk.anna, { title: 'Other', personal: true });
    await expect(
      (await as(desk, desk.anna)).invoke('ticket0/update-saved-reply', { savedReplyId: other.id, title: 'Refund' }),
    ).rejects.toMatchObject(conflict);
    const sharedOther = await create(desk, desk.anna, { title: 'Shared other' });
    await expect(
      (await as(desk, desk.anna)).invoke('ticket0/update-saved-reply', { savedReplyId: sharedOther.id, title: 'Refund' }),
    ).rejects.toMatchObject(conflict);
    await (await as(desk, desk.bo)).invoke('ticket0/update-saved-reply', { savedReplyId: bos.id, title: 'Other' });
    expect((await get(desk, desk.bo, bos.id)).title).toBe('Other');
  });

  it('shares one way: the owner gives it to the desk and everyone sees it from then on', async () => {
    const desk = await freshDesk();
    const own = await create(desk, desk.anna, { title: 'Good one', personal: true });
    const shared = (await (await as(desk, desk.anna)).invoke('ticket0/share-saved-reply', { savedReplyId: own.id })) as SavedReply;
    expect(shared).toMatchObject({ id: own.id, owner: null });
    expect((await listed(desk, desk.bo)).map((r) => r.id)).toEqual([own.id]);
    expect(events(desk, 'ticket0.saved-reply-shared')).toEqual([{ id: own.id, title: 'Good one', created_by: desk.anna }]);

    // Again changes nothing and announces nothing.
    await (await as(desk, desk.anna)).invoke('ticket0/share-saved-reply', { savedReplyId: own.id });
    expect(events(desk, 'ticket0.saved-reply-shared')).toHaveLength(1);
  });

  it('refuses to share onto a title the desk already has, and leaves the reply personal', async () => {
    const desk = await freshDesk();
    await create(desk, desk.anna, { title: 'Refund' });
    const own = await create(desk, desk.bo, { title: 'Refund', personal: true });
    await expect((await as(desk, desk.bo)).invoke('ticket0/share-saved-reply', { savedReplyId: own.id })).rejects.toMatchObject(
      conflict,
    );
    expect((await get(desk, desk.bo, own.id)).owner).toBe(desk.bo);
    expect(events(desk, 'ticket0.saved-reply-shared')).toEqual([]);
  });
});

describe('the shared library is curated with saved-reply:manage', () => {
  it('lets an assistant keep personal replies and use shared ones, and nothing more', async () => {
    const desk = await freshDesk();
    const conversation = await mail(desk);
    const shared = await create(desk, desk.anna, { title: 'Desk-wide' });
    const bot = await as(desk, desk.assistant);

    // Refused: adding to, changing and removing what every colleague pastes.
    await expect(bot.invoke('ticket0/create-saved-reply', { title: 'Bot', body: 'x' })).rejects.toMatchObject(denied);
    await expect(bot.invoke('ticket0/update-saved-reply', { savedReplyId: shared.id, body: 'x' })).rejects.toMatchObject(denied);
    await expect(bot.invoke('ticket0/delete-saved-reply', { savedReplyId: shared.id })).rejects.toMatchObject(denied);
    await expect(bot.invoke('ticket0/create-saved-reply-folder', { name: 'Bot' })).rejects.toMatchObject(denied);
    expect(await get(desk, desk.anna, shared.id)).toMatchObject({ body: 'Hi {{contact.name}}.' });
    expect((await listed(desk, desk.anna)).map((r) => r.title)).toEqual(['Desk-wide']);

    // Its own are its own: create, change, delete.
    const own = (await bot.invoke('ticket0/create-saved-reply', { title: 'Bot', body: 'x', personal: true })) as SavedReply;
    await bot.invoke('ticket0/update-saved-reply', { savedReplyId: own.id, body: 'y' });
    expect((await get(desk, desk.assistant, own.id)).body).toBe('y');
    // But giving one to the desk is curation.
    await expect(bot.invoke('ticket0/share-saved-reply', { savedReplyId: own.id })).rejects.toMatchObject(denied);
    expect((await get(desk, desk.assistant, own.id)).owner).toBe(desk.assistant);
    await bot.invoke('ticket0/delete-saved-reply', { savedReplyId: own.id });

    // Using a shared reply needs no curation: an internal note is within its keys.
    await bot.invoke('ticket0/apply-saved-reply', { conversationId: conversation, savedReplyId: shared.id, visibility: 'internal' });
    expect((await get(desk, desk.anna, shared.id)).use_count).toBe(1);
  });

  it('lets an agent and a desk-admin curate it', async () => {
    const desk = await freshDesk();
    const byAgent = await create(desk, desk.bo, { title: 'From Bo' });
    await (await as(desk, desk.admin)).invoke('ticket0/update-saved-reply', { savedReplyId: byAgent.id, body: 'Edited.' });
    expect((await get(desk, desk.bo, byAgent.id)).body).toBe('Edited.');
    await (await as(desk, desk.anna)).invoke('ticket0/delete-saved-reply', { savedReplyId: byAgent.id });
    expect(await listed(desk, desk.bo)).toEqual([]);
  });
});

describe('folders', () => {
  it('are created once per name, renamed, listed by name, and a rename onto a taken name is a conflict', async () => {
    const desk = await freshDesk();
    const anna = await as(desk, desk.anna);
    const billing = (await anna.invoke('ticket0/create-saved-reply-folder', { name: 'Billing' })) as Folder;
    expect(((await anna.invoke('ticket0/create-saved-reply-folder', { name: 'Billing' })) as Folder).id).toBe(billing.id);
    const shipping = (await anna.invoke('ticket0/create-saved-reply-folder', { name: 'Shipping' })) as Folder;

    await expect(
      anna.invoke('ticket0/rename-saved-reply-folder', { folderId: shipping.id, name: 'Billing' }),
    ).rejects.toMatchObject(conflict);
    await anna.invoke('ticket0/rename-saved-reply-folder', { folderId: shipping.id, name: 'Accounts' });

    // Everyone who may use a reply sees where they are filed.
    const names = ((await (await as(desk, desk.assistant)).invoke('ticket0/list-saved-reply-folders', {})) as Page<Folder>).entries.map(
      (f) => f.name,
    );
    expect(names).toEqual(['Accounts', 'Billing']);
    expect(events(desk, 'ticket0.saved-reply-folder-renamed')).toEqual([{ id: shipping.id, name: 'Accounts' }]);
  });

  it('files, moves and unfiles a reply, and refuses a folder that does not exist', async () => {
    const desk = await freshDesk();
    const anna = await as(desk, desk.anna);
    const one = (await anna.invoke('ticket0/create-saved-reply-folder', { name: 'One' })) as Folder;
    const two = (await anna.invoke('ticket0/create-saved-reply-folder', { name: 'Two' })) as Folder;
    const reply = await create(desk, desk.anna, { title: 'Filed', folderId: one.id });
    const loose = await create(desk, desk.anna, { title: 'Loose' });
    expect(reply.folder_id).toBe(one.id);
    expect((await listed(desk, desk.anna, { folderId: one.id })).map((r) => r.id)).toEqual([reply.id]);

    await anna.invoke('ticket0/update-saved-reply', { savedReplyId: reply.id, folderId: two.id });
    expect((await listed(desk, desk.anna, { folderId: one.id })).map((r) => r.id)).toEqual([]);
    expect((await listed(desk, desk.anna, { folderId: two.id })).map((r) => r.id)).toEqual([reply.id]);
    await anna.invoke('ticket0/update-saved-reply', { savedReplyId: reply.id, folderId: null });
    expect((await get(desk, desk.anna, reply.id)).folder_id).toBeNull();

    await expect(create(desk, desk.anna, { title: 'Nowhere', folderId: ulid() })).rejects.toMatchObject(notFound);
    await expect(
      anna.invoke('ticket0/update-saved-reply', { savedReplyId: loose.id, folderId: ulid() }),
    ).rejects.toMatchObject(notFound);
    expect((await get(desk, desk.anna, loose.id)).folder_id).toBeNull();
  });

  it('deleting one unfiles every reply in it, personal ones included, and deletes none', async () => {
    const desk = await freshDesk();
    const anna = await as(desk, desk.anna);
    const folder = (await anna.invoke('ticket0/create-saved-reply-folder', { name: 'Old' })) as Folder;
    const keep = (await anna.invoke('ticket0/create-saved-reply-folder', { name: 'Keep' })) as Folder;
    const shared = await create(desk, desk.anna, { title: 'Shared', folderId: folder.id });
    const bos = await create(desk, desk.bo, { title: 'Bo’s', personal: true, folderId: folder.id });
    const elsewhere = await create(desk, desk.anna, { title: 'Elsewhere', folderId: keep.id });

    const out = (await anna.invoke('ticket0/delete-saved-reply-folder', { folderId: folder.id })) as {
      unfiled: string[];
    };
    expect(out.unfiled).toEqual([shared.id, bos.id].sort());
    expect((await get(desk, desk.anna, shared.id)).folder_id).toBeNull();
    expect((await get(desk, desk.bo, bos.id)).folder_id).toBeNull();
    expect((await get(desk, desk.anna, elsewhere.id)).folder_id).toBe(keep.id);
    // Ids only on the desk's trail: a colleague's personal titles are not the desk's to read.
    expect(events(desk, 'ticket0.saved-reply-folder-deleted')).toEqual([
      { id: folder.id, name: 'Old', unfiled: [shared.id, bos.id].sort() },
    ]);
    const folders = ((await anna.invoke('ticket0/list-saved-reply-folders', {})) as Page<Folder>).entries;
    expect(folders.map((f) => f.name)).toEqual(['Keep']);
    await expect(anna.invoke('ticket0/delete-saved-reply-folder', { folderId: folder.id })).rejects.toMatchObject(notFound);
  });
});

/**
 * The same rules through the surface the browser calls. The scenarios above drive the
 * module; this drives `mountApi`, so the query string, the JSON body and the error map
 * are the ones a request meets.
 */
describe('over HTTP, as the composer and the picker call it', () => {
  it('lists by folder, applies with alsoUsed, counts once, and answers 404 for a colleague’s reply', async () => {
    const desk = await freshDesk();
    const conversation = await mail(desk);
    let caller: PrincipalId = desk.anna;
    const app = new Hono();
    mountApi(app, async () => kit.host.getScope(caller, desk.tenant, desk.scope));
    const json = (method: string, path: string, body?: unknown) =>
      app.request(`/api${path}`, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });

    const folder = (await (await json('POST', '/saved-reply-folders', { name: 'Billing' })).json()) as Folder;
    const filed = (await (await json('POST', '/saved-replies', { title: 'Invoice', body: 'Here.', folderId: folder.id })).json()) as SavedReply;
    const greeting = (await (await json('POST', '/saved-replies', { title: 'Hello', body: 'Hi.', personal: true })).json()) as SavedReply;

    // A page over HTTP is the entries themselves; the cursor rides in a `Link` header.
    const inBilling = (await (await json('GET', `/saved-replies?folderId=${folder.id}`)).json()) as SavedReply[];
    expect(inBilling.map((r) => r.id)).toEqual([filed.id]);

    const sent = await json('POST', `/conversations/${conversation}/saved-replies/${filed.id}/apply`, {
      body: 'Hi. Here.',
      alsoUsed: [greeting.id],
    });
    expect(sent.status).toBe(200);
    const all = (await (await json('GET', '/saved-replies')).json()) as SavedReply[];
    expect(all.map((r) => [r.title, r.use_count])).toEqual([
      ['Invoice', 1],
      ['Hello', 1],
    ]);

    // Bo cannot see Anna's own, by id or in a send.
    caller = desk.bo;
    expect((await json('GET', `/saved-replies/${greeting.id}`)).status).toBe(404);
    expect(
      (await json('POST', `/conversations/${conversation}/saved-replies/${filed.id}/apply`, { alsoUsed: [greeting.id] })).status,
    ).toBe(404);
    // And the assistant may not curate the shared library.
    caller = desk.assistant;
    expect((await json('PATCH', `/saved-replies/${filed.id}`, { body: 'Changed.' })).status).toBe(403);
    expect((await json('DELETE', `/saved-reply-folders/${folder.id}`)).status).toBe(403);

    caller = desk.anna;
    expect((await json('POST', `/saved-replies/${greeting.id}/share`)).status).toBe(200);
    const unfiled = (await (await json('DELETE', `/saved-reply-folders/${folder.id}`)).json()) as { unfiled: string[] };
    expect(unfiled.unfiled).toEqual([filed.id]);
    const after = (await (await json('GET', '/saved-replies')).json()) as SavedReply[];
    expect(after.map((r) => [r.title, r.owner, r.folder_id, r.use_count])).toEqual([
      ['Invoice', null, null, 1],
      ['Hello', null, null, 1],
    ]);
  });
});

describe('migration 0025 on an existing desk', () => {
  it('keeps every reply as the desk’s own, unfiled and unused, then keys titles per owner', async () => {
    const actor = platformActorId.parse(ulid());
    const migrationDir = mkdtempSync(join(tmpdir(), 'ticket0-0025-'));
    try {
      const provision = async (h: SqliteScopeHost, slug: string) => {
        const d = { tenant: tenantId.parse(ulid()), scope: scopeId.parse(ulid()) };
        await h.admin.createTenant(actor, { id: d.tenant, slug, name: 'Migration' });
        await h.admin.grantEntitlement(actor, d.tenant, ticket0Manifest.entitlementKey as string);
        await h.provisionScope(actor, { tenantId: d.tenant, scopeId: d.scope, vertical: 'ticket0' });
        return d;
      };
      const file = (d: { tenant: string; scope: string }) => join(migrationDir, `${d.tenant}__${d.scope}.sqlite`);
      const schemaOf = (d: { tenant: string; scope: string }) => {
        const db = new Database(file(d), { readonly: true });
        try {
          return db
            .prepare(
              `SELECT type, name, sql FROM sqlite_master
                WHERE tbl_name IN ('ticket0_saved_replies', 'ticket0_saved_reply_folders') ORDER BY type, name`,
            )
            .all();
        } finally {
          db.close();
        }
      };

      // The version before: its journal, and its list declarations.
      const previous = new SqliteScopeHost({ dir: migrationDir });
      for (const m of MODULES)
        previous.registerModule(
          m.manifest.id === ticket0Manifest.id
            ? {
                ...m,
                manifest: { ...m.manifest, lists: listsBefore0025(m.manifest.lists ?? []) },
                migrations: (m.migrations ?? []).filter((x) => x.version <= '0024'),
              }
            : m,
          );
      const old = await provision(previous, 'migration-0025-old');
      await previous.close();
      const listIndex = expect.stringMatching(/^_substrat_list_.*_savedreply_/);
      expect((schemaOf(old) as { name: string }[]).map((r) => r.name)).toContainEqual(listIndex);

      const db = new Database(file(old));
      const insert = db.prepare(
        'INSERT INTO ticket0_saved_replies (id, title, body, created_by, created_at, actions) VALUES (?, ?, ?, ?, ?, ?)',
      );
      insert.run('r1', 'Refund', 'We refund.', 'agent-1', '2026-01-01T00:00:00.000Z', null);
      insert.run('r2', 'Escalate', 'On it.', 'agent-2', '2026-01-02T00:00:00.000Z', '[{"type":"set-priority","priority":"urgent"}]');
      const beforeRows = db.prepare('SELECT * FROM ticket0_saved_replies ORDER BY id').all();
      // The old key, before: one title per desk, whoever wrote it.
      expect(() => insert.run('r3', 'Refund', 'Again.', 'agent-3', '2026-01-03T00:00:00.000Z', null)).toThrow(/UNIQUE/);
      db.close();

      const current = new SqliteScopeHost({ dir: migrationDir });
      for (const m of MODULES) current.registerModule(m);
      await current.provisionScope(actor, { tenantId: old.tenant, scopeId: old.scope, vertical: 'ticket0' });
      // Provisioning again changes nothing: the migration is applied once.
      await current.provisionScope(actor, { tenantId: old.tenant, scopeId: old.scope, vertical: 'ticket0' });
      const fresh = await provision(current, 'migration-0025-fresh');
      await current.close();

      // Exactly a fresh desk's tables and indexes: the old list indexes went with the table.
      expect(schemaOf(old)).toEqual(schemaOf(fresh));
      expect((schemaOf(old) as { name: string }[]).map((r) => r.name)).not.toContainEqual(listIndex);

      const after = new Database(file(old));
      try {
        const rows = after.prepare('SELECT * FROM ticket0_saved_replies ORDER BY id').all() as Record<string, unknown>[];
        expect(rows.map(({ owner: _o, folder_id: _f, use_count: _u, last_used_at: _l, ...rest }) => rest)).toEqual(beforeRows);
        expect(rows.map((r) => [r.id, r.owner, r.folder_id, r.use_count, r.last_used_at])).toEqual([
          ['r1', '', null, 0, null],
          ['r2', '', null, 0, null],
        ]);
        const add = after.prepare(
          "INSERT INTO ticket0_saved_replies (id, title, body, created_by, created_at, owner) VALUES (?, ?, 'x', 'p', '2026-01-04T00:00:00.000Z', ?)",
        );
        // And after: one title per OWNER. The desk still has one "Refund"; an agent may have their own.
        expect(() => add.run('r4', 'Refund', '')).toThrow(/UNIQUE/);
        add.run('r5', 'Refund', 'agent-1');
        expect(() => add.run('r6', 'Refund', 'agent-1')).toThrow(/UNIQUE/);
      } finally {
        after.close();
      }
    } finally {
      rmSync(migrationDir, { recursive: true, force: true });
    }
  });
});
