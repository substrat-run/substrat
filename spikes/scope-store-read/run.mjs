/**
 * A store call from inside a scope (#3370, #2258), on local workerd through miniflare.
 * Checks first (a failed one exits non-zero), then the measurements, printed as tables.
 * Re-run from this directory after `pnpm install --ignore-workspace`.
 *
 *   node run.mjs            checks + measurements
 *   node run.mjs --checks   checks only
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Miniflare } from 'miniflare';

const root = dirname(fileURLToPath(import.meta.url));
const src = (file) => join(root, 'src', file);
const COMPAT = '2026-06-01';

const mf = new Miniflare({
  workers: [
    {
      name: 'router',
      modules: true,
      scriptPath: src('router.mjs'),
      compatibilityDate: COMPAT,
      serviceBindings: { VERTICAL: 'vertical' },
      durableObjects: { STORE: { className: 'StoreObject', scriptName: 'store', useSQLite: true } },
    },
    {
      name: 'egress',
      modules: true,
      scriptPath: src('egress.mjs'),
      compatibilityDate: COMPAT,
      serviceBindings: { STORE_CALLS: { name: 'router', entrypoint: 'StoreCalls' } },
      bindings: {
        OUTBOUND_POLICY: { tenant: 'tenant-a', vertical: 'todo', scope: 'scope-1', stores: ['GRAPH'] },
      },
    },
    {
      name: 'vertical',
      modules: true,
      scriptPath: src('vertical.mjs'),
      compatibilityDate: COMPAT,
      // Every global fetch of the vertical goes to the egress worker, as a dispatch
      // namespace's outbound worker does for a user worker.
      outboundService: 'egress',
      durableObjects: {
        SCOPE: { className: 'ScopeDO', useSQLite: true },
        STORE: { className: 'StoreObject', scriptName: 'store', useSQLite: true },
      },
    },
    {
      name: 'store',
      modules: true,
      scriptPath: src('store.mjs'),
      compatibilityDate: COMPAT,
      durableObjects: { STORE: { className: 'StoreObject', useSQLite: true } },
    },
  ],
});

const router = await mf.getWorker('router');

async function call(params) {
  const url = new URL('http://router/run');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const started = performance.now();
  const response = await router.fetch(url);
  const body = await response.json();
  return { ms: performance.now() - started, status: response.status, body };
}

const passed = [];
function check(condition, message, detail) {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    if (detail !== undefined) console.error(`      ${JSON.stringify(detail)}`);
    process.exitCode = 1;
    return false;
  }
  passed.push(message);
  console.log(`PASS  ${message}`);
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let tagCounter = 0;
const tag = (prefix) => `${prefix}-${++tagCounter}`;

// ── Checks ─────────────────────────────────────────────────────────────────────────────

console.log('\n## Checks\n');

for (const mode of ['inside-door', 'inside-raw', 'inside-fetch', 'host', 'host-door']) {
  const r = await call({ mode, scope: 'scope-1', bytes: 1024, tag: tag(mode) });
  check(r.body.ok && r.body.result.bytes === 1024, `${mode}: a 1 KiB read answers`, r.body);
}

{
  const r = await call({ mode: 'inside-door', scope: 'scope-1', binding: 'OTHER', bytes: 1, tag: tag('undeclared') });
  check(!r.body.ok && /not a store this version declares/.test(r.body.error), 'the door refuses a binding the version does not declare', r.body);
}

{
  const t = tag('rollback');
  const r = await call({ mode: 'inside-door', scope: 'scope-1', bytes: 16, failAfter: 1, tag: t });
  const rows = await call({ mode: 'rows', scope: 'scope-1', tag: t });
  check(!r.body.ok && rows.body.result.length === 0, 'an operation that throws after its read rolls back its writes', { r: r.body, rows: rows.body });
}

{
  // The egress policy here is fixed to scope-1, as a dispatch for scope-1 would set it.
  const r = await call({ mode: 'host', scope: 'scope-2', bytes: 1, tag: tag('egress-scope') });
  check(!r.body.ok && /only its own scope/.test(r.body.error), "egress's StoreCalls refuses a scope other than the dispatch's", r.body);
}

{
  await call({ mode: 'stash-door', scope: 'scope-3' });
  const later = await call({ mode: 'use-stashed', scope: 'scope-3' });
  // Recorded as observed on local workerd. The Workers for Platforms documentation says a
  // stub passed through dynamic dispatch props is valid only during its request; miniflare
  // has no dispatch namespace, so that rule is not what runs here (FINDINGS.md).
  check(
    later.body.ok && later.body.result.outcome === 'answered',
    'locally, a ctx.exports door kept past its request still answers in a later request',
    later.body,
  );
  await call({ mode: 'stash-door', scope: 'scope-3' });
  await call({ mode: 'arm-alarm', scope: 'scope-3' });
  let alarm = null;
  for (let i = 0; i < 100 && !alarm; i += 1) {
    await sleep(20);
    alarm = (await call({ mode: 'alarm-result', scope: 'scope-3' })).body.result;
  }
  check(alarm?.outcome === 'answered', 'locally, a ctx.exports door kept past its request still answers in an alarm', alarm);
}

// The gate probe: the production transaction WITHOUT the queue, and the same await with no
// transaction. Does anything but the queue hold a second call out while the first awaits
// the store? `/gate` (src/router.mjs) holds the first call's read in the store, sends the
// second call, gives it a second to finish, then releases the read. `failAfter` makes the
// first call throw after its read, so a write the second call made inside the first one's
// transaction would roll back with it. The assertions are ordering and rows; the in-object
// times are printed only.
async function gateProbe(txn) {
  const scope = `scope-gate-${txn}`;
  await call({ mode: 'local', scope, tag: 'warm' });
  const url = new URL('http://router/gate');
  const params = { scope, tag: tag(`gate-txn${txn}`), bytes: 1, failAfter: 1, txn, grantMs: 1000 };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const g = await (await router.fetch(url)).json();
  return {
    finishedWhileHeld: g.finishedWhileHeld,
    ranAfterRelease: g.ranAt - g.releasedAt,
    rows: g.rows,
  };
}
const gateTxn = await gateProbe(1);
const gateBare = await gateProbe(0);
console.log(`      in a transaction:    ${JSON.stringify(gateTxn)}`);
console.log(`      with no transaction: ${JSON.stringify(gateBare)}`);
check(
  gateTxn.finishedWhileHeld === false && gateTxn.rows?.join() === 'interloper',
  'inside storage.transaction, with no queue, a second call cannot finish while the first awaits the store (its write lands after the rollback)',
  gateTxn,
);
check(
  gateBare.finishedWhileHeld === true && gateBare.rows?.join() === 'hold-before,interloper,hold-after',
  'with no transaction, the input gate lets a second call run and finish while the first awaits the store',
  gateBare,
);

console.log(`\n${passed.length} checks passed${process.exitCode ? ', some FAILED' : ''}`);

if (process.argv.includes('--checks')) {
  await mf.dispose();
  process.exit(process.exitCode ?? 0);
}

// ── Measurements ───────────────────────────────────────────────────────────────────────

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const f = (n) => n.toFixed(1);

async function bench(params) {
  const url = new URL('http://router/bench');
  for (const [key, value] of Object.entries({ scope: 'scope-1', tag: 'bench', ...params })) url.searchParams.set(key, String(value));
  const response = await router.fetch(url);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

const MODES = ['local', 'inside-raw', 'inside-door', 'inside-fetch', 'host-door', 'host'];
console.log('\n## One call at a time (ms, timed in the router, warm)\n');
console.log('| mode | 1 KiB p50 | 1 KiB p95 | 64 KiB p50 | 64 KiB p95 | 1 MiB p50 | 1 MiB p95 |');
console.log('|---|---|---|---|---|---|---|');
for (const mode of MODES) {
  const cells = [];
  for (const [bytes, n] of [
    [1024, 200],
    [65536, 200],
    [1048576, 50],
  ]) {
    await bench({ kind: 'seq', mode, bytes, n: 10 });
    const { times } = await bench({ kind: 'seq', mode, bytes, n });
    cells.push(f(pct(times, 50)), f(pct(times, 95)));
  }
  console.log(`| ${mode} | ${cells.join(' | ')} |`);
}

const scenarios = [
  { name: '20 reads, store answers in 10 ms', reads: 20, locals: 20, bytes: 1024, delayMs: 10 },
  { name: '20 reads, store answers in 50 ms', reads: 20, locals: 20, bytes: 1024, delayMs: 50 },
  { name: '50 reads, store answers in 10 ms', reads: 50, locals: 20, bytes: 1024, delayMs: 10 },
  { name: '10 reads of 1 MiB, store answers at once', reads: 10, locals: 20, bytes: 1048576, delayMs: 0 },
  { name: '10 reads of 4 MiB, store answers at once', reads: 10, locals: 20, bytes: 4194304, delayMs: 0 },
];

console.log('\n## Reads and 20 local operations at once on one scope (ms, timed in the router)\n');
console.log('| scenario | mode | local op p50 | local op max | all reads done |');
console.log('|---|---|---|---|---|');
for (const scenario of scenarios) {
  for (const mode of ['inside-raw', 'inside-door', 'host-door', 'host']) {
    await bench({ kind: 'seq', mode, bytes: 1, n: 5 });
    const { localMs, allReadsMs } = await bench({ kind: 'stall', mode, ...scenario });
    console.log(`| ${scenario.name} | ${mode} | ${f(pct(localMs, 50))} | ${f(Math.max(...localMs))} | ${f(allReadsMs)} |`);
  }
}

await mf.dispose();
