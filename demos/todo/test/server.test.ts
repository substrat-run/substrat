/**
 * The scenario bypasses HTTP entirely, so this file is the only thing standing
 * between "gates green" and a server that does not actually serve.
 *
 * Driven with `app.request` — no port, no process. The route table under test is
 * DERIVED from the model, so this is also the proof that derivation produces a
 * surface that works, not merely one that mounts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { principalId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { buildHost, seed, type World } from '../src/seed.js';
import { mountApi } from '../src/routes.js';

let dir: string;
let host: ScopeHost;
let world: World;
let app: Hono;
let mounted: { operation: string; method: string; path: string }[];

const req = (path: string, who?: string, init?: RequestInit) =>
  app.request(path, {
    ...init,
    headers: who ? { 'x-principal': who, ...(init?.headers ?? {}) } : (init?.headers ?? {}),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'todo-server-'));
  host = buildHost(dir);
  world = await seed(host);

  app = new Hono();
  const cast = [world.ada, world.bjorn];
  mounted = mountApi(app, async (c) => {
    const header = c.req.header('x-principal');
    if (!header) throw new HTTPException(401, { message: 'x-principal header required' });
    const who = cast.find((p) => p.name === header);
    if (!who) throw new HTTPException(401, { message: `unknown principal: ${header}` });
    return host.getScope(principalId.parse(who.principal), world.tenant, world.scope);
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the derived route table, served', () => {
  it('mounts every operation the model declares an http shape for', () => {
    // Fourteen of fourteen — a derived table that silently mounted nothing would
    // otherwise pass every test below that expects a 4xx. The count is pinned on
    // purpose: adding an operation to the model should make somebody look here.
    // Twelve until #827 added the two search reads.
    expect(mounted).toHaveLength(14);
  });

  it('serves a real operation for a seeded persona', async () => {
    const res = await req('/api/lists', 'Ada', {
      method: 'POST',
      body: JSON.stringify({ name: 'Groceries' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('Groceries');
  });

  it('a second request sees the first one’s write', async () => {
    // The host is built once on a persistent dir; a per-request or :memory:
    // host fails exactly here and nowhere else.
    const res = await req('/api/lists', 'Ada');
    expect(((await res.json()) as { name: string }[]).map((l) => l.name)).toEqual(['Groceries']);
  });

  it('no header is 401', async () => {
    expect((await req('/api/lists')).status).toBe(401);
  });

  it('an unknown principal is 401', async () => {
    expect((await req('/api/lists', 'Mallory')).status).toBe(401);
  });

  it('a refused permission is 403, not 500', async () => {
    const lists = (await (await req('/api/lists', 'Ada')).json()) as { id: string }[];
    const res = await req(`/api/lists/${lists[0]!.id}`, 'Björn', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(res.status).toBe(403);
  });

  it('a list that does not exist is indistinguishable from one you may not see', async () => {
    // 403, not 404, and deliberately so: the permission check runs before the
    // row is read, so a stranger cannot probe for which ids exist.
    expect((await req('/api/lists/nope/items', 'Ada')).status).toBe(403);
  });

  it('a genuinely missing thing is 404', async () => {
    const lists = (await (await req('/api/lists', 'Ada')).json()) as { id: string }[];
    const res = await req(`/api/lists/${lists[0]!.id}/shares`, 'Ada', {
      method: 'POST',
      body: JSON.stringify({ email: 'nobody@example.com' }),
    });
    expect(res.status).toBe(404);
  });

  it('path parameters reach the operation', async () => {
    const lists = (await (await req('/api/lists', 'Ada')).json()) as { id: string }[];
    const res = await req(`/api/lists/${lists[0]!.id}/items`, 'Ada', {
      method: 'POST',
      body: JSON.stringify({ text: 'milk' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { list_id: string }).list_id).toBe(lists[0]!.id);
  });
});
