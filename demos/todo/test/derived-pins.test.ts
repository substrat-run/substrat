/**
 * #2157: `todo/list-shares`, whose handler the platform now derives, answers what the hand-written
 * handler it replaced answered.
 *
 * That handler was the check narrowed to the list, `list not found: <id>` for a list that does not
 * exist (reachable only past the check, which in todo no grant passes for a missing list), and
 * `ctx.page` over the list's shares. The oracle is each share as `todo/share-list`
 * answers it — an authored `SELECT * FROM todo_shares` by id, every column the table holds.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorCodeOf, type Page } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';

type Row = Record<string, unknown>;

let dir: string;
let host: ScopeHost;
let world: World;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-derived-pins-'));
  host = buildHost(dir);
  world = await seed(host);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const as = (who: 'ada' | 'bjorn') => host.getScope(world[who].principal, world.tenant, world.scope);

const failure = (call: Promise<unknown>) =>
  call.then(
    () => ['answered'],
    (e: unknown) => [errorCodeOf(e), (e as Error).message],
  );

describe('the derived page of a list answers what the handler it replaced answered (#2157)', () => {
  it("todo/list-shares: the list's shares as the old body read them, and the same refusals", async () => {
    const ada = await as('ada');
    const shared = await ada.invoke<{ id: string }>('todo/create-list', { name: 'Pinned shares' });
    const unshared = await ada.invoke<{ id: string }>('todo/create-list', { name: 'Pinned, alone' });
    const share = await ada.invoke<Row>('todo/share-list', { listId: shared.id, email: world.bjorn.email });

    const page = await ada.invoke<Page<Row>>('todo/list-shares', { listId: shared.id, limit: 100 });
    expect(page.entries).toStrictEqual([share]);

    expect((await ada.invoke<Page<Row>>('todo/list-shares', { listId: unshared.id })).entries).toEqual([]);
    // The check first, as before: nobody holds `list:manage` scope-wide here, so a list that does
    // not exist is one no grant reaches — denied, to its would-be owner too, before any not_found.
    expect((await failure(ada.invoke('todo/list-shares', { listId: 'nope' })))[0]).toBe('permission_denied');
    // And someone who does not manage the list learns nothing about whether it exists.
    const bjorn = await as('bjorn');
    expect((await failure(bjorn.invoke('todo/list-shares', { listId: shared.id })))[0]).toBe('permission_denied');
    expect((await failure(bjorn.invoke('todo/list-shares', { listId: 'nope' })))[0]).toBe('permission_denied');
  });
});
