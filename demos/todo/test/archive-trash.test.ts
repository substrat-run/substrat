/**
 * Putting lists away — spec/concept.md §9 (#119), replayed headlessly.
 *
 * Dana is NOT one of the seeded cast: she joins afterwards, through the same three steps the
 * seed takes for everyone (the member role, `todo/join`, the owner grant). So what is proved
 * here is that a person who arrives later holds the archive and trash keys too — the grant
 * shape is one list, not a literal the seed happened to include.
 *
 * Written from the concept, with literal inputs, for the scenario suite's reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorCodeOf, principalId, type Page } from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import { buildHost, grantOwner, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let dana: ScopeStub;
let holiday: string;
let taxes: string;

type List = { id: string; name: string };
const names = (page: Page<List>) => page.entries.map((l) => l.name);
const codeOf = (call: Promise<unknown>) => call.then(() => 'answered', errorCodeOf);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-archive-'));
  host = buildHost(dir);
  world = await seed(host);

  const danaId = principalId.parse(ulid());
  const node = { tenantId: world.tenant, scopeId: world.scope };
  await host.admin.assignRole(world.staff, { principalId: danaId, roleKey: 'member', node });
  dana = await host.getScope(danaId, world.tenant, world.scope);
  await dana.invoke('todo/join', { email: 'dana@example.com', displayName: 'Dana' });
  await grantOwner(host, world.staff, node, danaId);

  holiday = (await dana.invoke<List>('todo/create-list', { name: 'Holiday' })).id;
  taxes = (await dana.invoke<List>('todo/create-list', { name: 'Taxes 2025' })).id;
  await dana.invoke('todo/add-item', { listId: holiday, text: 'sun cream' });
  await dana.invoke('todo/add-item', { listId: taxes, text: 'receipts' });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const myLists = async (view?: 'archived') => names(await dana.invoke<Page<List>>('todo/my-lists', view ? { view } : {}));
const bin = async (who: ScopeStub = dana) => names(await who.invoke<Page<List>>('todo/trashed-lists', {}));

describe('putting lists away', () => {
  it('Dana archives "Taxes 2025": it leaves her lists, shows in her archive, and is still readable', async () => {
    expect(await dana.invoke('todo/archive-list', { listId: taxes })).toEqual({ id: taxes, state: 'archived' });
    expect(await myLists()).toEqual(['Holiday']);
    expect(await myLists('archived')).toEqual(['Taxes 2025']);
    const items = await dana.invoke<Page<{ text: string }>>('todo/list-items', { listId: taxes });
    expect(items.entries.map((i) => i.text)).toEqual(['receipts']);
  });

  it('Dana bins "Holiday": it leaves her lists, shows in her trash, and opening it is not found', async () => {
    expect(await dana.invoke('todo/trash-list', { listId: holiday })).toEqual({ id: holiday, state: 'trashed' });
    expect(await myLists()).toEqual([]);
    expect(await bin()).toEqual(['Holiday']);
    expect(await codeOf(dana.invoke('todo/list-items', { listId: holiday }))).toBe('not_found');
    expect(await codeOf(dana.invoke('todo/add-item', { listId: holiday, text: 'towel' }))).toBe('not_found');
    expect(await codeOf(dana.invoke('todo/rename-list', { listId: holiday, name: 'Trip' }))).toBe('not_found');
  });

  it('restoring "Holiday" brings it back with its items', async () => {
    expect(await dana.invoke('todo/restore-list', { listId: holiday })).toEqual({ id: holiday, state: 'active' });
    expect(await myLists()).toEqual(['Holiday']);
    expect(await bin()).toEqual([]);
    const items = await dana.invoke<Page<{ text: string }>>('todo/list-items', { listId: holiday });
    expect(items.entries.map((i) => i.text)).toEqual(['sun cream']);
  });

  it('binning the archived "Taxes 2025" and restoring it returns it to the archive, not her lists', async () => {
    await dana.invoke('todo/trash-list', { listId: taxes });
    expect(await myLists('archived')).toEqual([]);
    expect(await dana.invoke('todo/restore-list', { listId: taxes })).toEqual({ id: taxes, state: 'archived' });
    expect(await myLists()).toEqual(['Holiday']);
    expect(await myLists('archived')).toEqual(['Taxes 2025']);
  });

  it('refuses a move from the wrong place — a list in her lists cannot be restored', async () => {
    expect(await codeOf(dana.invoke('todo/restore-list', { listId: holiday }))).toBe('conflict');
    expect(await codeOf(dana.invoke('todo/unarchive-list', { listId: holiday }))).toBe('conflict');
    // …and the control: the archived list CAN be brought back, then put away again.
    expect(await dana.invoke('todo/unarchive-list', { listId: taxes })).toEqual({ id: taxes, state: 'active' });
    await dana.invoke('todo/archive-list', { listId: taxes });
  });

  it('search finds items only on the lists in her lists', async () => {
    const found = async () =>
      (await dana.invoke<{ results: { text: string }[] }>('todo/search-items', { q: 're' })).results.map((r) => r.text);
    expect(await found()).toEqual([]); // "receipts" is on the archived list
    await dana.invoke('todo/unarchive-list', { listId: taxes });
    expect(await found()).toEqual(['receipts']);
    await dana.invoke('todo/trash-list', { listId: taxes });
    expect(await found()).toEqual([]);
    await dana.invoke('todo/restore-list', { listId: taxes });
    await dana.invoke('todo/archive-list', { listId: taxes });
  });
});

describe('a binned list is gone to every operation but restore, the bin and the permanent delete', () => {
  it('refuses each operation that reaches the list, its items or its shares — and the restore brings all of it back', async () => {
    const ada = await host.getScope(world.ada.principal, world.tenant, world.scope);
    const garage = (await ada.invoke<List>('todo/create-list', { name: 'Garage' })).id;
    const bolt = (await ada.invoke<{ id: string }>('todo/add-item', { listId: garage, text: 'bolts' })).id;
    const share = (await ada.invoke<{ id: string }>('todo/share-list', { listId: garage, email: world.bjorn.email })).id;
    await ada.invoke('todo/trash-list', { listId: garage });

    const calls: [string, Record<string, unknown>][] = [
      ['todo/list-items', { listId: garage }],
      ['todo/search-list-items', { listId: garage, q: 'bolt' }],
      ['todo/add-item', { listId: garage, text: 'nuts' }],
      ['todo/rename-list', { listId: garage, name: 'Shed' }],
      ['todo/set-item-done', { itemId: bolt, done: true }],
      ['todo/delete-item', { itemId: bolt }],
      ['todo/share-list', { listId: garage, email: 'dana@example.com' }],
      ['todo/list-shares', { listId: garage }],
      ['todo/revoke-share', { shareId: share }],
      ['todo/archive-list', { listId: garage }],
      ['todo/unarchive-list', { listId: garage }],
      ['todo/trash-list', { listId: garage }],
    ];
    for (const [op, input] of calls) expect(await codeOf(ada.invoke(op, input)), op).toBe('not_found');
    const found = await ada.invoke<{ results: unknown[] }>('todo/search-items', { q: 'bolt' });
    expect(found.results).toEqual([]);

    // Nothing above changed it: the restore brings back the item, undone, and the share.
    await ada.invoke('todo/restore-list', { listId: garage });
    const items = await ada.invoke<Page<{ text: string; done: number }>>('todo/list-items', { listId: garage });
    expect(items.entries.map((i) => [i.text, i.done])).toEqual([['bolts', 0]]);
    const shares = await ada.invoke<Page<{ id: string }>>('todo/list-shares', { listId: garage });
    expect(shares.entries.map((s) => s.id)).toEqual([share]);
  });
});

describe('the denials that prove it', () => {
  it("nobody else's trash shows Dana's lists", async () => {
    await dana.invoke('todo/trash-list', { listId: holiday });
    const ada = await host.getScope(world.ada.principal, world.tenant, world.scope);
    expect(await bin(ada)).not.toContain('Holiday');
    expect(await bin()).toEqual(['Holiday']);
    await dana.invoke('todo/restore-list', { listId: holiday });
  });

  it('Björn, who can add to a list shared with him, cannot archive or bin it', async () => {
    const ada = await host.getScope(world.ada.principal, world.tenant, world.scope);
    const chores = (await ada.invoke<List>('todo/create-list', { name: 'Chores' })).id;
    await ada.invoke('todo/share-list', { listId: chores, email: world.bjorn.email });
    const bjorn = await host.getScope(world.bjorn.principal, world.tenant, world.scope);
    await bjorn.invoke('todo/add-item', { listId: chores, text: 'bins out' }); // the open door
    expect(await codeOf(bjorn.invoke('todo/archive-list', { listId: chores }))).toBe('permission_denied');
    expect(await codeOf(bjorn.invoke('todo/trash-list', { listId: chores }))).toBe('permission_denied');
    // Ada, the owner, can — the closed door is not closed for everyone.
    expect(await ada.invoke('todo/trash-list', { listId: chores })).toEqual({ id: chores, state: 'trashed' });
    expect(await bin(bjorn)).toEqual([]);
  });

  it('emptying the bin is the delete that cannot be undone', async () => {
    await dana.invoke('todo/trash-list', { listId: holiday });
    expect(await dana.invoke('todo/delete-list', { listId: holiday })).toEqual({ id: holiday, deleted: true });
    expect(await bin()).toEqual([]);
    expect(await codeOf(dana.invoke('todo/restore-list', { listId: holiday }))).toBe('not_found');
  });
});
