// Today's shape: the scope's Durable Object class is part of the uploaded script, so the vertical's
// code runs in the script's own isolate with whatever network the script has. On Workers for
// Platforms an outbound worker does not see a request made from here (D-46, and Cloudflare's
// "Requests that Outbound Workers do not intercept"). Locally, Miniflare's `outboundService` is
// workerd's `globalOutbound`, which DOES cover a Durable Object: the `plain-outbound` worker in
// run-local.mjs shows that difference, so nobody reads a local pass as a production one.
//
// POST /exits?object=&label=&host=&http=&tcp=   probes every way out from inside the object
// POST /ping?object=                           one round trip, for timing
// POST /alarm-set, /alarm-read                 the control for the facet's alarm
// POST /worker-exits?label=&host=&http=&tcp=   the same probes from worker context, not the DO
import { DurableObject } from 'cloudflare:workers';
import { probeExits } from './exits.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

export class PlainScope extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/ping') return new Response('pong');
    if (url.pathname === '/alarm-set') {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS alarms (at TEXT)');
      await this.ctx.storage.setAlarm(Date.now() + 50);
      return json({ set: true });
    }
    if (url.pathname === '/alarm-read') {
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS alarms (at TEXT)');
      return json({ fired: this.ctx.storage.sql.exec('SELECT count(*) AS c FROM alarms').one().c });
    }
    const q = url.searchParams;
    const sink = { host: q.get('host'), httpPort: Number(q.get('http')), tcpPort: Number(q.get('tcp')) };
    return json(await probeExits({ sink, label: q.get('label'), env: this.env, ctx: this.ctx }));
  }

  async alarm() {
    this.ctx.storage.sql.exec('INSERT INTO alarms (at) VALUES (?)', new Date().toISOString());
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/worker-exits') {
      // The same probes from the worker's own context, where a namespace outbound worker DOES apply.
      const q = url.searchParams;
      const sink = { host: q.get('host'), httpPort: Number(q.get('http')), tcpPort: Number(q.get('tcp')) };
      return json(await probeExits({ sink, label: q.get('label'), env, ctx }));
    }
    const object = new URL(request.url).searchParams.get('object') ?? 'one';
    return env.SCOPE.get(env.SCOPE.idFromName(object)).fetch(request);
  },
};
