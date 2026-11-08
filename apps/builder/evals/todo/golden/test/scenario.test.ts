/**
 * The scenario from spec/concept.md §9, replayed headlessly.
 *
 * Written from the CONCEPT, never from the model. Inputs and outputs are
 * literals. The seed is assumed to have the people already joined (concept §10:
 * sharing names "someone who has already joined"), under these emails:
 * markus@example.com, alice@example.com, bob@example.com (tenant A) and
 * tess@example.com (tenant B).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CountedPage, Page } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

const as = (who: 'markus' | 'alice' | 'bob') =>
  host.getScope(world[who].principal, world.tenant, world.scope);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lists-scenario-'));
  host = buildHost(dir);
  world = await seed(host);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the happy path', () => {
  let groceries: string;
  let milk: string;
  let aliceItem: string;
  let shareId: string;

  it('Markus creates a list and adds items', async () => {
    const markus = await as('markus');
    const list = await markus.invoke<{ id: string; name: string; owner_id: string }>(
      'lists/create-list',
      { name: 'Groceries' },
    );
    groceries = list.id;
    expect(list.name).toBe('Groceries');
    expect(list.owner_id).toBe(world.markus.principal);

    const item = await markus.invoke<{ id: string; text: string; done: number }>('lists/add-item', {
      listId: groceries,
      text: 'milk',
    });
    milk = item.id;
    expect(item.text).toBe('milk');
    expect(item.done).toBe(0);
    await markus.invoke('lists/add-item', { listId: groceries, text: 'eggs' });
  });

  it('Alice and Bob see nothing before the share', async () => {
    for (const who of ['alice', 'bob'] as const) {
      const p = await as(who);
      expect(await p.invoke('lists/my-lists')).toEqual({ entries: [], nextCursor: null });
      await expect(p.invoke('lists/list-items', { listId: groceries })).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it('Markus shares with Alice, and sees the share', async () => {
    const markus = await as('markus');
    const share = await markus.invoke<{ id: string; list_id: string; email: string }>(
      'lists/share-list',
      { listId: groceries, email: 'alice@example.com' },
    );
    shareId = share.id;
    expect(share.list_id).toBe(groceries);
    expect(share.email).toBe('alice@example.com');

    const shares = await markus.invoke<Page<{ email: string }>>('lists/list-shares', {
      listId: groceries,
    });
    expect(shares.entries.map((s) => s.email)).toEqual(['alice@example.com']);
  });

  it('Alice sees the list, adds an item and ticks one', async () => {
    const alice = await as('alice');
    const { entries } = await alice.invoke<Page<{ id: string; name: string }>>('lists/my-lists');
    expect(entries.map((l) => l.name)).toEqual(['Groceries']);

    const added = await alice.invoke<{ id: string; created_by: string }>('lists/add-item', {
      listId: groceries,
      text: 'bread',
    });
    aliceItem = added.id;
    expect(added.created_by).toBe(world.alice.principal);

    const ticked = await alice.invoke<{ done: number; done_by: string | null }>(
      'lists/set-item-done',
      { itemId: milk, done: true },
    );
    expect(ticked.done).toBe(1);
    expect(ticked.done_by).toBe(world.alice.principal);
  });

  it('Markus sees both changes, and a tick can be undone', async () => {
    const markus = await as('markus');
    const page = await markus.invoke<CountedPage<{ text: string; done: number }>>(
      'lists/list-items',
      { listId: groceries },
    );
    expect(page.entries.map((i) => `${i.text}:${i.done}`)).toEqual(['milk:1', 'eggs:0', 'bread:0']);
    expect(page.total).toBe(3);

    const undone = await markus.invoke<{ done: number }>('lists/set-item-done', {
      itemId: milk,
      done: false,
    });
    expect(undone.done).toBe(0);
  });

  it('Alice can edit her own item', async () => {
    const alice = await as('alice');
    const edited = await alice.invoke<{ text: string }>('lists/edit-item', {
      itemId: aliceItem,
      text: 'sourdough',
    });
    expect(edited.text).toBe('sourdough');
  });

  describe('the denials that prove it', () => {
    it('Alice cannot delete the list', async () => {
      const alice = await as('alice');
      await expect(alice.invoke('lists/delete-list', { listId: groceries })).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('Alice cannot share it onward', async () => {
      const alice = await as('alice');
      await expect(
        alice.invoke('lists/share-list', { listId: groceries, email: 'bob@example.com' }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('Alice cannot see the share list, rename the list, or revoke a share', async () => {
      const alice = await as('alice');
      await expect(alice.invoke('lists/list-shares', { listId: groceries })).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        alice.invoke('lists/rename-list', { listId: groceries, name: 'Mine now' }),
      ).rejects.toThrow(/permission denied/i);
      await expect(alice.invoke('lists/revoke-share', { shareId })).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('...while the doors she DOES hold stay open', async () => {
      const alice = await as('alice');
      await expect(
        alice.invoke('lists/add-item', { listId: groceries, text: 'butter' }),
      ).resolves.toBeTruthy();
    });

    it('Alice cannot delete or edit the owner’s item', async () => {
      const alice = await as('alice');
      await expect(alice.invoke('lists/delete-item', { itemId: milk })).rejects.toThrow(
        /permission denied/i,
      );
      await expect(
        alice.invoke('lists/edit-item', { itemId: milk, text: 'oat milk' }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('...but can delete her own, and the owner can delete any item', async () => {
      const alice = await as('alice');
      await expect(alice.invoke('lists/delete-item', { itemId: aliceItem })).resolves.toBeTruthy();

      const extra = await alice.invoke<{ id: string }>('lists/add-item', {
        listId: groceries,
        text: 'jam',
      });
      const markus = await as('markus');
      await expect(markus.invoke('lists/delete-item', { itemId: extra.id })).resolves.toBeTruthy();
    });

    it('Bob, never shared, cannot see the list — and a private list stays private', async () => {
      const markus = await as('markus');
      const work = await markus.invoke<{ id: string }>('lists/create-list', { name: 'Work' });

      const bob = await as('bob');
      expect(await bob.invoke('lists/my-lists')).toEqual({ entries: [], nextCursor: null });
      await expect(bob.invoke('lists/list-items', { listId: groceries })).rejects.toThrow(
        /permission denied/i,
      );
      await expect(bob.invoke('lists/list-items', { listId: work.id })).rejects.toThrow(
        /permission denied/i,
      );

      // Alice holds a share on Groceries only: Work is invisible to her.
      const alice = await as('alice');
      const { entries } = await alice.invoke<Page<{ name: string }>>('lists/my-lists');
      expect(entries.map((l) => l.name)).toEqual(['Groceries']);
      await expect(alice.invoke('lists/list-items', { listId: work.id })).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('Tess, in another tenant, reaches nothing of tenant A', async () => {
      // Wrong pair is refused at the handle…
      await expect(
        host.getScope(world.tess.principal, world.tenant, world.otherScope),
      ).rejects.toThrow(/unknown scope/i);
      // …the correct pair resolves, and every door behind it is shut or empty.
      const tess = await host.getScope(world.tess.principal, world.tenant, world.scope);
      expect(await tess.invoke('lists/my-lists')).toEqual({ entries: [], nextCursor: null });
      await expect(tess.invoke('lists/list-items', { listId: groceries })).rejects.toThrow(
        /permission denied/i,
      );
      await expect(tess.invoke('lists/create-list', { name: 'Trojan' })).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('...and in her OWN scope she is a normal member', async () => {
      const tess = await host.getScope(world.tess.principal, world.otherTenant, world.otherScope);
      const list = await tess.invoke<{ name: string }>('lists/create-list', { name: 'Tess list' });
      expect(list.name).toBe('Tess list');
      const { entries } = await tess.invoke<Page<{ name: string }>>('lists/my-lists');
      expect(entries.map((l) => l.name)).toEqual(['Tess list']);
    });
  });

  it('revoking the share takes Alice’s access with it', async () => {
    const markus = await as('markus');
    await markus.invoke('lists/revoke-share', { shareId });

    const alice = await as('alice');
    expect(await alice.invoke('lists/my-lists')).toEqual({ entries: [], nextCursor: null });
    await expect(alice.invoke('lists/list-items', { listId: groceries })).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('the owner deletes the list', async () => {
    const markus = await as('markus');
    await expect(markus.invoke('lists/delete-list', { listId: groceries })).resolves.toBeTruthy();
    const { entries } = await markus.invoke<Page<{ name: string }>>('lists/my-lists');
    expect(entries.map((l) => l.name)).toEqual(['Work']);
  });
});
