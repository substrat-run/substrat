/**
 * `todo/my-lists` never hands Björn the position of a list he cannot see (#2073).
 *
 * Ada's and Björn's lists are created interleaved, so every page boundary of Björn's walk sits
 * next to one of Ada's. The cursor is the kernel's own envelope — base64url JSON carrying the
 * row's id (K-44) — so it is decoded here and judged against the lists he owns. Read from the
 * producer rather than a fake: the walk is `ctx.page`'s, the check is the vertical's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@substrat-run/contracts';
import type { ScopeHost, ScopeStub } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let ada: ScopeStub;
let bjorn: ScopeStub;
const his: string[] = [];
const hers: string[] = [];

type List = { id: string; name: string };

/** The row id inside a `ctx.page` cursor: the tie-break, or the value when the walk sorts by id. */
function idIn(cursor: string): string {
  const json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { value: string; id?: string };
  return json.id ?? json.value;
}

async function walk(who: ScopeStub, limit: number, view?: 'archived') {
  const ids: string[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = await who.invoke<Page<List>>('todo/my-lists', { limit, ...(cursor ? { cursor } : {}), ...(view ? { view } : {}) });
    ids.push(...page.entries.map((l) => l.id));
    if (page.nextCursor === null) return { ids, cursors };
    cursors.push(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error('the walk did not end');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-cursor-'));
  host = buildHost(dir);
  world = await seed(host);
  ada = await host.getScope(world.ada.principal, world.tenant, world.scope);
  bjorn = await host.getScope(world.bjorn.principal, world.tenant, world.scope);
  for (let i = 0; i < 4; i++) {
    hers.push((await ada.invoke<List>('todo/create-list', { name: `Ada ${i}` })).id);
    hers.push((await ada.invoke<List>('todo/create-list', { name: `Ada ${i}b` })).id);
    his.push((await bjorn.invoke<List>('todo/create-list', { name: `Björn ${i}` })).id);
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("my-lists hands out no position of a list the caller cannot see (#2073)", () => {
  for (const limit of [1, 2, 3]) {
    it(`limit ${limit}: Björn reaches each of his lists, and every cursor is one of his`, async () => {
      const { ids, cursors } = await walk(bjorn, limit);
      expect(ids).toEqual(his);
      expect(cursors.length).toBeGreaterThan(0);
      for (const c of cursors) expect(his, `cursor at ${idIn(c)}`).toContain(idIn(c));
    });
  }

  it('the archived view walks the same way', async () => {
    for (const id of his.slice(0, 2)) await bjorn.invoke('todo/archive-list', { listId: id });
    for (const id of hers.slice(0, 5)) await ada.invoke('todo/archive-list', { listId: id });
    const { ids, cursors } = await walk(bjorn, 1, 'archived');
    expect(ids).toEqual(his.slice(0, 2));
    for (const c of cursors) expect(his.slice(0, 2)).toContain(idIn(c));
    expect((await walk(bjorn, 1)).ids).toEqual(his.slice(2));
  });
});
