/**
 * One scope-host shard: the pod `todo-<i>` of the issue's StatefulSet, as a process.
 *
 * It owns a node-local volume (`<VOLUME>/<NODE>/`, the pod's PVC) and serves any scope it
 * holds the lease on. A request for a scope it does not hold makes it ask the control plane;
 * when granted, the scope's data is placed first — seeded if new, opened if this volume
 * already has the latest copy, copied from the previous holder's volume otherwise — and
 * then served.
 *
 * Inside the process each scope has one queue, the actor queue K-6 relies on: every
 * request for a scope runs after the previous one finished, so `ctx.sql` stays the only
 * writer on its connection. ACROSS processes the queue proves nothing, which is the point
 * of the spike.
 *
 * HTTP, all JSON:
 *   POST /scopes/:scope/items {text}   + Idempotency-Key   → the item, plus {node, epoch}
 *   GET  /scopes/:scope/items                              → {entries, node, epoch}
 *   421 {holder, epoch, retryAfterMs}  — not mine; ask the holder (or wait for it)
 *
 * Faults are armed over IPC by the test (`{ arm: { text, point, signal } }`): when the write
 * with that text reaches `point`, the shard reports it and sends itself `signal`. Signalling
 * itself is what makes the kill land at exactly that point, every run.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { principalId, tenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { LeaseClient, NotHolder, type Grant } from './lease-client.js';
import { copyScope, openScope, scopeDir, seedScope, type ScopeWorld } from './todo-scope.js';
import { exitWithParent } from './process.js';

const node = process.env.NODE ?? 'todo-0';
const port = Number(process.env.PORT ?? 0);
const volume = process.env.VOLUME ?? '.data/volumes';
const leases = new LeaseClient(process.env.CP_URL ?? 'http://127.0.0.1:0', node, Number(process.env.LEASE_MARGIN_MS ?? 400));

export type FaultPoint = 'pre-write' | 'post-commit';
interface Fault {
  text: string;
  point: FaultPoint;
  signal: NodeJS.Signals;
}
const faults: Fault[] = [];
process.on('message', (m: { arm?: Fault }) => {
  if (m.arm) faults.push(m.arm);
});

async function fault(point: FaultPoint, text: string): Promise<void> {
  const i = faults.findIndex((f) => f.point === point && f.text === text);
  if (i < 0) return;
  const [f] = faults.splice(i, 1);
  // Report first, and only then signal: the message must be out before a SIGSTOP or SIGKILL.
  await new Promise<void>((resolve) => process.send!({ at: point, text, node }, () => resolve()));
  process.kill(process.pid, f!.signal);
}

interface Held {
  host: ScopeHost;
  world: ScopeWorld;
  grant: Grant;
}
const held = new Map<string, Held>();
const queues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier request for `scope` has finished — the per-scope actor queue. */
function serialized<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(scope) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(
    scope,
    run.catch(() => undefined),
  );
  return run;
}

async function take(scope: string): Promise<Held> {
  const have = held.get(scope);
  if (have) return have;
  const grant = await leases.acquire(scope);
  const dir = scopeDir(volume, node, scope);
  let placed: { host: ScopeHost; world: ScopeWorld };
  if (grant.dataOn === null) {
    rmSync(dir, { recursive: true, force: true });
    placed = await seedScope(dir, scope);
  } else if (grant.dataOn === node && existsSync(join(dir, 'world.json'))) {
    placed = openScope(dir);
  } else {
    await copyScope(scopeDir(volume, grant.dataOn, scope), dir);
    placed = openScope(dir);
  }
  await leases.settle(scope, grant);
  const h: Held = { ...placed, grant };
  held.set(scope, h);
  return h;
}

async function stubOf(h: Held) {
  return h.host.getScope(principalId.parse(h.world.member), tenantId.parse(h.world.tenant), h.world.scope as never);
}

async function addItem(scope: string, text: string, key: string | undefined) {
  return serialized(scope, async () => {
    const h = await take(scope);
    const stub = await stubOf(h);
    await fault('pre-write', text);
    const item = await stub.invoke<Record<string, unknown>>(
      'todo/add-item',
      { listId: h.world.listId, text },
      key ? { idempotencyKey: key } : undefined,
    );
    await fault('post-commit', text);
    return { ...item, node, epoch: h.grant.epoch };
  });
}

async function listItems(scope: string) {
  return serialized(scope, async () => {
    const h = await take(scope);
    const stub = await stubOf(h);
    const entries: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const page: { entries: Array<Record<string, unknown>>; nextCursor: string | null } = await stub.invoke(
        'todo/list-items',
        { listId: h.world.listId, limit: 200, ...(cursor ? { cursor } : {}) },
      );
      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    return { entries, node, epoch: h.grant.epoch };
  });
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = createServer((req, res) => {
  void (async () => {
    const m = /^\/scopes\/([^/]+)\/items$/.exec(new URL(req.url ?? '/', 'http://shard').pathname);
    if (!m) return send(res, 404, {});
    const scope = decodeURIComponent(m[1]!);
    try {
      if (req.method === 'POST') {
        const b = await body(req);
        const key = req.headers['idempotency-key'];
        return send(res, 200, await addItem(scope, String(b.text), typeof key === 'string' ? key : undefined));
      }
      if (req.method === 'GET') return send(res, 200, await listItems(scope));
      return send(res, 405, {});
    } catch (e) {
      if (e instanceof NotHolder) {
        return send(res, 421, { holder: e.holder, epoch: e.epoch, retryAfterMs: e.retryAfterMs, node });
      }
      return send(res, 500, { error: e instanceof Error ? e.message : String(e), node });
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  process.send?.({ ready: node, port: typeof addr === 'object' && addr ? addr.port : port });
});
exitWithParent();
