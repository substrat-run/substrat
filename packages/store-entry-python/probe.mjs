/**
 * The Python store entry (#2290), run as uploaded under `pywrangler dev`. Run it with tsx, from
 * the repo root: `pnpm exec tsx packages/store-entry-python/probe.mjs`.
 *
 * The script is what the upload builds (`withPythonStoreEntry`, #2210), not this package's
 * source: the Python entry with its two placeholders replaced by the counter driver, the verifier
 * module beside it, the driver's package, and the upload's bindings and flags. A probe-only main module wraps the default entrypoint so a valid
 * envelope can be delivered to an object of another name; the shipped entry has no such switch.
 *
 * Every call in the corpus below is judged twice: here, by the verifier module the script
 * ships, and by the Python entry. They must answer the same, refusal for refusal. The corpus is
 * signed with the shared vector's key, malformed envelopes included, so each case reaches the
 * check it is about.
 */
import { spawn } from 'node:child_process';
import { randomUUID, webcrypto } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  generateScopeStoreKeyPair,
  issueScopeStoreEnvelope,
  scopeStoreBodyDigest,
  scopeStoreKeyId,
} from '../contracts/dist/scope-store-envelope.js';
import * as entry from '../control-plane-api/src/store-entry.generated.ts';
import { withPythonStoreEntry } from '../control-plane-api/src/store-entry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(readFileSync(join(here, '../contracts/test/vectors/scope-store-envelope.json'), 'utf8'));
const out = join(here, '.uploaded');
const DRIVER_PACKAGE = 'driver_counter';
const DRIVER_CLASS = 'CounterStore';

let failed = 0;
function check(condition, message, extra) {
  if (condition) {
    console.log(`PASS  ${message}`);
    return;
  }
  failed++;
  console.error(`FAIL  ${message}`);
  if (extra !== undefined) console.error(`      ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`);
}

// ---- the script, as the upload builds it ----

check(!/ALLOW_ADDRESS|parse_qs|\?object=/.test(entry.STORE_ENTRY_PYTHON_SOURCE), 'the shipped Python entry has no address override');
const platformPair = await generateScopeStoreKeyPair();
function filesUnder(dir, prefix) {
  const found = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.name === '__pycache__' || name.name.endsWith('.pyc')) continue;
    const rel = `${prefix}/${name.name}`;
    if (name.isDirectory()) found.push(...filesUnder(join(dir, name.name), rel));
    else found.push({ name: rel, content: readFileSync(join(dir, name.name)) });
  }
  return found;
}
const driverModules = [
  ...filesUnder(join(here, 'src', DRIVER_PACKAGE), DRIVER_PACKAGE),
  ...filesUnder(join(here, 'src', 'python_modules'), 'python_modules'),
];
const built = withPythonStoreEntry(
  { entry: `${DRIVER_PACKAGE}/store.py`, modules: driverModules },
  { className: DRIVER_CLASS, script: vector.script, callerPublicKeys: [vector.publicKey], platformPublicKeys: [platformPair.publicKey] },
);
const contentType = Object.fromEntries(built.modules.map((module) => [module.name, module.contentType]));
check(contentType[`${DRIVER_PACKAGE}/store.py`] === 'text/x-python', 'the driver module uploads as Python');
check(contentType['python_modules/vendor_probe/__init__.py'] === 'application/octet-stream', 'a vendored .py uploads as a Data module');
check(contentType['python_modules/vendor_probe/payload.txt'] === 'application/octet-stream', 'a vendored data file uploads as a Data module');
check(
  !built.modules.some((module) => /(^|\/)(workers|js|pyodide)(\/|\.py$)/.test(module.name) || module.name.includes('_workers_sdk')),
  'the uploaded script does not ship the workers runtime SDK',
);
rmSync(out, { recursive: true, force: true });
for (const module of built.modules) {
  // python_modules lives at the worker root, where the runtime vendors it. The entry and the
  // driver stay under src/, which is where the upload's main module is.
  const root = module.name.startsWith('python_modules/') ? out : join(out, 'src');
  const dest = join(root, module.name);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, module.content);
}
// The probe's own main. `?object=` sends the call, unverified, straight to that object, past
// the default entrypoint, so the object's own checks are what answer it. `?unconfigured=1`
// runs the entry's check with an env that has no key lists, as an upload that bound none.
writeFileSync(
  join(out, 'src', 'probe_entry.py'),
  `from urllib.parse import parse_qs, urlparse

from js import Object
from workers import Response

import ${entry.STORE_ENTRY_PYTHON_MODULE.replace(/\.py$/, '')} as store_entry
from ${entry.STORE_ENTRY_PYTHON_MODULE.replace(/\.py$/, '')} import ${entry.STORE_OBJECT_CLASS}


class _Unconfigured:
    def __init__(self, env):
        self._env = Object.fromEntries([e for e in Object.entries(env._env) if not str(e[0]).endswith("_KEYS")])


class Default(store_entry.Default):
    async def fetch(self, request):
        query = parse_qs(urlparse(request.url).query)
        if query.get("unconfigured"):
            refused = await store_entry._verified(request, await request.text(), _Unconfigured(self.env))
            return refused if isinstance(refused, Response) else Response("admitted", status=200)
        asked = query.get("object")
        if not asked:
            return await super().fetch(request)
        namespace = getattr(self.env, "${entry.STORE_OBJECT_BINDING}")
        stub = namespace.get(namespace.idFromName(asked[0]))
        return await stub.fetch(request.url, method="POST", headers=request.js_object.headers, body=await request.text())
`,
);

