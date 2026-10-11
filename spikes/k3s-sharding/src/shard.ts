/**
 * One scope-host shard: the pod `todo-<i>` of the issue's StatefulSet, as a process.
 *
 * It owns a volume (`<VOLUME>/<NODE>/`, standing for the pod's PVC; here every volume is a
 * directory on one filesystem, which is what lets a takeover reach and fence the previous
 * holder's live files, FINDINGS.md §2) and serves any scope it
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
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { principalId, scopeId as scopeIdOf, tenantId } from '@substrat-run/contracts';
import type { ScopeHost } from '@substrat-run/kernel';
import { LeaseClient, LeaseGuard, NotHolder, UnknownScope, type Grant } from './lease-client.js';
import { Fenced, fenceScopeHost, wrapStubs } from './fence.js';
import { readJson, send, serveLocal } from './http.js';
import { copyScope, openScope, scopeDir, seedScope, type ScopeWorld } from './todo-scope.js';
import { exitWithParent } from './process.js';
import { home } from './placement.js';
import { holdEpoch, installEpochFunction, isFenceRefusal, StaleStamp, StampBusy, stampFence } from './storage-fence.js';

const node = process.env.NODE ?? 'todo-0';
const port = Number(process.env.PORT ?? 0);
const volume = process.env.VOLUME ?? '.data/volumes';
/** `LEASES=off` is the control: no lease checks and no storage fence (`control-plane.ts`). */
const fencing = process.env.LEASES !== 'off';
if (fencing) installEpochFunction();
const leases = new LeaseClient(process.env.CP_URL ?? 'http://127.0.0.1:0', node, Number(process.env.LEASE_MARGIN_MS ?? 400));

type FaultPoint = 'pre-write' | 'in-tx' | 'post-commit';
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

/**
 * The `in-tx` point: inside the kernel's write transaction, holding the scope file's write
 * lock, just before the item row is inserted. better-sqlite3 is synchronous there, so the
 * report cannot be an IPC message (which is flushed asynchronously): it is a marker file the
 * harness watches, written synchronously before the signal.
 */
const faultDir = process.env.FAULT_DIR;
{
  const proto = Database.prototype as unknown as { prepare: (this: Database.Database, sql: string) => Database.Statement };
  const prepare = proto.prepare;
  proto.prepare = function (this: Database.Database, sql: string) {
    const stmt = prepare.call(this, sql);
    if (!/^\s*INSERT INTO todo_items/i.test(sql)) return stmt;
    const run = stmt.run.bind(stmt);
    (stmt as { run: (...a: unknown[]) => Database.RunResult }).run = (...args: unknown[]) => {
      const text = (args.flat() as unknown[]).find((a) => typeof a === 'string' && faults.some((f) => f.point === 'in-tx' && f.text === a));
      const i = faults.findIndex((f) => f.point === 'in-tx' && f.text === text);
      if (i >= 0 && faultDir) {
        const [f] = faults.splice(i, 1);
        writeFileSync(join(faultDir, `${node}--in-tx--${String(text)}`), '');
        process.kill(process.pid, f!.signal);
      }
      return run(...(args as []));
    };
    return stmt;
  };
}

/**
 * The inner host, with each stub reporting the armed faults on either side of its own
 * invocation. Fenced on the outside, so a fault lands between the fence's two checks.
 */
function withFaults(host: ScopeHost): ScopeHost {
  const textOf = (input: unknown) => (input as { text?: string } | undefined)?.text ?? '';
  return wrapStubs(host, (stub) => async (operation, input, options) => {
    await fault('pre-write', textOf(input));
    const out = await stub.invoke(operation, input, options);
    await fault('post-commit', textOf(input));
    return out as never;
  });
}

