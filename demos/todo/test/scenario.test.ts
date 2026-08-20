/**
 * The scenario from spec/concept.md §9, replayed headlessly.
 *
 * Written from the CONCEPT, never from the model: a test derived from the model
 * agrees with a wrong model perfectly and forever. Inputs and outputs are
 * literals here for the same reason — a test that builds its input from the
 * emitted schema cannot disagree with that schema.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CountedPage } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;

const as = (who: 'ada' | 'bjorn') => host.getScope(world[who].principal, world.tenant, world.scope);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-scenario-'));
  host = buildHost(dir);
  world = await seed(host);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the happy path', () => {
  let groceries: string;
  let milk: string;

  it('Ada creates a list and adds an item', async () => {
    const ada = await as('ada');
    const list = await ada.invoke<{ id: string; name: string }>('todo/create-list', {
      name: 'Groceries',
    });
    groceries = list.id;
    expect(list.name).toBe('Groceries');

    const item = await ada.invoke<{ id: string; text: string; done: number }>('todo/add-item', {
      listId: groceries,
      text: 'milk',
    });
    milk = item.id;
    expect(item.text).toBe('milk');
    expect(item.done).toBe(0);
  });

  it('Björn cannot see it before it is shared', async () => {
    const bjorn = await as('bjorn');
    expect(await bjorn.invoke('todo/my-lists')).toEqual([]);
    await expect(bjorn.invoke('todo/list-items', { listId: groceries })).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('Ada shares it, and Björn sees it', async () => {
    const ada = await as('ada');
    await ada.invoke('todo/share-list', { listId: groceries, email: 'bjorn@example.com' });

    const bjorn = await as('bjorn');
    const lists = await bjorn.invoke<{ id: string; name: string }[]>('todo/my-lists');
    expect(lists.map((l) => l.name)).toEqual(['Groceries']);
  });

  it('Björn adds an item and ticks Ada’s off', async () => {
    const bjorn = await as('bjorn');
    await bjorn.invoke('todo/add-item', { listId: groceries, text: 'bread' });
    const ticked = await bjorn.invoke<{ done: number }>('todo/set-item-done', {
      itemId: milk,
      done: true,
    });
    expect(ticked.done).toBe(1);
  });

  it('Ada sees both changes', async () => {
    const ada = await as('ada');
    const page = await ada.invoke<CountedPage<{ text: string; done: number }>>('todo/list-items', {
      listId: groceries,
    });
    expect(page.entries.map((i) => `${i.text}:${i.done}`)).toEqual(['milk:1', 'bread:0']);
    // Short page: the walk is over, so a client stops here rather than making one more
    // request that returns nothing.
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBe(2);
  });

  it('walks a long list one page at a time, without repeating or skipping a row', async () => {
    const ada = await as('ada');
    const list = await ada.invoke<{ id: string }>('todo/create-list', { name: 'Big shop' });
    for (let i = 0; i < 5; i++) {
      await ada.invoke('todo/add-item', { listId: list.id, text: `item ${i}` });
    }

    const seen: string[] = [];
    const totals: number[] = [];
    let cursor: string | null = null;
    let requests = 0;
    do {
      const page: CountedPage<{ text: string }> = await ada.invoke<CountedPage<{ text: string }>>(
        'todo/list-items',
        { listId: list.id, limit: 2, ...(cursor ? { cursor } : {}) },
      );
      seen.push(...page.entries.map((i) => i.text));
      totals.push(page.total);
      cursor = page.nextCursor;
      requests++;
    } while (cursor !== null);

    // Every row exactly once, in order — the property an offset cannot promise on a
    // table being written to.
    expect(seen).toEqual(['item 0', 'item 1', 'item 2', 'item 3', 'item 4']);
    expect(new Set(seen).size).toBe(seen.length);
    // 2 + 2 + 1: the short final page ends the walk, so three requests and no fourth.
    expect(requests).toBe(3);
    // `1–2 of 5` on page one: the count is the whole filtered set, not the page.
    expect(totals).toEqual([5, 5, 5]);
  });

  it('counts the filter, not the table', async () => {
    const ada = await as('ada');
    const mine = await ada.invoke<{ id: string }>('todo/create-list', { name: 'Counted' });
    const other = await ada.invoke<{ id: string }>('todo/create-list', { name: 'Decoy' });
    await ada.invoke('todo/add-item', { listId: mine.id, text: 'only one here' });
    for (const text of ['a', 'b', 'c']) {
      await ada.invoke('todo/add-item', { listId: other.id, text });
    }

    const page = await ada.invoke<CountedPage<{ text: string }>>('todo/list-items', {
      listId: mine.id,
    });
    // 1, not 4. A count over the table instead of the list's own WHERE is a number
    // that looks right until a second list exists.
    expect(page.total).toBe(1);
    expect(page.entries).toHaveLength(1);
  });

  it('does not repeat a row when the list is written to mid-walk', async () => {
    const ada = await as('ada');
    const list = await ada.invoke<{ id: string }>('todo/create-list', { name: 'Live list' });
    for (const text of ['a', 'b', 'c']) {
      await ada.invoke('todo/add-item', { listId: list.id, text });
    }

    const first = await ada.invoke<CountedPage<{ text: string }>>('todo/list-items', {
      listId: list.id,
      limit: 2,
    });
    expect(first.entries.map((i) => i.text)).toEqual(['a', 'b']);

    // A row lands BEFORE the second page is fetched. Under offset paging the window
    // would shift and 'b' would come back a second time; a keyset cursor names a
    // position in the ordering, so it cannot.
    await ada.invoke('todo/add-item', { listId: list.id, text: 'd' });

    const second = await ada.invoke<CountedPage<{ text: string }>>('todo/list-items', {
      listId: list.id,
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.entries.map((i) => i.text)).toEqual(['c', 'd']);
  });

  describe('the denials that prove it', () => {
    it('Björn cannot delete the list', async () => {
      const bjorn = await as('bjorn');
      await expect(bjorn.invoke('todo/delete-list', { listId: groceries })).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('...while the door he DOES hold stays open', async () => {
      // Without this control the refusal above would pass just as happily if
      // Björn's access were broken entirely.
      const bjorn = await as('bjorn');
      await expect(
        bjorn.invoke('todo/add-item', { listId: groceries, text: 'butter' }),
      ).resolves.toBeTruthy();
    });

    it('Ada’s unshared list is invisible, not merely filtered', async () => {
      const ada = await as('ada');
      const work = await ada.invoke<{ id: string }>('todo/create-list', { name: 'Work' });

      const bjorn = await as('bjorn');
      const lists = await bjorn.invoke<{ name: string }[]>('todo/my-lists');
      expect(lists.map((l) => l.name)).toEqual(['Groceries']);
      await expect(bjorn.invoke('todo/list-items', { listId: work.id })).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('a share can be revoked, and the access goes with it', async () => {
      const ada = await as('ada');
      const shared = await ada.invoke<{ id: string }>('todo/share-list', {
        listId: groceries,
        email: 'bjorn@example.com',
      });
      await ada.invoke('todo/revoke-share', { shareId: shared.id });

      const bjorn = await as('bjorn');
      expect(await bjorn.invoke('todo/my-lists')).toEqual([]);
    });

    it('Cleo, in another tenant, reaches nothing at all', async () => {
      // A handle is not access: `getScope` hands her a stub, and every door
      // behind it is shut. Asserting on the handle would have tested the wrong
      // thing and passed for the wrong reason.
      const cleo = await host.getScope(world.cleo.principal, world.tenant, world.scope);
      await expect(cleo.invoke('todo/my-lists')).resolves.toEqual([]);
      await expect(cleo.invoke('todo/list-items', { listId: groceries })).rejects.toThrow(
        /permission denied/i,
      );
      await expect(cleo.invoke('todo/create-list', { name: 'Trojan' })).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('...and in her OWN scope she is a normal member', async () => {
      // The control for the row above: Cleo is not a broken principal, she is
      // simply somewhere else.
      const cleo = await host.getScope(world.cleo.principal, world.otherTenant, world.otherScope);
      await expect(cleo.invoke('todo/create-list', { name: 'Cleo’s list' })).resolves.toBeTruthy();
    });
  });
});

/**
 * Search (#827) — concept §9's "find the thing I wrote down somewhere".
 *
 * Its own world, so nothing here depends on what the blocks above left behind.
 * Two lists on purpose: "search found it" and "search found it HERE" are
 * different claims, and one list cannot tell them apart.
 */
