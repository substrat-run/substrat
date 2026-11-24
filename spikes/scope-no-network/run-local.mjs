// The spike on local workerd, through Miniflare. No account and no internet: "the network" is a sink
// on 127.0.0.1 (HTTP, WebSocket and raw TCP) that records every hit by its label, so a result is
// judged by what ARRIVED, not by whether the call threw.
//
//   pnpm install --ignore-workspace && node run-local.mjs
//
// Four scripts, one runtime:
//   plain           today's shape: the scope class is in the uploaded script
//   plain-outbound  the same, with a refusing globalOutbound (what Miniflare's outboundService sets)
//   locked          the same, behind a preamble that removes fetch and WebSocket first
//   supervisor      the scope's code loaded inert, run as a facet, globalOutbound chosen per call
//
// What a local run cannot show (a dispatch namespace, the outbound worker's real reach, cold start on
// the edge, the bill) is RUNBOOK.md's.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { Miniflare } from 'miniflare';

const src = (path) => new URL(`./src/${path}`, import.meta.url);
const read = (path) => readFileSync(src(path), 'utf8');
const esm = (path, contents = read(path)) => ({ type: 'ESModule', path: src(path).pathname, contents });
const text = (path, contents = read(path)) => ({ type: 'Text', path: src(path).pathname, contents });
const COMPAT = { compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'] };

// ---- the sink ---------------------------------------------------------------------------------
const hits = [];
const http = createServer((req, res) => {
  hits.push({ via: 'http', what: req.url });
  res.end('sink');
});
http.on('upgrade', (req, socket) => {
  hits.push({ via: 'upgrade', what: req.url });
  const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.on('error', () => {});
  setTimeout(() => socket.destroy(), 200);
});
const tcp = createTcpServer((socket) => {
  // TCP delivers chunks, not records: buffer per socket and record each complete newline-ended label,
  // plus whatever is left when the socket ends.
  let buffered = '';
  const record = (line) => line.trim() && hits.push({ via: 'tcp', what: line.trim() });
  socket.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop();
    lines.forEach(record);
  });
  socket.on('end', () => record(buffered));
  socket.on('error', () => {});
});
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
const sink = { host: '127.0.0.1', http: http.address().port, tcp: tcp.address().port };
const arrived = (label) => [...new Set(hits.filter((h) => h.what.includes(`${label}/`)).map((h) => h.what.split(`${label}/`)[1].split(/[/?\s]/)[0]))].sort();

// ---- the runtime ------------------------------------------------------------------------------
const PAD_BYTES = 2 * 1024 * 1024;
const pad = `export default ${JSON.stringify('x'.repeat(PAD_BYTES))};\n`;
const plainModules = [esm('plain.mjs'), esm('exits.js')];
const mf = new Miniflare({
  workers: [
    { name: 'plain', ...COMPAT, modules: plainModules, modulesRoot: src('').pathname, durableObjects: { SCOPE: { className: 'PlainScope', useSQLite: true } } },
    {
      name: 'plain-outbound',
      ...COMPAT,
      modules: plainModules,
      modulesRoot: src('').pathname,
      durableObjects: { SCOPE: { className: 'PlainScope', useSQLite: true } },
      outboundService: () => new Response('refused by the local globalOutbound', { status: 403 }),
    },
    {
      name: 'locked',
      ...COMPAT,
      modules: [esm('locked.mjs'), esm('lockdown.mjs'), ...plainModules],
      modulesRoot: src('').pathname,
      durableObjects: { SCOPE: { className: 'PlainScope', useSQLite: true } },
    },
    {
      name: 'supervisor',
      ...COMPAT,
      modules: [esm('supervisor.mjs'), text('scope.js'), text('exits.js'), text('pad.js', pad)],
      modulesRoot: src('').pathname,
      durableObjects: { SUPERVISOR: { className: 'Supervisor', useSQLite: true }, OTHER: { className: 'Other', useSQLite: true } },
      workerLoaders: { LOADER: {} },
      analyticsEngineDatasets: { SCOPE_WORK: { dataset: 'scope_work' } },
    },
  ],
});

