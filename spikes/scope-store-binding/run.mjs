/**
 * Runs the cross-script scope-store evidence against local workerd (miniflare).
 * Exits non-zero on the first failed assertion. Re-run from this directory
 * after `pnpm install --ignore-workspace`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { sign } from './src/mac.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const storePath = join(root, 'src', 'store.mjs');
const callerPath = join(root, 'src', 'caller.mjs');
const KEY = 'spike-signing-key';

const passed = [];

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    console.error(`      passed so far: ${passed.join(', ') || '(none)'}`);
    process.exit(1);
  }
  passed.push(message);
  console.log(`PASS  ${message}`);
}

function storeWorker(name, bindings) {
  return {
    name,
    modules: true,
    scriptPath: storePath,
    compatibilityDate: '2026-06-01',
    durableObjects: {
      STORE: { className: 'CounterStore', useSQLite: true },
    },
    bindings,
  };
}

function callerWorker(name, scriptName, bindings) {
  return {
    name,
    modules: true,
    scriptPath: callerPath,
    compatibilityDate: '2026-06-01',
    durableObjects: {
      STORE: { className: 'CounterStore', scriptName, useSQLite: true },
    },
    bindings,
  };
}

function start(persist) {
  return new Miniflare({
    durableObjectsPersist: persist,
    workers: [
      storeWorker('shared-store', { REQUIRE_SIGNATURE: '0' }),
      storeWorker('signed-store', { REQUIRE_SIGNATURE: '1', SIGNING_KEY: KEY }),
      storeWorker('store-a', { REQUIRE_SIGNATURE: '0' }),
      storeWorker('store-b', { REQUIRE_SIGNATURE: '0' }),
      callerWorker('leaky', 'shared-store', { REFUSE_RESERVED: '1' }),
      callerWorker('vertical-b-shared', 'shared-store', { REFUSE_RESERVED: '1' }),
      callerWorker('platform', 'signed-store', { SIGNING_KEY: KEY }),
      callerWorker('leaky-signed', 'signed-store', { REFUSE_RESERVED: '1' }),
      callerWorker('vertical-a', 'store-a', { REFUSE_RESERVED: '1' }),
      callerWorker('vertical-b', 'store-b', { REFUSE_RESERVED: '1' }),
    ],
  });
}

async function call(mf, workerName, params) {
  const url = new URL('http://spike/call');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const worker = await mf.getWorker(workerName);
  const response = await worker.fetch(url);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

const scopeA = 'tenant-1/vertical-a/scope-1/GRAPH';
const scopeB = 'tenant-1/vertical-a/scope-2/GRAPH';
const otherVertical = 'tenant-1/vertical-b/scope-1/GRAPH';

const persist = mkdtempSync(join(tmpdir(), 'scope-store-binding-'));
const mf = start(persist);

const first = await call(mf, 'vertical-a', { name: scopeA, op: 'increment' });
assert(first.status === 200 && first.body.result?.count === 1, 'cross-script binding reaches the object and increments');

const again = await call(mf, 'vertical-a', { name: scopeA, op: 'read' });
assert(again.body.result?.count === 1, 'a second call reads the same object');

const otherScope = await call(mf, 'vertical-a', { name: scopeB, op: 'read' });
assert(otherScope.body.result?.count === 0, 'two scopes do not share an object');

const unknown = await call(mf, 'vertical-a', { name: scopeA, op: 'nope' });
assert(
  unknown.status === 404 && unknown.body.error?.code === 'not_found' && unknown.body.result === undefined,
  'an unknown operation is an error envelope, not a result',
);

const reserved = await call(mf, 'vertical-a', { name: scopeA, op: 'substrat.size' });
assert(
  reserved.status === 403 && reserved.body.error?.body?.reason === 'reserved',
  'a vertical stub refuses a reserved operation before the store sees it',
);

const untouched = await call(mf, 'vertical-a', { name: scopeA, op: 'read' });
assert(untouched.body.result?.count === 1, 'the refused reserved call did not change the object');

const crossed = await call(mf, 'leaky', { name: otherVertical, op: 'increment' });
assert(crossed.body.result?.count === 1, 'on a shared script, a caller can address another vertical by name');
const victim = await call(mf, 'vertical-b-shared', { name: otherVertical, op: 'read' });
assert(
  victim.body.result?.count === 1,
  'that write landed in the other vertical’s object — the shared script does not isolate',
);

const ownScript = await call(mf, 'vertical-a', { name: otherVertical, op: 'increment' });
assert(ownScript.body.result?.count === 1, 'per-vertical script: vertical-a can still use that name on its own script');
const isolated = await call(mf, 'vertical-b', { name: otherVertical, op: 'read' });
assert(
  isolated.body.result?.count === 0,
  'per-vertical script: the same name on vertical-b’s script is a different object',
);

const unsigned = await call(mf, 'leaky-signed', { name: scopeA, op: 'increment' });
assert(
  unsigned.status === 403 && unsigned.body.error?.body?.reason === 'signature',
  'a binding without the signing key is refused',
);
const macForA = await sign(KEY, scopeA);
const replayed = await call(mf, 'leaky-signed', { name: scopeB, op: 'increment', sig: macForA });
assert(
  replayed.status === 403 && replayed.body.error?.body?.reason === 'signature',
  'a signature over a different name is refused',
);
const signed = await call(mf, 'platform', { name: scopeA, op: 'increment' });
assert(signed.status === 200 && signed.body.result?.count === 1, 'the platform caller, which holds the key, is admitted');

const size = await call(mf, 'platform', { name: scopeA, op: 'substrat.size' });
assert(
  typeof size.body.result?.bytes === 'number' && size.body.result.bytes > 0,
  'substrat.size reports the object’s SQLite size',
);

const exported = await call(mf, 'platform', { name: scopeA, op: 'substrat.export' });
assert(exported.body.result?.tables?.[0]?.rows?.[0]?.n === 1, 'substrat.export returns the counter row');

const wiped = await call(mf, 'platform', { name: scopeA, op: 'substrat.wipe' });
assert(wiped.body.result?.wiped === true, 'substrat.wipe is answered');
const afterWipe = await call(mf, 'platform', { name: scopeA, op: 'read' });
assert(afterWipe.body.result?.count === 0, 'substrat.wipe cleared the counter');

await mf.dispose();

const revived = start(persist);
const afterRestart = await call(revived, 'vertical-a', { name: otherVertical, op: 'read' });
assert(
  afterRestart.body.result?.count === 1,
  'a written object reopened from its SQLite after the worker restarted',
);
const wipedKept = await call(revived, 'platform', { name: scopeA, op: 'read' });
assert(wipedKept.body.result?.count === 0, 'substrat.wipe reached storage: the counter is still 0 after restart');
await revived.dispose();

// The caller only forwards `by`. Import is exercised directly on the namespace,
// which is the platform path, so the envelope's import half is still shown.
const direct = start(mkdtempSync(join(tmpdir(), 'scope-store-binding-import-')));
const ns = await direct.getDurableObjectNamespace('STORE', 'store-a');
const id = ns.idFromName('tenant-1/vertical-a/scope-9/GRAPH');
const stub = ns.get(id);
const importedResponse = await stub.fetch('https://store/', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ operation: 'substrat.import', input: { tables: [{ name: 'counter', rows: [{ id: 1, n: 7 }] }] } }),
});
const importedBody = await importedResponse.json();
assert(importedResponse.status === 200 && importedBody.result?.imported === true, 'substrat.import accepts a dump');
const readBack = await stub.fetch('https://store/', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ operation: 'read', input: {} }),
});
const readBody = await readBack.json();
assert(readBody.result?.count === 7, 'substrat.import replaced the counter');
await direct.dispose();

console.log(`\n${passed.length} assertions passed`);
console.log(`persistence dir (discarded): ${persist}`);