interface Held {
  /** The scope's own host: what is closed when the scope leaves this shard. */
  host: ScopeHost;
  /** The same host as requests and the background loop see it: faults inside, fence outside. */
  fenced: ScopeHost;
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

/** This shard will not place the scope: doing so could destroy or shadow data. */
class PlacementRefused extends Error {}

/**
 * A new grant: put the scope's latest state on this node's volume before anything runs on
 * it. Called by the guard inside `admit`, so always inside the scope's queue.
 *
 * It fails closed. It deletes nothing: a copy from ANOTHER node (the one the control plane
 * names as holding the latest state) lands beside this node's stale duplicate, which is moved
 * aside (`copyScope`). It seeds only where nothing exists, and it opens this node's own copy
 * only when it is whole. A grant with no `data_on` over an existing directory means the control plane's
 * record and the volume disagree, and that is refused and reported, never repaired.
 */
async function place(scope: string, grant: Grant): Promise<void> {
  const dir = scopeDir(volume, node, scope);
  const stale = held.get(scope);
  /** Close what this shard had open for the scope, then forget it — even if the close throws. */
  const retire = async () => {
    try {
      await stale?.host.close();
    } finally {
      held.delete(scope);
    }
  };
  // From here this process writes the scope as `grant.epoch`; the stamps below are what make
  // every other holder's writes abort (`storage-fence.ts`).
  const stamp = (d: string) => fencing && stampFence(d, grant.epoch);
  holdEpoch(scope, grant.epoch);
  // Nobody settled anywhere else since this shard last had it: what it has open is the latest.
  // If the stamp or the settle fails, the open scope is closed rather than dropped still open.
  if (grant.dataOn === node && stale) {
    try {
      stamp(dir);
      await leases.settle(scope, grant);
    } catch (e) {
      await retire();
      throw e;
    }
    return;
  }
  await retire();
  let placed: { host: ScopeHost; world: ScopeWorld };
  if (grant.dataOn === null) {
    if (existsSync(dir)) {
      throw new PlacementRefused(
        `scope ${scope} has data on ${node}, but the control plane has no copy on record; refusing to seed over it`,
      );
    }
    placed = await seedScope(dir, scope);
    stamp(dir);
  } else if (grant.dataOn === node) {
    // This volume is the copy on record: open it, or refuse — never "repair" it from itself.
    if (!existsSync(join(dir, 'world.json'))) {
      throw new PlacementRefused(
        `scope ${scope}: the control plane names ${node} as holding the latest copy, but it is incomplete here; refusing to place it`,
      );
    }
    stamp(dir);
    placed = openScope(dir);
  } else {
    // Fence the previous holder's files FIRST, under their write lock: a holder that wakes
    // up later aborts at its first write, so the files are quiescent while they are copied.
    const source = scopeDir(volume, grant.dataOn, scope);
    stamp(source);
    await copyScope(source, dir);
    placed = openScope(dir);
  }
  await leases.settle(scope, grant);
  held.set(scope, { ...placed, fenced: fenceScopeHost(withFaults(placed.host), guard) });
}

const guard = new LeaseGuard(leases, { onAcquire: place, fencing: process.env.LEASES !== 'off' });
guard.startRenewing(Number(process.env.LEASE_RENEW_MS ?? 400));

/** The scope's stub, fenced: `admit` first (which may place the data), then the host. */
async function stubFor(scope: string) {
  await guard.admit(scope);
  const { fenced, world } = held.get(scope)!;
  const stub = await fenced.getScope(principalId.parse(world.member), tenantId.parse(world.tenant), scopeIdOf.parse(world.scope));
  return { stub, world };
}

const epochOf = (scope: string) => guard.grant(scope)?.epoch;

/**
 * The scope's files refused a write: another holder stamped a newer epoch. This shard is a
 * stale holder; it forgets the grant and closes the scope, inside the scope's queue.
 */
function dropFenced(scope: string): Promise<void> {
  return serialized(scope, async () => {
    guard.forget(scope);
    const h = held.get(scope);
    held.delete(scope);
    await h?.host.close();
  });
}

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
/**
 * The next slot to run, per scope and epoch: a new holding starts at 0 and replays what is
 * done. Two costs a real design would not pay. A handover costs one invocation per slot
 * since the scope's birth. And it is exactly-once only while the keys are retained: the
 * kernel prunes idempotency records after `IDEMPOTENCY_RETENTION_MS` (24 h), and after that a
 * replay would run an old slot again. The real version keeps a durable per-scope watermark,
 * which is what the kernel's schedule ledger is.
 */
const bgNext = new Map<string, number>();

function ownVolumeScopes(): string[] {
  const dir = join(volume, node, 'scopes');
  // Scope ids only: `copyScope` leaves `<id>.incoming-…` and `<id>.superseded-…` beside them.
  return existsSync(dir) ? readdirSync(dir).filter((n) => !n.includes('.')) : [];
}

async function runDue(scope: string): Promise<void> {
  const { stub, world } = await stubFor(scope);
  const at = `${scope}@${epochOf(scope)}`;
  // Counted from the scope's birth, so every holder agrees on which slots are due.
  const due = Math.floor((Date.now() - world.bornAt) / bgPeriod);
  for (let k = bgNext.get(at) ?? 0; k <= due; k++) {
    await stub.invoke('todo/add-item', { listId: world.listId, text: `bg:${k}` }, { idempotencyKey: `bg:${k}` });
    bgNext.set(at, k + 1);
  }
}

if (bgPeriod > 0) {
  /** Scopes with a pass already queued: a tick slower than the period does not pile up more. */
  const queued = new Set<string>();
  setInterval(() => {
    for (const scope of new Set([...held.keys(), ...ownVolumeScopes()])) {
      if (queued.has(scope)) continue;
      queued.add(scope);
      // Not ours (NotHolder) or lost mid-slot (Fenced): another shard runs it, or will.
      void serialized(scope, () => runDue(scope))
        .catch((e: unknown) => (isFenceRefusal(e) ? dropFenced(scope) : undefined))
        .finally(() => queued.delete(scope));
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

serveLocal(node, port, async (req, res, path) => {
  if (req.method === 'POST' && path === '/_rebalance') {
    return send(res, 200, { moved: await rebalance((await readJson(req)).members as string[]) });
  }
  const m = /^\/scopes\/([^/]+)\/items$/.exec(path);
  if (!m) return send(res, 404, {});
  const scope = decodeURIComponent(m[1]!);
  try {
    if (req.method === 'POST') {
      const b = await readJson(req);
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
    if (isFenceRefusal(e)) {
      await dropFenced(scope);
      return send(res, 503, { error: 'refused at commit by the scope fence: a newer holder took over', node });
    }
    if (e instanceof UnknownScope) return send(res, 404, { error: e.message, node });
    if (e instanceof PlacementRefused) return send(res, 409, { error: e.message, node });
    // Nothing was placed or invoked: a 421 naming no holder, which the router retries here.
    if (e instanceof StampBusy) return send(res, 421, { error: e.message, retryAfterMs: 250, node });
    // A newer takeover already stamped the files: this grant is superseded. Re-resolve.
    if (e instanceof StaleStamp) return send(res, 421, { error: e.message, retryAfterMs: 50, node });
    return send(res, 500, { error: e instanceof Error ? e.message : String(e), node });
  }
});
exitWithParent();
