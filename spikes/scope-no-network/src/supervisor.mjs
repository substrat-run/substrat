// The supervisor: what the platform would upload as the scope's Durable Object class instead of
// the class the vertical's bundle defines. It is platform code, and the only code the script's own
// Durable Object executes. The scope's code travels inert (Text modules) and is loaded through the
// Worker Loader, then run as a facet of this object — D-70's shape, applied to the scope instead of
// a store driver.
//
// The `net` parameter picks the facet's `globalOutbound`:
//   closed  null: fetch() and connect() throw
//   policy  this script's Egress entrypoint, with the declared hosts as props (D-46, from inside a DO)
//   open    inherited: the control, the network the supervisor itself has
//
// The facet's env holds only what the supervisor passes: a CONTROL_PLANE and a SCOPE_WORK stub (loopback
// entrypoints of this script, narrowed by props) and, to answer "can a namespace be handed over", the
// OTHER Durable Object namespace when `other=1`.
//
// POST /<facet path>?object=&net=closed|policy|open[&other=1][&pad=1][&version=]   forwards to the facet
// POST /env-check                                                     which binding kinds a facet's env takes
// POST /supervised-alarm-set?object=&net=                             an alarm the supervisor holds for the facet
// POST /whoami-env, /whoami-arg?object=                               a per-scope stub through the env, or per call
// POST /bench?n=                                                      the facet hop, timed inside the runtime
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import SCOPE from './scope.js';
import EXITS from './exits.js';
import PAD from './pad.js';

const COMPATIBILITY_DATE = '2026-07-01';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** D-46's enforcement, reached from inside a Durable Object: the facet's every fetch() lands here. */
export class Egress extends WorkerEntrypoint {
  async fetch(request) {
    const host = new URL(request.url).hostname;
    if (!this.ctx.props.hosts.includes(host)) {
      return new Response(`egress refused: ${host} is not in ${this.ctx.props.slug}'s declared outbound hosts`, { status: 403 });
    }
    return fetch(request);
  }
}

/** A narrow stand-in for the control-plane RPC the scope makes; props say who is asking. */
export class ControlPlane extends WorkerEntrypoint {
  async whoami() {
    return { tenant: this.ctx.props.tenant, scope: this.ctx.props.scope };
  }
}

/** The scope-work dataset, as a stub: the facet never holds the dataset binding itself. */
export class ScopeWork extends WorkerEntrypoint {
  async write(point) {
    if (!this.env.SCOPE_WORK) throw new Error('SCOPE_WORK is not bound: nothing was written');
    this.env.SCOPE_WORK.writeDataPoint({ ...point, indexes: [this.ctx.props.scope] });
    return { written: true, scope: this.ctx.props.scope };
  }
}

/** A second Durable Object class, to answer whether a namespace can be put in a facet's env. */
export class Other extends DurableObject {
  async fetch() {
    return new Response('other pong');
  }
}

export class Supervisor extends DurableObject {
  scopeName() {
    return this.ctx.id.name ?? this.ctx.id.toString();
  }