// The upload's plain-text bindings become the dev server's vars; the driver gets one of its own.
const vars = {
  ...Object.fromEntries(built.bindings.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text])),
  DRIVER_SETTING: 'the driver may read this',
};
const namespace = built.bindings.find((b) => b.type === 'durable_object_namespace');
writeFileSync(
  join(out, 'wrangler.jsonc'),
  JSON.stringify(
    {
      name: 'substrat-store-entry-python-probe',
      main: 'src/probe_entry.py',
      compatibility_date: built.compatibilityDate,
      compatibility_flags: built.compatibilityFlags,
      rules: [{ type: 'ESModule', globs: [`**/${entry.STORE_VERIFIER_MODULE}`] }],
      durable_objects: { bindings: [{ name: namespace.name, class_name: namespace.class_name }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: [entry.STORE_OBJECT_CLASS] }],
      vars,
    },
    null,
    2,
  ),
);
copyFileSync(join(here, 'pyproject.toml'), join(out, 'pyproject.toml'));
copyFileSync(join(here, 'uv.lock'), join(out, 'uv.lock'));
copyFileSync(join(here, '.python-version'), join(out, '.python-version'));

// The verifier the script ships, loaded here, is the oracle for every call.
const { storeCallVerdict } = await import(pathToFileURL(join(out, 'src', entry.STORE_VERIFIER_MODULE)).href);

// ---- the dev server ----

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
// The dev install recreates this directory. Remove the copy written above so the wait below
// observes that install, not the files that are about to be replaced.
rmSync(join(out, 'python_modules'), { recursive: true, force: true });
const child = spawn('uv', ['run', '--frozen', 'pywrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], {
  cwd: out,
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: true,
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// pywrangler replaces python_modules with the runtime SDK it installs for dev. The upload does
// not: withPythonStoreEntry already named the vendored files. Put them back once that install
// has written the SDK and before wrangler reads the directory.
const vendorSrc = join(here, 'src', 'python_modules', 'vendor_probe');
const copyVendor = () => {
  const dest = join(out, 'python_modules', 'vendor_probe');
  mkdirSync(dest, { recursive: true });
  for (const file of readdirSync(vendorSrc)) copyFileSync(join(vendorSrc, file), join(dest, file));
};
const vendorInstalled = async () => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    // `.synced` is written when the dev install of the runtime SDK finishes.
    if (existsSync(join(out, 'python_modules', '.synced')) && existsSync(join(out, 'python_modules', 'workers', '__init__.py'))) {
      copyVendor();
      return;
    }
    await sleep(50);
  }
  throw new Error('pywrangler did not install python_modules');
};

