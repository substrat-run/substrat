// The probe sequence on local workerd, through Miniflare. No account, no network beyond the
// network probes' own control call. What this cannot show (a dispatch namespace, production
// isolate placement, cold start on the edge, billing) is the runbook's to measure.
//
//   pnpm install --ignore-workspace && node build-graph.mjs && node run-local.mjs [--graph]
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { runProbes } from './probes.mjs';

const graph = process.argv.includes('--graph');
const only = process.argv.find((arg) => arg.startsWith('--drivers='));
const drivers = only ? only.slice('--drivers='.length).split(',') : ['js', 'py'];
const src = (path) => new URL(`./src/${path}`, import.meta.url);
const token = 'local-spike-token';

const mf = new Miniflare({
  modules: [
    { type: 'ESModule', path: src('supervisor.mjs').pathname, contents: readFileSync(src('supervisor.mjs'), 'utf8') },
    { type: 'Text', path: src('drivers/probe-driver.js').pathname, contents: readFileSync(src('drivers/probe-driver.js'), 'utf8') },
    { type: 'Text', path: src('drivers/probe_driver.py').pathname, contents: readFileSync(src('drivers/probe_driver.py'), 'utf8') },
    { type: 'Data', path: src('graph-release.bin').pathname, contents: readFileSync(src('graph-release.bin')) },
  ],
  modulesRoot: src('').pathname,
  compatibilityDate: '2026-03-01',
  bindings: { SPIKE_TOKEN: token },
  durableObjects: { SUPERVISOR: { className: 'Supervisor', useSQLite: true } },
  workerLoaders: { LOADER: {} },
});

try {
  const worker = await mf.getWorker();
  const request = async (path, params, body) => {
    const url = `https://spike${path}?${new URLSearchParams(params)}`;
    const res = await worker.fetch(url, { method: path === '/info' ? 'GET' : 'POST', headers: { 'x-spike-token': token }, body, signal: AbortSignal.timeout(120_000) });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: res.status, text };
    }
  };
  const result = await runProbes(request, { graph, drivers });
  console.log('\n---- result (local workerd) ----');
  console.log(JSON.stringify({ where: 'local', ...result }, null, 2));
  process.exitCode = result.failed ? 1 : 0;
} catch (err) {
  console.error(`FAIL  the run stopped: ${err?.stack ?? err}`);
  process.exitCode = 1;
} finally {
  await mf.dispose();
}
