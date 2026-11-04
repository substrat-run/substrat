// The JavaScript probe driver. Loaded by the supervisor through the Worker Loader, never imported by
// the script itself, and run as a facet of the supervisor's object. Each operation reports one fact
// the spike asks about. The mark is isolate-wide on purpose: it shows which isolate answered.
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import VERSION from './version.js';

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function attempt(run) {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export class ProbeDriver extends DurableObject {
  async fetch(request) {
    // Set on the isolate's first call (random values are refused at global scope), kept after.
    globalThis.__spikeMark ??= crypto.randomUUID();
    const op = new URL(request.url).pathname.slice(1);
    const sql = this.ctx.storage.sql;
    switch (op) {
      case 'mark':
        return json({ mark: globalThis.__spikeMark, version: VERSION });
      case 'network':
        return json({
          fetch: await attempt(async () => (await fetch('https://example.com/')).status),
          connect: await attempt(async () => {
            const socket = connect('example.com:80');
            await socket.opened;
            await socket.close();
            return 'opened';
          }),
        });
      case 'env':
        return json({ env: Object.keys(this.env ?? {}), exports: this.ctx.exports ? Object.keys(this.ctx.exports) : null, ctx: Object.keys(this.ctx) });
      case 'write':
        sql.exec('CREATE TABLE IF NOT EXISTS facet_rows (n INTEGER)');
        sql.exec('INSERT INTO facet_rows (n) VALUES (1)');
        return json({ rows: sql.exec('SELECT count(*) AS c FROM facet_rows').one().c });
      case 'read': {
        const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' ORDER BY name").toArray().map((r) => r.name);
        const rows = tables.includes('facet_rows') ? sql.exec('SELECT count(*) AS c FROM facet_rows').one().c : 0;
        return json({ tables, rows, version: VERSION });
      }
      default:
        return json({ error: `unknown operation ${op}` });
    }
  }
}
