/**
 * The control plane's lease table (question 2 of #1638), as its own process — the
 * 1-replica StatefulSet + PVC of the issue's mapping, reduced to the one thing a shard asks
 * it here: may I write this scope, and where is its data.
 *
 *   leases(scope PK, holder, epoch, expires_at, data_on)
 *
 * - `provision` creates a scope's row. Only a provisioned scope can be acquired.
 * - `acquire` grants a scope that is unheld, expired, or already the caller's. Each change of
 *   holder bumps `epoch`, the fencing token. Granted together with `data_on`: the node whose
 *   volume holds the scope's latest state, which the new holder copies from (or `null`: a new
 *   scope, seed it).
 * - `renew` extends only the CURRENT (holder, epoch). A holder that slept through its expiry
 *   and finds the epoch moved learns it is fenced here, and stops.
 * - `settle` records that the holder's node's volume now has the data (after the copy).
 * - `release` ends a lease early (a planned move, question 4).
 *
 * A holder is a process incarnation (`todo-1/<boot id>`), so a pod brought back under the
 * same name waits out its predecessor's lease like anyone else (`lease-client.ts`).
 *
 * Every write is one `BEGIN IMMEDIATE` transaction, so two shards racing for one scope are
 * serialized by SQLite and exactly one wins the epoch.
 *
 * `LEASES=off` is the control: the same table, but `acquire` hands the scope to whoever
 * asks, at once, whether or not someone holds it — routing plus a placement table and no
 * lease. `test/kill.test.ts` runs the cluster that way and asserts that it LOSES an
 * acknowledged write, so the lease's absence stays visible rather than argued.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { readJson, send, serveLocal } from './http.js';
import { exitWithParent } from './process.js';

const dir = process.env.CP_DIR ?? '.data/control-plane';
const port = Number(process.env.PORT ?? 0);
const ttlMs = Number(process.env.LEASE_TTL_MS ?? 1500);
const leasesOn = process.env.LEASES !== 'off';
/**
 * `implicit` lets `acquire` create the row of a scope it has never seen. Only the contract
 * binding uses it: there the suite creates scopes the control plane is never told about, and
 * the lease is used for fencing alone — no shard places data from it.
 */
const implicitProvision = process.env.PROVISION === 'implicit';

/**
 * Lease time is this process's MONOTONIC clock, never the wall clock: an NTP step on the
 * control plane must not expire every lease at once while the holders' own monotonic
 * `validUntil` still admits writes. A monotonic reading means nothing to the next
 * incarnation, so at boot every held lease is re-held for one full TTL from now (below).
 */
const now = () => performance.now();

mkdirSync(dir, { recursive: true });
const db = new Database(join(dir, 'leases.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS leases (
  scope TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  data_on TEXT
)`);

// The previous incarnation's expiries are on a clock that no longer exists. Re-hold every
// lease for a whole TTL: a holder that is still alive renews within it, and nobody can be
// granted a scope a live holder might still be writing.
db.prepare("UPDATE leases SET expires_at = ? WHERE holder <> ''").run(now() + ttlMs);

interface LeaseRow {
  scope: string;
  holder: string;
  epoch: number;
  expires_at: number;
  data_on: string | null;
}

type Reply = [status: number, body: unknown];

const read = db.prepare<[string], LeaseRow>('SELECT * FROM leases WHERE scope = ?');
const insert = db.prepare("INSERT OR IGNORE INTO leases (scope, holder, epoch, expires_at, data_on) VALUES (?, '', 0, 0, NULL)");
const extend = db.prepare('UPDATE leases SET expires_at = ? WHERE scope = ?');
const hand = db.prepare('UPDATE leases SET holder = ?, epoch = ?, expires_at = ? WHERE scope = ?');
const place = db.prepare('UPDATE leases SET data_on = ? WHERE scope = ?');

/** The row, if `(holder, epoch)` is still the current grant on it. */
function current(scope: string, holder: string, epoch: number): LeaseRow | undefined {
  const row = read.get(scope);
  return row && row.holder === holder && row.epoch === epoch ? row : undefined;
}

/**
 * A scope exists for the lease table only once it was provisioned. "No row" is never read as
 * "new scope": if this table is lost, every acquire is refused (404) rather than answered with
 * `dataOn: null`, which a shard would take as licence to seed an empty scope over real data.
 */
function provision(scope: string): Reply {
  return [insert.run(scope).changes === 1 ? 201 : 200, {}];
}

function acquire(scope: string, holder: string): Reply {
  const t = now();
  let row = read.get(scope);
  if (!row && implicitProvision) {
    provision(scope);
    row = read.get(scope);
  }
  if (!row) return [404, { error: `unknown scope ${scope}: never provisioned, or this lease table was lost` }];
  if (row.holder === holder && row.expires_at > t) {
    extend.run(t + ttlMs, scope);
    return [200, { epoch: row.epoch, ttlMs, dataOn: row.data_on }];
  }
  if (leasesOn && row.expires_at > t) {
    return [409, { holder: row.holder, epoch: row.epoch, retryAfterMs: row.expires_at - t }];
  }
  const epoch = row.epoch + 1;
  hand.run(holder, epoch, t + ttlMs, scope);
  return [200, { epoch, ttlMs, dataOn: row.data_on }];
}

function renew(scope: string, holder: string, epoch: number): Reply {
  if (!current(scope, holder, epoch)) {
    const row = read.get(scope);
    return [409, row ? { holder: row.holder, epoch: row.epoch, retryAfterMs: Math.max(0, row.expires_at - now()) } : {}];
  }
  extend.run(now() + ttlMs, scope);
  return [200, { epoch, ttlMs }];
}

function settle(scope: string, holder: string, epoch: number, node: string): Reply {
  if (!current(scope, holder, epoch)) return [409, {}];
  place.run(node, scope);
  return [200, {}];
}

function release(scope: string, holder: string, epoch: number): Reply {
  if (!current(scope, holder, epoch)) return [409, {}];
  extend.run(0, scope);
  return [200, {}];
}

const writes = {
  '/lease/provision': db.transaction((b: Record<string, unknown>) => provision(String(b.scope))),
  '/lease/acquire': db.transaction((b: Record<string, unknown>) => acquire(String(b.scope), String(b.holder))),
  '/lease/renew': db.transaction((b: Record<string, unknown>) => renew(String(b.scope), String(b.holder), Number(b.epoch))),
  '/lease/settle': db.transaction((b: Record<string, unknown>) =>
    settle(String(b.scope), String(b.holder), Number(b.epoch), String(b.node)),
  ),
  '/lease/release': db.transaction((b: Record<string, unknown>) => release(String(b.scope), String(b.holder), Number(b.epoch))),
} as const;

serveLocal('control-plane', port, async (req, res, path) => {
  try {
    if (req.method === 'GET' && path.startsWith('/lease/')) {
      const row = read.get(decodeURIComponent(path.slice('/lease/'.length)));
      return row ? send(res, 200, { ...row, now: now() }) : send(res, 404, {});
    }
    if (req.method !== 'POST') return send(res, 405, {});
    const write = writes[path as keyof typeof writes];
    if (!write) return send(res, 404, {});
    const [status, payload] = write.immediate(await readJson(req));
    send(res, status, payload);
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
});
exitWithParent(() => db.close());
