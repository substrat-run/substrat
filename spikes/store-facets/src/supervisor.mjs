// The spike's supervisor: the shape D-70 proposes for a store script, cut down to what the spike
// measures. It is the only code this script executes. Driver code travels inert (Text and Data
// modules), and the supervisor loads it through the Worker Loader into an isolate keyed by an id it
// chooses, then runs the driver's class as a facet of its own object. No envelope here: the store
// entry's checks are not what the spike is about.
//
// GET  /info                                       whether the loader binding is present
// POST /call?object=&driver=js|py|graph&op=&version=&net=closed|open&share=0|1
//      runs `op` on the driver facet of `object` and reports how long the call took
// POST /restart?object=                           aborts the object's driver facet (storage kept)
// POST /supervisor-tables?object=                 the tables in the supervisor's own storage
import { DurableObject } from 'cloudflare:workers';
import JS_DRIVER from './drivers/probe-driver.js';
import PY_DRIVER from './drivers/probe_driver.py';
import GRAPH_PACK from './graph-release.bin';

const COMPATIBILITY_DATE = '2026-03-01';
const PYTHON_FLAGS = ['python_workers'];

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** The graph release, packed by build-graph.mjs: a 4-byte little-endian index length, the index, the bytes. */
function unpackGraph() {
  const bytes = new Uint8Array(GRAPH_PACK);
  if (bytes.byteLength < 4) return undefined;
  const indexLength = new DataView(GRAPH_PACK).getUint32(0, true);
  const index = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + indexLength)));
  if (!index.files?.length) return undefined;
  const body = 4 + indexLength;
  const modules = {};
  for (const { name, offset, length } of index.files) {
    const file = bytes.slice(body + offset, body + offset + length);
    modules[name] = name.endsWith('.py') && !name.startsWith('python_modules/') ? { py: new TextDecoder().decode(file) } : { data: file.buffer };
  }
  return { modules, entry: index.entry, className: index.className, files: index.files.length, bytes: bytes.byteLength - body };
}

const HEAP_PROBE = `
from workers import DurableObject, Response
import json


class HeapProbe(DurableObject):
    async def fetch(self, request):
        try:
            import pyodide_js
            heap = pyodide_js._module.HEAP8.length
        except Exception as err:
            heap = str(err)
        return Response(json.dumps({"heap": heap}), headers={"content-type": "application/json"})
`;

/** The code the loader gets for one driver kind and version, with the network closed or not. */
function workerCode(driver, version, net) {
  const base = { compatibilityDate: COMPATIBILITY_DATE, env: {}, ...(net === 'open' ? {} : { globalOutbound: null }) };
  if (driver === 'js') {
    return { className: 'ProbeDriver', code: { ...base, mainModule: 'probe-driver.js', modules: { 'probe-driver.js': JS_DRIVER, 'version.js': `export default ${JSON.stringify(version)};` } } };
  }
  if (driver === 'py') {
    return {
      className: 'ProbeDriver',
      heapClass: 'HeapProbe',
      code: { ...base, compatibilityFlags: PYTHON_FLAGS, mainModule: 'probe_driver.py', modules: { 'probe_driver.py': { py: PY_DRIVER }, 'version.py': { py: `VERSION = ${JSON.stringify(version)}\n` } } },
    };
  }
  const graph = unpackGraph();
  if (!graph) throw new Error('no graph release packed: run build-graph.mjs before deploying');
  const [module, cls] = [graph.entry, graph.className];
  const main = `from ${module} import ${cls}\n${HEAP_PROBE}`;
  return {
    className: cls,
    heapClass: 'HeapProbe',
    code: { ...base, compatibilityFlags: PYTHON_FLAGS, mainModule: 'substrat_spike_main.py', modules: { ...graph.modules, 'substrat_spike_main.py': { py: main } } },
  };
}

export class Supervisor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS supervisor_only (k TEXT PRIMARY KEY, v TEXT)');
    ctx.storage.sql.exec("INSERT OR REPLACE INTO supervisor_only (k, v) VALUES ('row', 'the supervisor''s')");
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = (name, fallback) => url.searchParams.get(name) ?? fallback;
    if (url.pathname === '/restart') {
      this.ctx.facets.abort('driver', new Error('restarted by the spike'));
      return json({ aborted: true });
    }
    if (url.pathname === '/supervisor-tables') {
      return json({ tables: this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' ORDER BY name").toArray().map((r) => r.name) });
    }
    const [driver, op, version, net] = [q('driver', 'js'), q('op', 'mark'), q('version', 'v1'), q('net', 'closed')];
    // The loader id: per object (D-70's target), or shared by every object (the control).
    const id = [driver, version, net, q('share', '0') === '1' ? 'shared' : q('object', '')].join(':');
    const { className, heapClass, code } = workerCode(driver, version, net);
    const worker = this.env.LOADER.get(id, () => code);
    const facet = this.ctx.facets.get('driver', () => ({ class: worker.getDurableObjectClass(className) }));
    const started = performance.now();
    const answer = await facet.fetch(`https://facet/${op}`, { method: 'POST', body: await request.text() });
    const ms = Math.round(performance.now() - started);
    const text = await answer.text();
    let heap;
    if (heapClass && q('heap', '0') === '1') {
      heap = await (await this.ctx.facets.get('heap', () => ({ class: worker.getDurableObjectClass(heapClass) })).fetch('https://facet/heap')).json();
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return json({ id, ms, status: answer.status, answer: parsed, heap });
  }
}

export default {
  async fetch(request, env) {
    if (!env.SPIKE_TOKEN || request.headers.get('x-spike-token') !== env.SPIKE_TOKEN) return json({ error: 'token' }, 401);
    const url = new URL(request.url);
    if (url.pathname === '/info') {
      const graph = unpackGraph();
      return json({ loader: typeof env.LOADER?.get === 'function', graph: graph ? { files: graph.files, bytes: graph.bytes, entry: graph.entry, className: graph.className } : null });
    }
    const object = url.searchParams.get('object');
    if (!object) return json({ error: 'object' }, 400);
    try {
      return await env.SUPERVISOR.get(env.SUPERVISOR.idFromName(object)).fetch(request);
    } catch (err) {
      return json({ error: String(err?.message ?? err) }, 500);
    }
  },
};