let failed = 0;
const findings = {};
const check = (claim, ok, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${claim}${detail === undefined ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};

try {
  const workers = Object.fromEntries(await Promise.all(['plain', 'plain-outbound', 'locked', 'supervisor'].map(async (n) => [n, await mf.getWorker(n)])));
  const call = async (worker, path, params = {}, init = {}) => {
    const res = await workers[worker].fetch(`https://spike${path}?${new URLSearchParams(params)}`, { method: 'POST', ...init, signal: AbortSignal.timeout(60_000) });
    const body = await res.text();
    try {
      return JSON.parse(body);
    } catch {
      return { status: res.status, body };
    }
  };
  const exits = async (worker, label, extra = {}, host = sink.host) => {
    const answer = await call(worker, '/exits', { object: label, label, host, http: sink.http, tcp: sink.tcp, ...extra });
    await new Promise((r) => setTimeout(r, 300)); // let the TCP sink read what was written
    findings[label] = { answer, arrived: arrived(label) };
    return findings[label];
  };
  const NETWORK_EXITS = ['fetch', 'fetch-prototype', 'fetch-upgrade', 'websocket', 'connect', 'node-net', 'node-http', 'import-url'];

  // 1. Today's shape: the control. Proves the sink is reachable at all.
  const plain = await exits('plain', 'plain');
  check('plain DO: fetch() reaches the network (control)', plain.arrived.includes('fetch'), plain.arrived);
  check('plain DO: connect() reaches the network (control)', plain.arrived.includes('connect'), plain.arrived);

  // 2. Local globalOutbound covers a DO. Production's outbound worker does not (Cloudflare's docs); this is the trap.
  const outbound = await exits('plain-outbound', 'plain-outbound');
  check('plain DO behind a local globalOutbound: fetch() is answered by it, not the network', outbound.answer.fetch?.value === 403 && !outbound.arrived.includes('fetch'), outbound.answer.fetch);

  // 3. The preamble.
  const locked = await exits('locked', 'locked');
  check('preamble: the global fetch() is refused', locked.answer.fetch?.ok === false && !locked.arrived.includes('fetch'), locked.answer.fetch);
  const lockedOut = locked.arrived;
  check('preamble: yet code still reaches the network another way', lockedOut.length > 0, lockedOut);

  // 4. The loaded facet, network closed.
  const closed = await exits('supervisor', 'closed', { net: 'closed' });
  check('facet, globalOutbound null: nothing arrives, by any exit', closed.arrived.length === 0, closed.arrived);
  for (const name of NETWORK_EXITS) check(`facet, globalOutbound null: ${name} refused`, closed.answer[name]?.ok === false || (name === 'fetch-upgrade' && /no socket/.test(closed.answer[name]?.value)), closed.answer[name]);
  check('facet: env holds only what the supervisor passed', JSON.stringify(closed.answer.envKeys) === JSON.stringify(['CONTROL_PLANE', 'SCOPE_WORK']), closed.answer.envKeys);
  check('facet: the ambient cloudflare:workers env is the same handed env', JSON.stringify(closed.answer['ambient-env']?.value) === JSON.stringify(['CONTROL_PLANE', 'SCOPE_WORK']), closed.answer['ambient-env']);

  // 5. The loaded facet, network open (control: the facet inherits the supervisor's network).
  const open = await exits('supervisor', 'open', { net: 'open' });
  check('facet, globalOutbound inherited: fetch() reaches the network (control)', open.arrived.includes('fetch'), open.arrived);

  // 6. The loaded facet behind a policy entrypoint: D-46 from inside a Durable Object.
  const allowed = await exits('supervisor', 'policy-declared', { net: 'policy' });
  check('facet, policy egress: a declared host passes', allowed.arrived.includes('fetch') && allowed.answer.fetch?.value === 200, { fetch: allowed.answer.fetch, arrived: allowed.arrived });
  const refused = await exits('supervisor', 'policy-undeclared', { net: 'policy' }, 'localhost');
  check('facet, policy egress: an undeclared host is refused by the platform entrypoint', refused.answer.fetch?.value === 403 && !refused.arrived.includes('fetch'), refused.answer.fetch);
  check('facet, policy egress: connect() never bypasses the policy', !allowed.arrived.includes('connect') && !refused.arrived.includes('connect'), { declared: allowed.answer.connect, undeclared: refused.answer.connect });

  // 7. What the scope class needs from its runtime, inside the facet.
  const sql = await call('supervisor', '/sql', { object: 'needs', net: 'closed' });
  check('facet: synchronous SQL in transactionSync', sql.rows >= 1, sql);
  const sqlAgain = await call('supervisor', '/sql', { object: 'needs', net: 'closed' });
  check('facet: its storage persists across calls', sqlAgain.rows === sql.rows + 1, sqlAgain);
  const pollFired = async (worker, object, extra = {}) => {
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const { fired } = await call(worker, '/alarm-read', { object, ...extra });
      if (fired) return fired;
    }
    return 0;
  };
  await call('plain', '/alarm-set', { object: 'alarm-control' });
  const plainFired = await pollFired('plain', 'alarm-control');
  check('plain SQLite DO: an alarm fires (control)', plainFired >= 1, { fired: plainFired });
  const facetAlarm = await call('supervisor', '/alarm-set', { object: 'needs', net: 'closed' }).catch((err) => ({ refused: String(err?.message ?? err) }));
  findings.facetAlarm = facetAlarm;
  console.log(`INFO  facet sets its own alarm: ${JSON.stringify(facetAlarm)}`);
  await call('supervisor', '/supervised-alarm-set', { object: 'needs-alarm', net: 'closed' });
  const supervisedFired = await pollFired('supervisor', 'needs-alarm', { net: 'closed' });
  check('facet: an alarm the supervisor holds reaches the facet', supervisedFired >= 1, { fired: supervisedFired });
  const wsRes = await workers.supervisor.fetch(`https://spike/ws?${new URLSearchParams({ object: 'needs', net: 'closed' })}`, { headers: { upgrade: 'websocket' } });
  let echo;
  if (wsRes.webSocket) {
    wsRes.webSocket.accept();
    echo = await new Promise((resolve) => {
      wsRes.webSocket.addEventListener('message', (e) => resolve(e.data));
      wsRes.webSocket.send('hello');
      setTimeout(() => resolve('no answer'), 3000);
    });
    wsRes.webSocket.close();
  }
  check('facet: a hibernatable WebSocket it accepts answers', echo === 'echo:hello', { status: wsRes.status, echo });
  const cp = await call('supervisor', '/cp', { object: 'needs', net: 'closed' });
  check('facet: the CONTROL_PLANE stub answers, narrowed by props', cp.answer?.tenant === 'tenant-a', cp);
  const work = await call('supervisor', '/work', { object: 'needs', net: 'closed' });
  check('facet: the SCOPE_WORK stub writes for it', work.answer?.written === true, work);

  // 7b. The loader caches a worker by id WITH its env. One id per code version means one env for every
  //     scope of that version: a per-scope stub put in the env answers for whichever scope loaded first.
  const envA = await call('supervisor', '/whoami-env', { object: 'scope-a' });
  const envB = await call('supervisor', '/whoami-env', { object: 'scope-b' });
  findings.envShared = { envA, envB };
  console.log(`INFO  per-scope stub in a shared loader env: scope-a sees ${envA.viaEnv?.scope}, scope-b sees ${envB.viaEnv?.scope}`);
  const sharedScope = envA.viaEnv?.scope;
  check(
    'a per-scope stub in the loader env is NOT per scope (the env is cached with the code)',
    typeof sharedScope === 'string' && sharedScope !== '' && envB.viaEnv?.scope === sharedScope && sharedScope !== 'scope-b',
    { envA, envB },
  );
  const argA = await call('supervisor', '/whoami-arg', { object: 'scope-a' });
  const argB = await call('supervisor', '/whoami-arg', { object: 'scope-b' });
  check('a per-scope stub handed as a call argument is per scope', argA.viaArgument?.scope === 'scope-a' && argB.viaArgument?.scope === 'scope-b', { argA, argB });

  // 8. Which binding kinds a loaded worker's env accepts.
  findings.envCheck = await call('supervisor', '/env-check', { object: 'env' });
  for (const [kind, r] of Object.entries(findings.envCheck)) console.log(`INFO  env takes ${kind}: ${r.accepted ? `yes (${JSON.stringify(r.seen)})` : `no (${r.error})`}`);
  if (findings.envCheck['durable object namespace']?.accepted) {
    const other = await call('supervisor', '/other', { object: 'needs-other', net: 'closed', other: '1' });
    findings.other = other;
    console.log(`INFO  facet calls a Durable Object through a handed namespace: ${JSON.stringify(other)}`);
  }

  // 9. Cost, indicative only: the hop the facet adds, timed inside the runtime, and the cold load of a
  //    2 MB scope bundle, timed from outside.
  findings.bench = await call('supervisor', '/bench', { object: 'bench', n: 500 });
  console.log(`INFO  per call, inside the runtime: supervisor -> facet ${findings.bench.facetMs.toFixed(3)} ms, supervisor -> sibling DO ${findings.bench.siblingDoMs.toFixed(3)} ms (n=${findings.bench.n})`);
  const once = async (params) => {
    const t = performance.now();
    await (await workers.supervisor.fetch(`https://spike/ping?${new URLSearchParams(params)}`, { method: 'POST' })).text();
    return performance.now() - t;
  };
  const coldPad = await once({ object: 'timing-pad', net: 'closed', pad: '1', version: 'cold-a' });
  const coldPadFreshId = await once({ object: 'timing-pad-fresh', net: 'closed', pad: '1', version: 'cold-b' });
  const warm = [];
  for (let i = 0; i < 50; i += 1) warm.push(await once({ object: 'timing-pad', net: 'closed', pad: '1', version: 'cold-a' }));
  const secondObject = await once({ object: 'timing-pad-2', net: 'closed', pad: '1', version: 'cold-a' });
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  findings.timing = { coldPadMs: coldPad, coldPadFreshIdMs: coldPadFreshId, warmPadMs: median(warm), freshObjectSameIdMs: secondObject, padBytes: PAD_BYTES };
  console.log(`INFO  2 MB scope bundle, from outside: cold (new loader id) ${coldPad.toFixed(1)} and ${coldPadFreshId.toFixed(1)} ms, warm ${median(warm).toFixed(2)} ms, a fresh object on an already loaded id ${secondObject.toFixed(1)} ms`);

  console.log('\n---- findings (local workerd) ----');
  console.log(JSON.stringify(findings, null, 2));
} catch (err) {
  failed += 1;
  console.error(`FAIL  the run stopped: ${err?.stack ?? err}`);
} finally {
  await mf.dispose();
  http.close();
  tcp.close();
}
console.log(`\n${failed ? `${failed} FAILED` : 'all checks passed'}`);
process.exitCode = failed ? 1 : 0;
