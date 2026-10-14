/**
 * L4 and L5 against the Python store entry (#2290). Signs with the shared vector's
 * key and talks to `uv run pywrangler dev`.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { issueScopeStoreEnvelope } from '../contracts/dist/scope-store-envelope.js';

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(readFileSync(join(here, '../contracts/test/vectors/scope-store-envelope.json'), 'utf8'));
const port = 8794;
const scope = randomUUID();
const name = `tenant/vertical/${scope}/GRAPH`;
const other = `tenant/vertical/${randomUUID()}/GRAPH`;

function assert(condition, message, extra) {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    if (extra !== undefined) console.error(extra);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.log(`PASS  ${message}`);
}

const child = spawn('uv', ['run', 'pywrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1'], {
  cwd: here,
  stdio: ['ignore', 'inherit', 'inherit'],
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ready() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`pywrangler exited ${child.exitCode} before it was ready`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(90_000) });
      await response.text();
      if (response.status < 500) return;
    } catch (err) {
      if (String(err).includes('pywrangler exited')) throw err;
      await sleep(300);
    }
  }
  throw new Error('pywrangler did not answer within 180s');
}

async function call(objectName, operation, options = {}) {
  const body = JSON.stringify({ operation, input: { by: 1 }, objectName });
  const issued = await issueScopeStoreEnvelope({
    privateKey: vector.privateKeyPkcs8,
    aud: options.aud ?? 'caller',
    name: objectName,
    op: operation,
    body,
    ...(options.iat !== undefined ? { iat: options.iat } : {}),
  });
  const headers = {
    'content-type': 'application/json',
    'x-substrat-store-envelope': issued.header,
    'x-substrat-store-signature': options.signature ?? issued.signature,
  };
  const url = new URL(`http://127.0.0.1:${port}/invoke`);
  if (options.address) url.searchParams.set('object', options.address);
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  return { status: response.status, text };
}

try {
  await ready();
  const first = await call(name, 'increment');
  assert(first.status === 200 && JSON.parse(first.text).result === 1, 'a valid envelope reaches the counter', first.text);

  const forged = await call(name, 'increment', { signature: 'a'.repeat(86) });
  assert(forged.status === 401, 'a bad signature is refused', forged.text);

  const stale = await call(name, 'increment', { iat: Math.floor(Date.now() / 1000) - 120 });
  assert(stale.status === 401, 'a stale envelope is refused', stale.text);

  const reserved = await call(name, 'substrat.wipe');
  assert(reserved.status === 401, 'a caller signature does not authorize a reserved operation', reserved.text);

  const vectorCall = await fetch(`http://127.0.0.1:${port}/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-substrat-store-envelope': vector.header,
      'x-substrat-store-signature': vector.signature,
    },
    body: vector.body,
  });
  assert(vectorCall.status === 401, 'the shared vector is a real signature, and its audience does not match the operation', await vectorCall.text());

  const read = await call(name, 'read');
  assert(read.status === 200 && JSON.parse(read.text).result === 1, 'the counter did not move for a refused call', read.text);

  const attacked = await call(other, 'increment', { address: name });
  assert(attacked.status === 401, 'an object that remembers one name refuses a valid envelope for another', attacked.text);

  const after = await call(name, 'read');
  assert(after.status === 200 && JSON.parse(after.text).result === 1, 'the kind was not constructed for the other name', after.text);
  console.log('python store entry passed');
} finally {
  child.kill();
}
