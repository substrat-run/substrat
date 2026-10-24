/**
 * Every refusal a vertical-host route decides itself is a problem document (#113, item 6).
 *
 * `onError` only sees a throw; a route that answers `501 this deployment cannot …` never
 * threw, and used to answer `application/json`. Here every `/internal` 501 is reached on a
 * host that declares none of the optional verbs, and the live-read refusals on the pure host.
 * The status and the `error` sentence are unchanged at every site: the document carries
 * `error` beside `detail` until the deprecation window closes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  PLATFORM_SECRET_HEADER,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPE_BLANK,
  problemForStatus,
  scopeId,
  tenantId,
} from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { mountPlatformSurface, type VerticalScopeHost } from '../src/index.js';
import { mountLiveReads } from '../src/live.js';

type Env = { PLATFORM_SECRET: string };
const ENV: Env = { PLATFORM_SECRET: 'sekret' };
const t = tenantId.parse(ulid());
const s = scopeId.parse(ulid());

const bare = new Hono<{ Bindings: Env }>();
mountPlatformSurface<Env>(bare, {
  platformSecret: (env: Env) => env.PLATFORM_SECRET,
  hostFor: () => ({}) as unknown as VerticalScopeHost,
  roles: [],
  ownerRoleKey: 'lead',
  resolveOwner: async () => null,
  transferOwner: async () => ({ outcome: 'transferred' }),
  completeOwnerTransfer: async () => ({ outcome: 'completed' }),
} as never);

const headers = { [PLATFORM_SECRET_HEADER]: ENV.PLATFORM_SECRET, 'content-type': 'application/json' };
const ids = { tenantId: t, scopeId: s };
const at = '2026-10-18T10:00:00.000Z';
const event = ulid();

/** [route, method, body] — the body is just enough to get past parsing to the refusal. */
const NOT_IMPLEMENTED: readonly (readonly [string, 'GET' | 'POST', Record<string, unknown>])[] = [
  ['/internal/load-marker', 'GET', {}],
  // #2450: the paged copy verbs.
  ['/internal/export-page', 'GET', {}],
  ['/internal/stage', 'POST', { scopeId: s, stageId: 'stage-1', seq: 0, tables: [] }],
  ['/internal/restore-staged', 'POST', { ...ids, stageId: 'stage-1' }],
  ['/internal/stage/discard', 'POST', { scopeId: s, stageId: 'stage-1' }],
  ['/internal/kept-copy', 'GET', {}],
  ['/internal/kept-copy/release', 'POST', { scopeId: s, revision: null }],
  ['/internal/kept-copy/discard', 'POST', { scopeId: s, revision: null, carriedTo: 'other', at }],
  ['/internal/wipe-carried', 'POST', { scopeId: s, expectLoadStamp: null, carriedTo: 'other', at }],
  ['/internal/redrain-count', 'POST', { scopeId: s, drainedBefore: at }],
  ['/internal/database-size', 'GET', {}],
  ['/internal/attachment-size', 'GET', {}],
  ['/internal/attachment-sweep', 'POST', { ...ids, dryRun: true, copiesSettled: true, expectedVersionId: 'v1' }],
  ['/internal/redact-subject', 'POST', { scopeId: s, subjectId: 'subject-1' }],
  ['/internal/connector-grants', 'POST', ids],
  ['/internal/system-switch', 'POST', { scopeId: s, moduleId: 'todo', to: 'off' }],
  ['/internal/switch-fence', 'GET', {}],
  ['/internal/lifecycle', 'POST', { scopeId: s, lifecycle: { scope: 'active', tenant: 'active', at, revision: { epoch: 0, scope: 0, tenant: 0 } } }],
  ['/internal/system-grants', 'GET', {}],
  ['/internal/peer-grants', 'GET', {}],
  ['/internal/vertical-invoke', 'POST', { ...ids, caller: { vertical: 'peer', scope: s }, operation: 'noop' }],
  ['/internal/peer-switch', 'POST', { scopeId: s, vertical: 'peer', to: 'off' }],
  ['/internal/exported-events', 'POST', { ...ids, input: { consumer: 'peer', after: null, wants: [{ type: 'todo.done', schemaVersion: 1 }], limit: 10 } }],
  ['/internal/import-state', 'GET', {}],
  ['/internal/import-cursor', 'POST', { ...ids, at: { move: { mode: 'replay', from: 'peer', after: null, acknowledge: 'rerun-handlers', reason: 'test' }, source: { vertical: 'peer', scopeId: s }, replayId: ulid() } }],
  ['/internal/import-events', 'POST', { ...ids, batch: { source: { vertical: 'peer', scopeId: s }, after: null, next: event, events: [], withheld: [] } }],
  ['/internal/owner-transfer', 'POST', { ...ids, from: ulid(), to: ulid() }],
];

