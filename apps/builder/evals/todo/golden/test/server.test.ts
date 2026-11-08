import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ScopeHost } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';
import { mountApi } from '../src/routes.js';

let dir: string;
let host: ScopeHost;
let world: World;
let app: Hono;

// Stand-in for the real login: the test names the caller by a cast key.
const who: Record<string, () => { p: World['markus']; t: World['tenant']; s: World['scope'] }> = {};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lists-server-'));
  host = buildHost(dir);
  world = await seed(host);
  who.markus = () => ({ p: world.markus, t: world.tenant, s: world.scope });
  who.alice = () => ({ p: world.alice, t: world.tenant, s: world.scope });
  who.dana = () => ({ p: world.dana, t: world.tenant, s: world.scope });
  app = new Hono();
  mountApi(app, async (c) => {
    const key = c.req.header('x-test-user');
    const pick = key ? who[key] : undefined;
    if (!pick) throw new HTTPException(401, { message: 'unauthorized' });
    const { p, t, s } = pick();
    return host.getScope(p.principal, t, s);
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const invoke = (user: string | null, op: string, input: unknown) =>
  app.request('/api/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify({ op, input }),
  });

describe('the HTTP surface', () => {
  let listId: string;

  it('a seeded persona invokes an operation (200) and the write persists', async () => {
    const res = await invoke('markus', 'lists/create-list', { name: 'Groceries' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; name: string };
    expect(body.name).toBe('Groceries');
    listId = body.id;

    const again = await invoke('markus', 'lists/my-lists', {});
    expect(again.status).toBe(200);
    expect(JSON.stringify(await again.json())).toContain('Groceries');
  });

  it('no caller and an unknown caller are 401', async () => {
    expect((await invoke(null, 'lists/my-lists', {})).status).toBe(401);
    expect((await invoke('mallory', 'lists/my-lists', {})).status).toBe(401);
  });

  it('a join with no verified address is 403: the address is the issuer’s, never typed', async () => {
    // This stand-in hands the stub no verified address, so `ctx.verifiedEmail` is null.
    expect((await invoke('dana', 'lists/join', { displayName: 'Dana' })).status).toBe(403);
  });

  it('a collaborator on a guarded operation is 403', async () => {
    await invoke('markus', 'lists/share-list', { listId, email: 'alice@example.com' });
    expect((await invoke('alice', 'lists/add-item', { listId, text: 'milk' })).status).toBe(200);
    expect((await invoke('alice', 'lists/delete-list', { listId })).status).toBe(403);
  });
});
