/**
 * Stands in for the scope's record (`engine-assistant`): an append-only event log, and a
 * single-writer lease with a heartbeat. One object per thread here; in the platform it is
 * the scope's database. Nothing in it knows about a model or about a client.
 *
 * The lease is what makes two places able to run a turn safely: the holder is fenced at
 * every append, so a run that was believed dead and is not (a zombie) cannot write.
 */
import { DurableObject } from 'cloudflare:workers';

export class Record extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)`);
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS run (k INTEGER PRIMARY KEY CHECK (k = 1), run_id TEXT, beat INTEGER NOT NULL, calls INTEGER NOT NULL DEFAULT 0)`,
    );
    this.sql.exec(`INSERT OR IGNORE INTO run (k, run_id, beat) VALUES (1, NULL, 0)`);
  }

  /** Take the lease if it is free or its holder has not beaten for `staleMs`. */
  lease(runId, now, staleMs) {
    const row = this.sql.exec(`SELECT run_id, beat FROM run WHERE k = 1`).one();
    const held = row.run_id !== null && now - row.beat < staleMs;
    if (held && row.run_id !== runId) return { ok: false, holder: row.run_id };
    const tookOver = row.run_id !== null && row.run_id !== runId;
    this.sql.exec(`UPDATE run SET run_id = ?, beat = ? WHERE k = 1`, runId, now);
    return { ok: true, tookOver };
  }

  release(runId) {
    this.sql.exec(`UPDATE run SET run_id = NULL WHERE k = 1 AND run_id = ?`, runId);
  }

  /** Append events; fenced by the lease. Returns the events with their ids. */
  append(runId, now, events) {
    const row = this.sql.exec(`SELECT run_id FROM run WHERE k = 1`).one();
    if (runId !== null && row.run_id !== runId) return { ok: false, fenced: true };
    const out = [];
    for (const e of events) {
      const body = JSON.stringify(e);
      const id = this.sql.exec(`INSERT INTO events (body) VALUES (?) RETURNING id`, body).one().id;
      out.push({ ...e, id });
    }
    this.sql.exec(`UPDATE run SET calls = calls + 1${runId !== null ? ', beat = ' + Number(now) : ''} WHERE k = 1`);
    return { ok: true, events: out };
  }

  read(after, limit = 10000) {
    return this.sql
      .exec(`SELECT id, body FROM events WHERE id > ? ORDER BY id LIMIT ?`, after, limit)
      .toArray()
      .map((r) => ({ ...JSON.parse(r.body), id: r.id }));
  }

  state() {
    const run = this.sql.exec(`SELECT run_id, beat, calls FROM run WHERE k = 1`).one();
    const agg = this.sql.exec(`SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(body)), 0) AS bytes, COALESCE(MAX(id), 0) AS last FROM events`).one();
    return { runId: run.run_id, beat: run.beat, calls: run.calls, rows: agg.rows, bytes: agg.bytes, lastId: agg.last };
  }
}
