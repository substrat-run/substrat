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
 *   POST /_rebalance {members}         → release every held scope whose home moved (question 4)
 *
 * Background work (question 6): with `BG_PERIOD_MS` set, every period the shard runs the due
 * slots of each scope it holds — or can take: the scopes on its own volume, so a pod the
 * StatefulSet brought back picks its scopes up again without waiting for a request. A slot
 * is one `todo/add-item` of `bg:<k>` under the idempotency key `bg:<k>`, through the same
 * fenced stub as a request: the lease is what lets only one shard run it, the key is what
 * makes a slot the previous holder finished (or half-finished) a replay on the next.
 *
 * Faults are armed over IPC by the test (`{ arm: { text, point, signal } }`): when the write
 * with that text reaches `point`, the shard reports it and sends itself `signal`. Signalling
 * itself is what makes the kill land at exactly that point, every run.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { principalId, tenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { LeaseClient, LeaseGuard, NotHolder, type Grant } from './lease-client.js';
import { Fenced, fenceScopeHost, type FenceHooks } from './fence.js';
import { copyScope, openScope, scopeDir, seedScope, type ScopeWorld } from './todo-scope.js';
import { exitWithParent } from './process.js';
import { home } from './placement.js';

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

/**
 * A new grant: put the scope's latest state on this node's volume before anything runs on
 * it. Called by the guard inside `admit`, so always inside the scope's queue.
 */
async function place(scope: string, grant: Grant): Promise<void> {
  const dir = scopeDir(volume, node, scope);
  const stale = held.get(scope);
  held.delete(scope);
  let placed: Held;
  if (grant.dataOn === node && stale) {
    placed = stale;
  } else {
    await stale?.host.close();
    if (grant.dataOn === null) {
      rmSync(dir, { recursive: true, force: true });
      placed = await seedScope(dir, scope);
    } else if (grant.dataOn === node && existsSync(join(dir, 'world.json'))) {
      placed = openScope(dir);
    } else {
      await copyScope(scopeDir(volume, grant.dataOn, scope), dir);
      placed = openScope(dir);
    }
  }
  await leases.settle(scope, grant);
  held.set(scope, placed);
}

const guard = new LeaseGuard(leases, { onAcquire: place, fencing: process.env.LEASES !== 'off' });
guard.startRenewing(Number(process.env.LEASE_RENEW_MS ?? 400));

const hooks: FenceHooks = {
  beforeInvoke: async (_scope, _op, input) => fault('pre-write', (input as { text?: string }).text ?? ''),
  afterInvoke: async (_scope, _op, input) => fault('post-commit', (input as { text?: string }).text ?? ''),
};

/** The scope's stub, fenced: `admit` first (which may place the data), then the host. */
async function stubFor(scope: string) {
  await guard.admit(scope);
  const h = held.get(scope)!;
  const host = fenceScopeHost(h.host, guard, hooks);
  const stub = await host.getScope(principalId.parse(h.world.member), tenantId.parse(h.world.tenant), h.world.scope as never);
  return { stub, world: h.world };
}

const epochOf = (scope: string) => guard.grant(scope)?.epoch;

async function addItem(scope: string, text: string, key: string | undefined) {
  return serialized(scope, async () => {
    const { stub, world } = await stubFor(scope);
    const item = await stub.invoke<Record<string, unknown>>(
      'todo/add-item',
      { listId: world.listId, text },
      key ? { idempotencyKey: key } : undefined,
    );
    return { ...item, node, epoch: epochOf(scope) };
  });
}

async function listItems(scope: string) {
  return serialized(scope, async () => {
    const { stub, world } = await stubFor(scope);
    const entries: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    do {
      const page: { entries: Array<Record<string, unknown>>; nextCursor: string | null } = await stub.invoke(
        'todo/list-items',
        { listId: world.listId, limit: 200, ...(cursor ? { cursor } : {}) },
      );
      entries.push(...page.entries);
      cursor = page.nextCursor;
    } while (cursor);
    return { entries, node, epoch: epochOf(scope) };
  });
}

const bgPeriod = Number(process.env.BG_PERIOD_MS ?? 0);
/** The next slot to run, per scope and epoch: a new holding starts at 0 and replays what is done. */
const bgNext = new Map<string, number>();

function ownVolumeScopes(): string[] {
  const dir = join(volume, node, 'scopes');
  return existsSync(dir) ? readdirSync(dir) : [];
}

async function runDue(scope: string): Promise<void> {
  const { stub, world } = await stubFor(scope);
  const at = `${scope}@${guard.grant(scope)?.epoch}`;
  // Counted from the scope's birth, so every holder agrees on which slots are due.
  const due = Math.floor((Date.now() - world.bornAt) / bgPeriod);
  for (let k = bgNext.get(at) ?? 0; k <= due; k++) {
    await stub.invoke('todo/add-item', { listId: world.listId, text: `bg:${k}` }, { idempotencyKey: `bg:${k}` });
    bgNext.set(at, k + 1);
  }
}

if (bgPeriod > 0) {
  setInterval(() => {
    for (const scope of new Set([...held.keys(), ...ownVolumeScopes()])) {
      // Not ours (NotHolder) or lost mid-slot (Fenced): another shard runs it, or will.
      void serialized(scope, () => runDue(scope)).catch(() => undefined);
    }
  }, bgPeriod);
}

/**
 * A planned move (question 4): for each scope whose home is no longer this shard, finish what
 * is queued, release the lease and close the scope. The new home takes it on its next request
 * — the release is what lets it do so at once, instead of waiting out a TTL — and copies it
 * from this volume, which the control plane still names as `data_on`.
 */
async function rebalance(members: string[]): Promise<string[]> {
  const moved = [...held.keys()].filter((scope) => home(scope, members) !== node);
  await Promise.all(
    moved.map((scope) =>
      serialized(scope, async () => {
        const grant = guard.grant(scope);
        const h = held.get(scope);
        held.delete(scope);
        guard.forget(scope);
        if (grant) await leases.release(scope, grant);
        await h?.host.close();
      }),
    ),
  );
  return moved;
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
    const path = new URL(req.url ?? '/', 'http://shard').pathname;
    if (req.method === 'POST' && path === '/_rebalance') {
      return send(res, 200, { moved: await rebalance((await body(req)).members as string[]) });
    }
    const m = /^\/scopes\/([^/]+)\/items$/.exec(path);
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
      if (e instanceof Fenced) return send(res, 503, { error: e.message, node });
      return send(res, 500, { error: e instanceof Error ? e.message : String(e), node });
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  process.send?.({ ready: node, port: typeof addr === 'object' && addr ? addr.port : port });
});
exitWithParent();