describe('finding an item by what someone typed', () => {
  let pantry: string;
  let cellar: string;

  beforeAll(async () => {
    const ada = await as('ada');
    pantry = (await ada.invoke<{ id: string }>('todo/create-list', { name: 'Pantry' })).id;
    cellar = (await ada.invoke<{ id: string }>('todo/create-list', { name: 'Cellar' })).id;
    await ada.invoke('todo/add-item', { listId: pantry, text: 'cardamom pods' });
    await ada.invoke('todo/add-item', { listId: pantry, text: 'saffron threads' });
    await ada.invoke('todo/add-item', { listId: cellar, text: 'cardamom liqueur' });
  });

  it('finds an item from the start of a word', async () => {
    const ada = await as('ada');
    const found = await ada.invoke<{ results: { text: string }[]; capped: boolean }>(
      'todo/search-list-items',
      { listId: pantry, q: 'carda' },
    );
    expect(found.results.map((r) => r.text)).toEqual(['cardamom pods']);
    // Nothing was withheld, and the screen may say so.
    expect(found.capped).toBe(false);
  });

  it('does not reach a matching item on a list it was not asked about', async () => {
    // 'cardamom liqueur' is in the same scope-wide index and matches the term just
    // as well. Only the `list_id` filter keeps it out — drop it and this returns two.
    const ada = await as('ada');
    const found = await ada.invoke<{ results: { text: string }[] }>('todo/search-list-items', {
      listId: pantry,
      q: 'cardamom',
    });
    expect(found.results.map((r) => r.text)).toEqual(['cardamom pods']);
  });

  it('finds a row written in the breath before', async () => {
    // Maintained by triggers rather than off the event spine, so there is no
    // indexing lag to wait out and no flake to retry around.
    const ada = await as('ada');
    await ada.invoke('todo/add-item', { listId: pantry, text: 'juniper berries' });
    const found = await ada.invoke<{ results: { text: string }[] }>('todo/search-list-items', {
      listId: pantry,
      q: 'juniper',
    });
    expect(found.results.map((r) => r.text)).toEqual(['juniper berries']);
  });

  it('refuses a term too short to index, at the operation boundary', async () => {
    // `q: z.string().min(2)` refuses it before the kernel would, so the caller gets
    // a parse failure naming the field instead of a throw from inside the index.
    const ada = await as('ada');
    await expect(
      ada.invoke('todo/search-list-items', { listId: pantry, q: 'c' }),
    ).rejects.toThrow();
  });

  describe('across every list you can reach', () => {
    it('Ada gets both of her lists in one answer', async () => {
      const ada = await as('ada');
      const found = await ada.invoke<{ results: { text: string }[] }>('todo/search-items', {
        q: 'cardamom',
      });
      expect(found.results.map((r) => r.text).sort()).toEqual([
        'cardamom liqueur',
        'cardamom pods',
      ]);
    });

    it('Björn, shared on one list, finds only that list’s item', async () => {
      const ada = await as('ada');
      await ada.invoke('todo/share-list', { listId: pantry, email: 'bjorn@example.com' });

      const bjorn = await as('bjorn');
      const found = await bjorn.invoke<{ results: { text: string }[] }>('todo/search-items', {
        q: 'cardamom',
      });
      // The Cellar item ranks alongside it and sits in the same index. What keeps it
      // out is the per-list check run AFTER the ranking — never a WHERE on ownership.
      expect(found.results.map((r) => r.text)).toEqual(['cardamom pods']);
    });

    it('Cleo, holding a handle on someone else’s scope, finds nothing', async () => {
      // The index is Ada's scope's and holds every item above; `ctx.search` checks
      // nothing, so an empty answer here is the walk doing its job rather than an
      // empty index.
      const cleo = await host.getScope(world.cleo.principal, world.tenant, world.scope);
      const found = await cleo.invoke<{ results: unknown[] }>('todo/search-items', {
        q: 'cardamom',
      });
      expect(found.results).toEqual([]);
    });
  });
});