async function ready() {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`pywrangler exited ${child.exitCode} before it was ready`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', signal: AbortSignal.timeout(90_000) });
      const text = await response.text();
      // Our own script answers an unsigned call with its own refusal; anything else is not it.
      if (response.status === 401 && text === 'unauthorized: missing') return;
      throw new Error(`port ${port} answered ${response.status} ${text.slice(0, 80)}, not the store entry`);
    } catch (err) {
      if (String(err).includes('not the store entry')) throw err;
      await sleep(500);
    }
  }
  throw new Error('pywrangler did not answer within 240s');
}

// ---- signing ----

const callerKey = await webcrypto.subtle.importKey('pkcs8', base64UrlToBytes(vector.privateKeyPkcs8), { name: 'Ed25519' }, false, ['sign']);
const platformKey = await webcrypto.subtle.importKey('pkcs8', base64UrlToBytes(platformPair.privateKey), { name: 'Ed25519' }, false, ['sign']);
const callerKid = vector.kid;
const platformKid = platformPair.kid;
const strangerKid = await scopeStoreKeyId((await generateScopeStoreKeyPair()).publicKey);
const sign = async (key, bytes) => bytesToBase64Url(new Uint8Array(await webcrypto.subtle.sign('Ed25519', key, bytes)));
const zeroNonce = 'AAAAAAAAAAAAAAAAAAAAAA';

/** A call whose canonical lines are written by hand, signed over exactly those bytes. */
async function raw({ lines, body, key = callerKey, signature }) {
  const bytes = typeof lines === 'string' ? new TextEncoder().encode(lines) : lines;
  return {
    headers: {
      'x-substrat-store-envelope': bytesToBase64Url(bytes),
      'x-substrat-store-signature': signature ?? (await sign(key, bytes)),
    },
    body,
  };
}

const now = () => Math.floor(Date.now() / 1000);
const bodyOf = (objectName, operation) => JSON.stringify({ objectName, operation, input: {} });

/** The nine lines, with one field overridden. */
async function linesFor(name, op, body, patch = {}) {
  const fields = {
    v: '1',
    aud: 'caller',
    kid: callerKid,
    script: vector.script,
    name,
    op,
    digest: await scopeStoreBodyDigest(body),
    iat: String(now()),
    nonce: zeroNonce,
    ...patch,
  };
  return [fields.v, fields.aud, fields.kid, fields.script, fields.name, fields.op, fields.digest, fields.iat, fields.nonce].join('\n');
}

async function signed(name, op, options = {}) {
  const body = options.body ?? bodyOf(name, op);
  const aud = options.aud ?? 'caller';
  const issued = await issueScopeStoreEnvelope({
    privateKey: aud === 'platform' ? platformPair.privateKey : vector.privateKeyPkcs8,
    aud,
    script: vector.script,
    name,
    op,
    body,
  });
  return { headers: { 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature }, body: options.sendBody ?? body };
}

