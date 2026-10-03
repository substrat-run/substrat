/**
 * A paged read's declared `order`, through the doors a caller reaches it by (#2001).
 *
 * `paged: { over, order: 'desc' }` used to be read by ONE thing — the OpenAPI emitter,
 * which advertised `desc` as the default — while the route forwarded `order` only when
 * a caller sent one and `ctx.page` fell back to `asc`. So the document promised
 * newest-first and the endpoint served oldest-first.
 *
 * Driven against a REAL `SqliteScopeHost` rather than the echoing stub the route tests
 * use, because the default is applied where the host parses the invocation: a stub
 * that records the payload would show the route sending no `order`, which is correct
 * and proves nothing about what is served.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  PAGE_CURSOR_RESTART,
  PAGE_LINK_HEADER,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  toProblem,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { listMod } from '@substrat-run/contract-tests';
import { mountOperations } from '../src/operations-routes.js';

/** The declared surface: `list/newest` declares `desc`, and its handler names no order. */
const operations = {
  'list/newest': {
    paged: { over: { entity: 'listorder', sortable: ['number', 'status', 'id'] }, order: 'desc' },
    http: { method: 'GET', path: '/orders' },
  },
} as const;

type Row = { id: string; number: string };

describe('a declared order, served through every door (#2001)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'substrat-paged-order-'));
  const sqlite = new SqliteScopeHost({ dir });
  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const alice: PrincipalId = principalId.parse(ulid());

  const app = new Hono();
  // An app that owns no envelope: the kernel's problem document, as a vertical's
  // `app.onError` would render it.
  app.onError((err) => {
    const problem = toProblem((err as { cause?: unknown }).cause ?? err);
    return Response.json(problem, { status: problem.status });
  });
  mountOperations(app, operations, async () => sqlite.getScope(alice, t, s));

  const numbersOf = (rows: Row[]) => rows.map((r) => r.number);

  /** The next page's path and query, from a response's `Link` header. */
  const nextOf = (res: Response): URL | null => {
    const link = res.headers.get(PAGE_LINK_HEADER);
    return link ? new URL(/<([^>]+)>/.exec(link)![1]!) : null;
  };

  /** Follow the `Link` header to the end, as a client does. */
  const walk = async (first: string): Promise<string[]> => {
    const seen: string[] = [];
    let url: string | null = first;
    for (let guard = 0; url !== null && guard < 10; guard++) {
      const res: Response = await app.request(url);
      expect(res.status).toBe(200);
      seen.push(...numbersOf((await res.json()) as Row[]));
      const next = nextOf(res);
      url = next ? next.pathname + next.search : null;
    }
    return seen;
  };

  async function rpc(params: unknown) {
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await res.json()) as any;
  }

  beforeAll(async () => {
    const use = permissionKey.parse('list:use');
    sqlite.registerModule(listMod);
    await sqlite.admin.createTenant(staff, { id: t, slug: `paged-${t.slice(-8).toLowerCase()}`, name: 'Paged' });
    await sqlite.admin.grantEntitlement(staff, t, 'list');
    await sqlite.provisionScope(staff, { tenantId: t, scopeId: s });
    await sqlite.admin.activateScope(staff, t, s);
    await sqlite.admin.defineRole(staff, t, { key: 'owner', permissions: [use], source: 'vertical' });
    await sqlite.admin.assignRole(staff, { principalId: alice, roleKey: 'owner', node: { tenantId: t, scopeId: null } });
    const stub = await sqlite.getScope(alice, t, s);
    for (const [i, id] of ['01A', '01B', '01C', '01D', '01E'].entries()) {
      await stub.invoke('list/add', { id, number: `100${i + 1}`, status: 'open', kind: 'repair' });
    }
  });

  afterAll(async () => {
    await sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('over HTTP', () => {
    it('serves the declared desc when the request names no order', async () => {
      const res = await app.request('/api/orders?limit=2');
      expect(numbersOf((await res.json()) as Row[])).toEqual(['1005', '1004']);
    });

    it('lets ?order= override it', async () => {
      const res = await app.request('/api/orders?order=asc&limit=2');
      expect(numbersOf((await res.json()) as Row[])).toEqual(['1001', '1002']);
    });

    it('continues the declared walk across pages by the Link header', async () => {
      expect(await walk('/api/orders?limit=2')).toEqual(['1005', '1004', '1003', '1002', '1001']);
      expect(await walk('/api/orders?limit=2&order=asc')).toEqual(['1001', '1002', '1003', '1004', '1005']);
    });

    it('refuses a desc cursor replayed under ?order=asc with a 400 that says to restart', async () => {
      const first = await app.request('/api/orders?limit=2');
      const cursor = nextOf(first)!.searchParams.get('cursor')!;
      const res = await app.request(`/api/orders?limit=2&order=asc&cursor=${encodeURIComponent(cursor)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        code: 'validation_failed',
        reason: PAGE_CURSOR_RESTART,
        detail: expect.stringMatching(/restart paging/),
      });
    });
  });

  describe('over MCP', () => {
    it('advertises the declared order as the default', async () => {
      const res = await app.request('/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tool = ((await res.json()) as any).result.tools.find((x: { name: string }) => x.name === 'list_newest');
      expect(tool.inputSchema.properties.order.default).toBe('desc');
    });

    it('serves the declared desc when the call names no order, and walks it by cursor', async () => {
      const seen: string[] = [];
      let cursor: string | null | undefined;
      for (let guard = 0; cursor !== null && guard < 10; guard++) {
        const body = await rpc({ name: 'list_newest', arguments: { limit: 2, ...(cursor ? { cursor } : {}) } });
        const page = body.result.structuredContent as { entries: Row[]; nextCursor: string | null };
        seen.push(...numbersOf(page.entries));
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(['1005', '1004', '1003', '1002', '1001']);
    });

    it('lets an explicit order override it', async () => {
      const body = await rpc({ name: 'list_newest', arguments: { limit: 2, order: 'asc' } });
      expect(numbersOf(body.result.structuredContent.entries)).toEqual(['1001', '1002']);
    });
  });
});