  facet(net, { other = false, pad = false, version = 'v1' } = {}) {
    const scope = this.scopeName();
    const env = {
      CONTROL_PLANE: this.ctx.exports.ControlPlane({ props: { tenant: 'tenant-a', scope } }),
      SCOPE_WORK: this.ctx.exports.ScopeWork({ props: { scope } }),
      ...(other ? { OTHER: this.env.OTHER } : {}),
    };
    const globalOutbound =
      net === 'open' ? undefined : net === 'policy' ? this.ctx.exports.Egress({ props: { slug: 'acme', hosts: [this.env.DECLARED_HOST ?? '127.0.0.1'] } }) : null;
    const modules = { 'scope.js': SCOPE, 'exits.js': EXITS };
    if (pad) {
      modules['pad.js'] = PAD;
      modules['main.js'] = "import './pad.js';\nexport * from './scope.js';\n";
    }
    const code = {
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ['nodejs_compat'],
      mainModule: pad ? 'main.js' : 'scope.js',
      modules,
      env,
      ...(globalOutbound === undefined ? {} : { globalOutbound }),
    };
    // One loader id per (code version, network mode): the scope's code is the vertical's, the same for
    // every scope of that version, so the id need not be per object the way D-70's driver id is.
    // `version` stands in for the code version: a new one is a new id, so a truly cold load.
    const id = `scope:${version}:${net}:${other ? 'other' : '-'}:${pad ? 'pad' : '-'}`;
    const worker = this.env.LOADER.get(id, () => code);
    return this.ctx.facets.get(`scope:${id}`, () => ({ class: worker.getDurableObjectClass('Scope') }));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    if (url.pathname === '/env-check') return json(await this.envCheck());
    if (url.pathname === '/whoami-env') {
      const facet = this.facet(q.get('net') ?? 'closed');
      return json({ object: this.scopeName(), viaEnv: (await (await facet.fetch('https://facet/cp', { method: 'POST' })).json()).answer });
    }
    if (url.pathname === '/whoami-arg') {
      const facet = this.facet(q.get('net') ?? 'closed');
      const caps = { CONTROL_PLANE: this.ctx.exports.ControlPlane({ props: { tenant: 'tenant-a', scope: this.scopeName() } }) };
      return json({ object: this.scopeName(), viaArgument: await facet.whoamiWith(caps) });
    }
    if (url.pathname === '/bench') {
      // The hop the facet adds, timed inside the runtime: supervisor -> facet, against supervisor -> a
      // sibling Durable Object (the hop a worker -> scope call is today). performance.now() advances on I/O.
      const n = Number(q.get('n') ?? 200);
      const facet = this.facet('closed');
      const other = this.env.OTHER.get(this.env.OTHER.idFromName('bench'));
      const time = async (stub) => {
        await (await stub.fetch('https://x/ping', { method: 'POST' })).text();
        const t = performance.now();
        for (let i = 0; i < n; i += 1) await (await stub.fetch('https://x/ping', { method: 'POST' })).text();
        return (performance.now() - t) / n;
      };
      return json({ n, facetMs: await time(facet), siblingDoMs: await time(other) });
    }
    if (url.pathname === '/supervised-alarm-set') {
      // The workaround if a facet cannot hold an alarm: the supervisor holds it and forwards.
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS facet_alarm (net TEXT)');
      this.ctx.storage.sql.exec('DELETE FROM facet_alarm');
      this.ctx.storage.sql.exec('INSERT INTO facet_alarm (net) VALUES (?)', q.get('net') ?? 'closed');
      await this.ctx.storage.setAlarm(Date.now() + 50);
      return json({ set: true });
    }
    const facet = this.facet(q.get('net') ?? 'closed', { other: q.get('other') === '1', pad: q.get('pad') === '1', version: q.get('version') ?? 'v1' });
    return facet.fetch(request);
  }

  async alarm() {
    const row = this.ctx.storage.sql.exec('SELECT net FROM facet_alarm').toArray()[0];
    if (row) await this.facet(row.net).fetch('https://facet/alarm-fired', { method: 'POST' });
  }

  /** Which binding kinds a loaded worker's env accepts, one kind per load. */
  async envCheck() {
    const kinds = {
      'service stub (ctx.exports)': () => this.ctx.exports.ControlPlane({ props: { tenant: 't', scope: 's' } }),
      'durable object namespace': () => this.env.OTHER,
      'analytics engine dataset': () => this.env.SCOPE_WORK,
      'worker loader': () => this.env.LOADER,
      'plain value': () => 'a string',
    };
    const out = {};
    for (const [kind, value] of Object.entries(kinds)) {
      try {
        const worker = this.env.LOADER.load({
          compatibilityDate: COMPATIBILITY_DATE,
          mainModule: 'probe.js',
          modules: {
            'probe.js': 'export default { fetch(req, env) { const v = env.X; return new Response(JSON.stringify({ type: typeof v, keys: v && typeof v === "object" ? Object.keys(Object.getPrototypeOf(v) ?? {}).concat(Object.keys(v)).slice(0, 8) : null })); } };',
          },
          env: { X: value() },
          globalOutbound: null,
        });
        out[kind] = { accepted: true, seen: await (await worker.getEntrypoint().fetch('https://probe/')).json() };
      } catch (err) {
        out[kind] = { accepted: false, error: String(err?.message ?? err).slice(0, 200) };
      }
    }
    return out;
  }
}

export default {
  async fetch(request, env) {
    const object = new URL(request.url).searchParams.get('object') ?? 'one';
    return env.SUPERVISOR.get(env.SUPERVISOR.idFromName(object)).fetch(request);
  },
};