async function send(call, query = '') {
  const response = await fetch(`http://127.0.0.1:${port}/invoke${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...call.headers },
    body: call.body,
  });
  return { status: response.status, text: await response.text() };
}

const result = (answer) => JSON.parse(answer.text).result;

try {
  await vendorInstalled();
  await ready();
  const name = `tenant/vertical/${randomUUID()}/graph`;
  const other = `tenant/vertical/${randomUUID()}/graph`;

  // ---- the differential corpus ----
  const corpus = [
    ['a caller call', await signed(name, 'increment')],
    ['a platform call on a reserved operation', await signed(name, 'substrat.size', { aud: 'platform' })],
    ['the shared vector (signature good, iat stale)', { headers: { 'x-substrat-store-envelope': vector.header, 'x-substrat-store-signature': vector.signature }, body: vector.body }],
    ['the shared vector with another signature', { headers: { 'x-substrat-store-envelope': vector.header, 'x-substrat-store-signature': vector.staleSignature }, body: vector.body }],
    ['a body changed after signing', await signed(name, 'increment', { sendBody: bodyOf(name, 'increment') + ' ' })],
    ['a body naming another object', await signed(name, 'increment', { body: bodyOf(other, 'increment') })],
    ['a body naming another operation', await signed(name, 'increment', { body: bodyOf(name, 'read') })],
    ['a body that is not JSON', await signed(name, 'increment', { body: 'not json' })],
    ['no envelope header', { headers: { 'x-substrat-store-signature': 'a'.repeat(86) }, body: bodyOf(name, 'read') }],
    ['no signature header', { headers: { 'x-substrat-store-envelope': (await signed(name, 'read')).headers['x-substrat-store-envelope'] }, body: bodyOf(name, 'read') }],
    ['a header that is not base64url', { headers: { 'x-substrat-store-envelope': 'not base64url!', 'x-substrat-store-signature': 'a'.repeat(86) }, body: '{}' }],
    ['a header that is not UTF-8', await raw({ lines: new Uint8Array([0xff, 0xfe, 0x0a, 0x31]), body: '{}' })],
    ['a bad signature', await signed(name, 'increment').then((call) => ({ ...call, headers: { ...call.headers, 'x-substrat-store-signature': 'a'.repeat(86) } }))],
  ];
  const b = bodyOf(name, 'read');
  const patched = async (label, patch, key) => corpus.push([label, await raw({ lines: await linesFor(name, 'read', b, patch), body: b, key })]);
  await patched('version 2', { v: '2' });
  await patched('an unknown audience', { aud: 'admin' });
  await patched('a platform envelope on a driver operation', { aud: 'platform', kid: platformKid }, platformKey);
  corpus.push(['a caller envelope on a reserved operation', await raw({ lines: await linesFor(name, 'substrat.wipe', bodyOf(name, 'substrat.wipe')), body: bodyOf(name, 'substrat.wipe') })]);
  await patched('a caller envelope signed with the platform key', {}, platformKey);
  await patched('a kid no key has', { kid: strangerKid });
  await patched('another script', { script: 'substrat-store-graph-other' });
  await patched('a stale iat', { iat: String(now() - 120) });
  await patched('an iat in the future', { iat: String(now() + 120) });
  await patched('an iat with a leading zero', { iat: `0${now()}` });
  await patched('an iat in Arabic-Indic digits', { iat: '١٧٠٠٠٠٠٠٠٠' });
  await patched('a negative iat', { iat: `-${now()}` });
  await patched('an iat of 16 digits', { iat: '1'.repeat(16) });
  await patched('a nonce with its unused bits set', { nonce: 'AAAAAAAAAAAAAAAAAAAAAB' });
  await patched('a nonce of 15 bytes', { nonce: 'AAAAAAAAAAAAAAAAAAAA' });
  await patched('a kid with its unused bits set', { kid: callerKid.slice(0, 10) + 'B' });
  await patched('an uppercase digest', { digest: (await scopeStoreBodyDigest(b)).toUpperCase() });
  corpus.push(['eight lines', await raw({ lines: (await linesFor(name, 'read', b)).split('\n').slice(0, 8).join('\n'), body: b })]);
  corpus.push(['ten lines', await raw({ lines: `${await linesFor(name, 'read', b)}\n`, body: b })]);

  let admitted = 0;
  for (const [label, call] of corpus) {
    const expected = await storeCallVerdict(new Headers(call.headers), call.body, vars);
    const answer = await send(call);
    if (expected.ok) {
      admitted++;
      check(answer.status === 200, `${label}: the Python entry admits it, as the verifier does`, answer);
    } else {
      check(answer.status === expected.status && answer.text === expected.message, `${label}: the Python entry answers ${expected.status} ${expected.message}`, answer);
    }
  }
  check(admitted === 2, 'the oracle admits the two well-formed calls, so the corpus is not refused wholesale', admitted);

  // ---- the object, the body and the driver ----
  const count = result(await send(await signed(name, 'read')));
  const attacked = await send(await signed(other, 'increment'), `?object=${encodeURIComponent(name)}`);
  check(attacked.status === 401 && attacked.text === 'unauthorized: object', 'an object refuses a valid envelope for another name', attacked);
  check(result(await send(await signed(name, 'read'))) === count, 'and its count did not move');

  // The object checks the call itself, whatever reached it: sent past the default entrypoint.
  const direct = `?object=${encodeURIComponent(name)}`;
  const unsigned = await send({ headers: {}, body: bodyOf(name, 'increment') }, direct);
  check(unsigned.status === 401 && unsigned.text === 'unauthorized: missing', 'the object refuses an unsigned call sent straight to it', unsigned);
  const forged = await signed(name, 'increment');
  const forgedAnswer = await send({ ...forged, headers: { ...forged.headers, 'x-substrat-store-signature': 'a'.repeat(86) } }, direct);
  check(forgedAnswer.status === 401 && forgedAnswer.text === 'unauthorized: signature', 'and a forged one', forgedAnswer);
  const staleAnswer = await send(await raw({ lines: await linesFor(name, 'increment', bodyOf(name, 'increment'), { iat: String(now() - 120) }), body: bodyOf(name, 'increment') }), direct);
  check(staleAnswer.status === 401 && staleAnswer.text === 'unauthorized: stale', 'and a stale one', staleAnswer);
  check(result(await send(await signed(name, 'read'))) === count, 'and its count did not move for any of them');
  const admittedDirect = await send(await signed(name, 'read'), direct);
  check(admittedDirect.status === 200, 'while a valid call sent straight to it is admitted', admittedDirect);

  // An upload that bound no keys answers 503, not the caller's 401.
  const unconfigured = await send(await signed(name, 'read'), '?unconfigured=1');
  check(unconfigured.status === 503 && unconfigured.text === 'this store script is not configured', 'an unconfigured store answers 503', unconfigured);
  check(result(await send(await signed(name, 'constructed'))).count === 1, 'the driver is constructed once, however many calls it serves');
  const fresh = `tenant/vertical/${randomUUID()}/graph`;
  const refused = await send(await signed(other, 'increment'), `?object=${encodeURIComponent(fresh)}`);
  check(refused.status === 401, 'a call refused at the object', refused);
  await sleep(1500);
  const constructed = result(await send(await signed(fresh, 'constructed')));
  check(constructed.count === 1 && constructed.lead_ms < 1000, 'did not construct the driver there before it was refused', constructed);

  const exact = JSON.stringify({ objectName: name, operation: 'body', input: { text: 'é   \\u00e9' } });
  check(result(await send(await signed(name, 'body', { body: exact }))) === exact, 'the driver receives the exact body that was verified');

  const env = result(await send(await signed(name, 'env')));
  check(JSON.stringify(env.given) === JSON.stringify(['DRIVER_SETTING']), "the driver's env has none of the entry's bindings", env);
  check(env.importable.length === 0, 'an importable env reads nothing (disallow_importable_env)', env);
  check(env.exports === false, 'the driver has no ctx.exports (disable_ctx_exports)', env);

  const vendored = result(await send(await signed(name, 'vendored')));
  check(vendored.label === 'vendor-probe' && vendored.payload === 'payload-ok', 'the driver imports a vendored module and reads its data file', vendored);

  check(result(await send(await signed(name, 'set-alarm'))) === true, 'the driver sets an alarm');
  let alarms = 0;
  for (let i = 0; i < 40 && alarms === 0; i++) {
    await sleep(250);
    alarms = result(await send(await signed(name, 'alarms')));
  }
  check(alarms === 1, "the object's alarm reaches the driver", alarms);
} catch (err) {
  failed++;
  console.error(`FAIL  ${err?.stack ?? err}`);
} finally {
  // The dev server is a tree (uv, pywrangler, wrangler, workerd): end the whole group.
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
}
if (failed > 0) {
  console.error(`python store entry: ${failed} failed`);
  process.exit(1);
}
console.log('python store entry passed');
