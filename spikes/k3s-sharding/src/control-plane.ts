/**
 * The control plane's lease table (question 2 of #1638), as its own process — the
 * 1-replica StatefulSet + PVC of the issue's mapping, reduced to the one thing a shard asks
 * it here: may I write this scope, and where is its data.
 *
 *   leases(scope PK, holder, epoch, expires_at, data_on)
 *
 * - `acquire` grants a scope that is unheld, expired, or already the caller's. Each change of
 *   holder bumps `epoch`, the fencing token. Granted together with `data_on`: the node whose
 *   volume holds the scope's latest state, which the new holder copies from (or `null`: a new
 *   scope, seed it).
 * - `renew` extends only the CURRENT (holder, epoch). A holder that slept through its expiry
 *   and finds the epoch moved learns it is fenced here, and stops.
 * - `settle` records that the holder's node's volume now has the data (after the copy).
 *
 * A holder is a process incarnation (`todo-1/<boot id>`), so a pod brought back under the
 * same name waits out its predecessor's lease like anyone else (`lease-client.ts`).
 * - `release` ends a lease early (a planned move, question 4).
 *
 * Every write is one `BEGIN IMMEDIATE` transaction, so two shards racing for one scope are
 * serialized by SQLite and exactly one wins the epoch.
 *
 * `LEASES=off` is the control: the same table, but `acquire` hands the scope to whoever
 * asks, at once, whether or not someone holds it — routing plus a placement table and no
 * lease. `test/kill.test.ts` runs the cluster that way and asserts that it LOSES an
 * acknowledged write, so the lease's absence stays visible rather than argued.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { exitWithParent } from './process.js';

const dir = process.env.CP_DIR ?? '.data/control-plane';
const port = Number(process.env.PORT ?? 0);
const ttlMs = Number(process.env.LEASE_TTL_MS ?? 1500);
const leasesOn = process.env.LEASES !== 'off';

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

interface LeaseRow {
  scope: string;
  holder: string;
  epoch: number;
  expires_at: number;
  data_on: string | null;
}

type Reply = [status: number, body: unknown];

const read = db.prepare<[string], LeaseRow>('SELECT * FROM leases WHERE scope = ?');

const acquire = db.transaction((scope: string, holder: string): Reply => {
  const now = Date.now();
  const row = read.get(scope);
  if (!row) {
    db.prepare('INSERT INTO leases (scope, holder, epoch, expires_at, data_on) VALUES (?, ?, 1, ?, NULL)').run(
      scope,
      holder,
      now + ttlMs,
    );
    return [200, { epoch: 1, ttlMs, dataOn: null }];
  }
  if (row.holder === holder && row.expires_at > now) {
    db.prepare('UPDATE leases SET expires_at = ? WHERE scope = ?').run(now + ttlMs, scope);
    return [200, { epoch: row.epoch, ttlMs, dataOn: row.data_on }];
  }
  if (leasesOn && row.expires_at > now) {
    return [409, { holder: row.holder, epoch: row.epoch, retryAfterMs: row.expires_at - now }];
  }
  const epoch = row.epoch + 1;
  db.prepare('UPDATE leases SET holder = ?, epoch = ?, expires_at = ? WHERE scope = ?').run(holder, epoch, now + ttlMs, scope);
  return [200, { epoch, ttlMs, dataOn: row.data_on }];
});

const renew = db.transaction((scope: string, holder: string, epoch: number): Reply => {
  const row = read.get(scope);
  if (!row || row.holder !== holder || row.epoch !== epoch) {
    return [409, row ? { holder: row.holder, epoch: row.epoch, retryAfterMs: Math.max(0, row.expires_at - Date.now()) } : {}];
  }
  db.prepare('UPDATE leases SET expires_at = ? WHERE scope = ?').run(Date.now() + ttlMs, scope);
  return [200, { epoch, ttlMs }];
});

const settle = db.transaction((scope: string, holder: string, epoch: number, node: string): Reply => {
  const row = read.get(scope);
  if (!row || row.holder !== holder || row.epoch !== epoch) return [409, {}];
  db.prepare('UPDATE leases SET data_on = ? WHERE scope = ?').run(node, scope);
  return [200, {}];
});

const release = db.transaction((scope: string, holder: string, epoch: number): Reply => {
  const row = read.get(scope);
  if (!row || row.holder !== holder || row.epoch !== epoch) return [409, {}];
  db.prepare('UPDATE leases SET expires_at = 0 WHERE scope = ?').run(scope);
  return [200, {}];
});

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, [status, payload]: Reply): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', 'http://cp');
      if (req.method === 'GET' && url.pathname.startsWith('/lease/')) {
        const row = read.get(decodeURIComponent(url.pathname.slice('/lease/'.length)));
        return send(res, row ? [200, { ...row, now: Date.now() }] : [404, {}]);
      }
      if (req.method !== 'POST') return send(res, [405, {}]);
      const b = await body(req);
      const scope = String(b.scope);
      const holder = String(b.holder);
      const epoch = Number(b.epoch);
      switch (url.pathname) {
        case '/lease/acquire':
          return send(res, acquire(scope, holder));
        case '/lease/renew':
          return send(res, renew(scope, holder, epoch));
        case '/lease/settle':
          return send(res, settle(scope, holder, epoch, String(b.node)));
        case '/lease/release':
          return send(res, release(scope, holder, epoch));
        default:
          return send(res, [404, {}]);
      }
    } catch (e) {
      send(res, [500, { error: String(e) }]);
    }
  })();
});

server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  const bound = typeof addr === 'object' && addr ? addr.port : port;
  process.send?.({ ready: 'control-plane', port: bound });
});
exitWithParent(() => db.close());
