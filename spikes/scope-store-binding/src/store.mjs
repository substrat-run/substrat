import { verify } from './mac.mjs';

/**
 * A trivial scope store: one counter in the object's own SQLite.
 * The envelope is the one #2207 proposes — `{ operation, input }` in,
 * `{ result }` or `{ error: { code, status, body } }` out — so the RFC can
 * cite a shape that has actually run, not only been described.
 *
 * Nothing here is Ontomate. The class keeps no module-level state: every
 * fact lives in this object's SQLite, which is what "tolerates eviction" requires.
 */
export class CounterStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS counter (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         n INTEGER NOT NULL
       )`,
    );
    this.sql.exec(`INSERT OR IGNORE INTO counter (id, n) VALUES (1, 0)`);
  }

  async fetch(request) {
    if (this.env.REQUIRE_SIGNATURE === '1') {
      const name = request.headers.get('x-store-name') ?? '';
      const ok = await verify(this.env.SIGNING_KEY, name, request.headers.get('x-store-signature') ?? '');
      if (!ok) {
        return json(
          { error: { code: 'forbidden', status: 403, body: { reason: 'signature' } } },
          403,
        );
      }
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: { code: 'validation_failed', status: 400, body: { reason: 'json' } } }, 400);
    }

    try {
      const result = this.perform(payload?.operation, payload?.input ?? {});
      return json({ result }, 200);
    } catch (err) {
      const status = err.status ?? 500;
      return json(
        { error: { code: err.code ?? 'internal', status, body: { message: String(err.message ?? err) } } },
        status,
      );
    }
  }

  perform(operation, input) {
    if (operation === 'increment') {
      const by = input.by ?? 1;
      if (!Number.isInteger(by)) fail(400, 'validation_failed', 'by must be an integer');
      this.sql.exec(`UPDATE counter SET n = n + ? WHERE id = 1`, by);
      return { count: this.count() };
    }
    if (operation === 'read') return { count: this.count() };
    if (operation === 'substrat.size') return { bytes: this.sql.databaseSize };
    if (operation === 'substrat.wipe') {
      this.sql.exec(`DELETE FROM counter`);
      this.sql.exec(`INSERT INTO counter (id, n) VALUES (1, 0)`);
      return { wiped: true };
    }
    if (operation === 'substrat.export') {
      return { tables: [{ name: 'counter', rows: [{ id: 1, n: this.count() }] }] };
    }
    if (operation === 'substrat.import') {
      const n = input.tables?.[0]?.rows?.[0]?.n;
      if (!Number.isInteger(n)) fail(400, 'validation_failed', 'import row');
      this.sql.exec(`UPDATE counter SET n = ? WHERE id = 1`, n);
      return { imported: true };
    }
    fail(404, 'not_found', `unknown operation: ${operation}`);
  }

  count() {
    return this.sql.exec(`SELECT n FROM counter WHERE id = 1`).one().n;
  }
}

export default {
  fetch() {
    return json({ error: { code: 'not_found', status: 404, body: { reason: 'store worker has no public fetch' } } }, 404);
  },
};

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
