// The scope's code as the supervisor loads it: a Text module, never imported by the script, run as
// a facet of the supervisor's object. It stands in for the kernel's scope class plus the vertical's
// modules, and does what the real class needs of its runtime (adapter-cloudflare/src/scope-do.ts):
// synchronous SQL in a transaction, an alarm, hibernatable WebSockets for live reads, a write to the
// scope-work dataset, and an RPC to the control plane, all through what it was handed.
//
// POST /exits?label=&host=&http=&tcp=   every way out, from inside the facet
// POST /sql                             synchronous SQL inside transactionSync
// POST /alarm-set  /  POST /alarm-read  an alarm set by the facet, and whether it fired
// POST /alarm-fired                     the supervisor forwarding an alarm it holds for the facet
// GET  /ws (Upgrade)                    a hibernatable WebSocket accepted by the facet
// POST /cp                              an RPC through the CONTROL_PLANE stub it was handed
// POST /work                            a write through the SCOPE_WORK stub it was handed
// POST /other?object=                   a Durable Object call through a namespace it was handed
// POST /ping                            one round trip, for timing
import { DurableObject } from 'cloudflare:workers';
import { probeExits } from './exits.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export class Scope extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    const sql = this.ctx.storage.sql;
    switch (url.pathname) {
      case '/ping':
        return new Response('pong');
      case '/exits': {
        const sink = { host: q.get('host'), httpPort: Number(q.get('http')), tcpPort: Number(q.get('tcp')) };
        return json(await probeExits({ sink, label: q.get('label'), env: this.env, ctx: this.ctx }));
      }
      case '/sql': {
        const n = this.ctx.storage.transactionSync(() => {
          sql.exec('CREATE TABLE IF NOT EXISTS rows (n INTEGER)');
          sql.exec('INSERT INTO rows (n) VALUES (1)');
          return sql.exec('SELECT count(*) AS c FROM rows').one().c;
        });
        return json({ rows: n });
      }
      case '/alarm-set':
        sql.exec('CREATE TABLE IF NOT EXISTS alarms (at TEXT)');
        await this.ctx.storage.setAlarm(Date.now() + 50);
        return json({ set: await this.ctx.storage.getAlarm() });
      case '/alarm-fired':
        sql.exec('CREATE TABLE IF NOT EXISTS alarms (at TEXT)');
        await this.alarm();
        return json({ recorded: true });
      case '/alarm-read':
        sql.exec('CREATE TABLE IF NOT EXISTS alarms (at TEXT)');
        return json({ fired: sql.exec('SELECT count(*) AS c FROM alarms').one().c });
      case '/ws': {
        if (request.headers.get('upgrade') !== 'websocket') return json({ error: 'not an upgrade' }, 426);
        const [client, server] = Object.values(new WebSocketPair());
        this.ctx.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }
      case '/cp':
        return json({ answer: await this.env.CONTROL_PLANE.whoami() });
      case '/work':
        return json({ answer: await this.env.SCOPE_WORK.write({ blobs: ['op'], doubles: [1] }) });
      case '/other': {
        const ns = this.env.OTHER;
        const res = await ns.get(ns.idFromName(q.get('object') ?? 'other')).fetch('https://other/ping', { method: 'POST' });
        return json({ status: res.status, body: await res.text() });
      }
      default:
        return json({ error: `unknown ${url.pathname}` }, 404);
    }
  }

  /** The fix for a loader env shared by every scope of a version: the supervisor hands this call's
   *  capabilities as arguments, so they are per call and per scope, never cached with the code. */
  async whoamiWith(caps) {
    return caps.CONTROL_PLANE.whoami();
  }

  async alarm() {
    this.ctx.storage.sql.exec('INSERT INTO alarms (at) VALUES (?)', new Date().toISOString());
  }

  webSocketMessage(ws, message) {
    ws.send(`echo:${message}`);
  }
}