async function call(route: string, method: 'GET' | 'POST', body: Record<string, unknown>): Promise<Response> {
  const query = method === 'GET' ? `?${new URLSearchParams({ tenantId: t, scopeId: s })}` : '';
  return bare.request(
    `${route}${query}`,
    { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) },
    ENV,
  );
}

describe('/internal refusals are problem documents', () => {
  it.each(NOT_IMPLEMENTED)('%s answers a 501 problem on a deployment without the verb', async (route, method, body) => {
    const res = await call(route, method, body);
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    const doc = await res.json();
    expect(doc).toMatchObject({
      type: PROBLEM_TYPE_BLANK,
      title: 'Not implemented',
      status: 501,
      instance: route,
      detail: expect.stringMatching(/redeploy it|unavailable in this deployment|Redeploy it/),
    });
    // Beside the document, until item (e) drops it: the sentence every client reads today.
    expect(doc.error).toBe(doc.detail);
  });

  it('redrain-events refuses countOnly with a validation_failed problem, still 400', async () => {
    const res = await call('/internal/redrain-events', 'POST', { ...ids, countOnly: true });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(await res.json()).toMatchObject({
      status: 400,
      code: 'validation_failed',
      detail: 'countOnly is not honoured here — POST to /internal/redrain-count instead',
      error: 'countOnly is not honoured here — POST to /internal/redrain-count instead',
    });
  });
});

describe('the live-read refusals are problem documents, headers intact', () => {
  const app = new Hono();
  mountLiveReads(app, { live: () => undefined, subscriber: async () => null });
  const upgrade = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13' };
  const ask = (h: Record<string, string>) => app.request('http://localhost:5277/api/live', { headers: h });

  it('426 for a request that is not a handshake', async () => {
    const res = await ask({});
    expect(res.status).toBe(426);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.headers.get('x-substrat-live')).toBe('not-an-upgrade');
    expect(await res.json()).toMatchObject({ status: 426, title: 'Upgrade required', error: 'live reads are a WebSocket surface' });
  });

  it('501 with the poll header on a host with no live reads', async () => {
    const res = await ask({ ...upgrade, origin: 'http://localhost:5277' });
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.headers.get('x-substrat-live')).toBe('poll');
    expect(await res.json()).toMatchObject({ status: 501, error: 'live reads are not available on this host; poll instead' });
  });

  it('403 forbidden for another origin, with no live header', async () => {
    const res = await ask({ ...upgrade, origin: 'http://localhost:9999' });
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(res.headers.get('x-substrat-live')).toBeNull();
    expect(await res.json()).toMatchObject({ code: 'forbidden', error: 'live reads are only offered to this app’s own pages' });
  });

  it('401 unauthenticated when nobody is asking', async () => {
    const live = new Hono();
    mountLiveReads(live, { live: () => ({ subscribe: async () => new Response(null) }), subscriber: async () => null });
    const res = await live.request('http://localhost:5277/api/live', { headers: { ...upgrade, origin: 'http://localhost:5277' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe(PROBLEM_CONTENT_TYPE);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated', error: 'unauthorized' });
  });
});

describe('every status these routes emit has a real title', () => {
  it.each([400, 401, 403, 426, 501])('%i is not the class-wide phrase', (status) => {
    expect(['Request failed', 'Server error']).not.toContain(problemForStatus(status).title);
  });
});

/** Whole-file, whitespace-normalised: a wrapped `c.json(\n  { error: … }, 501)` is the same offence. */
function bareErrorCalls(src: string): string[] {
  const flat = src.replace(/\s+/g, ' ');
  return [...flat.matchAll(/\.(?:json|body|text)\(\s*\{\s*error\b[^)]{0,80}/g)].map((m) => m[0]);
}

describe('no route in index.ts or live.ts answers a bare { error } again', () => {
  it('sees the wrapped form, not only the one-line one', () => {
    expect(bareErrorCalls("return c.json({ error: 'x' }, 501);")).toHaveLength(1);
    expect(bareErrorCalls("return c.json(\n  { error: 'x' },\n  501,\n);")).toHaveLength(1);
    expect(bareErrorCalls("return refuseStatus(c, 501, 'x');")).toEqual([]);
  });

  it.each(['../src/index.ts', '../src/live.ts'])('%s', (file) => {
    const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    expect(bareErrorCalls(src)).toEqual([]);
  });
});
