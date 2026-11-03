import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateScopeStoreKeyPair, issueScopeStoreEnvelope } from '@substrat-run/contracts/scope-store-envelope';
import { withPythonStoreEntry } from '@substrat-run/control-plane-api';

/**
 * The fence (D-70) on the Python entry, running: the entry and the counter driver as the upload builds
 * them, on workerd through Miniflare, with real storage. packages/store-entry-python/probe.mjs runs the
 * whole entry under `pywrangler dev` in its own workflow; this needs no pywrangler and no uv, so it
 * sits in the gate and runs on a checkout that cannot start one.
 *
 * Under two SDKs, because they hand the entry different objects. The runtime's own gives a JavaScript
 * `ctx`. `workers-runtime-sdk`, at the version the package's `uv.lock` pins, gives a
 * `DurableObjectContext`, whose `.storage` reaches JavaScript as a proxy destroyed when the call
 * returns, so a fence given it fails every call. The wheel comes from the URL and digest in `uv.lock`,
 * kept under `node_modules/.cache`. A wheel that cannot be fetched fails here, by name: skipping would
 * leave the shape that broke untested.
 *
 * Over the workerd test budget, and on purpose: a Python worker boots in about 3 s, and one restart costs
 * another. The timeout is 3x what a run takes.
 */
const TIMEOUT_MS = 60_000;

const PACKAGE = fileURLToPath(new URL('../../../packages/store-entry-python/', import.meta.url));
const SCRIPT = 'substrat-store-counter-docs';
const CACHE = fileURLToPath(new URL('../node_modules/.cache/store-entry-python/', import.meta.url));

/** The wheel `uv.lock` pins for the SDK: its URL and SHA-256. */
function lockedSdkWheel(): { url: string; sha256: string } {
  const lock = readFileSync(join(PACKAGE, 'uv.lock'), 'utf8');
  const block = lock.slice(lock.indexOf('name = "workers-runtime-sdk"\n'.replace('\n', lock.includes('\r\n') ? '\r\n' : '\n')));
  const wheel = /wheels = \[\s*\{ url = "([^"]+\.whl)", hash = "sha256:([0-9a-f]{64})"/.exec(block);
  if (!wheel) throw new Error('uv.lock names no wheel for workers-runtime-sdk');
  return { url: wheel[1]!, sha256: wheel[2]! };
}

async function fetchedWheel(): Promise<Buffer> {
  const { url, sha256 } = lockedSdkWheel();
  const path = join(CACHE, `${sha256}.whl`);
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  if (existsSync(path)) {
    const held = readFileSync(path);
    if (digest(held) === sha256) return held;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the SDK wheel ${url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== sha256) throw new Error(`the SDK wheel ${url} is not what uv.lock pins`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(path, bytes);
  return bytes;
}

/** The files of a zip, by its central directory: stored or deflated, which is all a wheel uses. */
function unzipped(zip: Buffer): { name: string; content: Buffer }[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files: { name: string; content: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    if (!name.endsWith('/')) files.push({ name, content: method === 0 ? raw : inflateRawSync(raw) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/** The SDK's modules, as `python_modules/` holds them under `pywrangler dev`. */
const sdkModules = (wheel: Buffer) =>
  unzipped(wheel)
    .filter(({ name }) => !name.includes('.dist-info/') && !name.endsWith('.pyi') && !name.endsWith('.pth') && !name.endsWith('py.typed'))
    .map(({ name, content }) => ({ type: 'Data' as const, path: `python_modules/${name}`, contents: content }));

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === '__pycache__') return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

describe.each([
  ['the runtime\'s own SDK', false],
  ['workers-runtime-sdk as uv.lock pins it', true],
] as const)('a fenced object on the Python entry, under %s', (_label, vendored) => {
  let mf: Miniflare;
  let persist: string;
  let caller: Awaited<ReturnType<typeof generateScopeStoreKeyPair>>;
  let platform: Awaited<ReturnType<typeof generateScopeStoreKeyPair>>;
  let start: () => Miniflare;

  beforeAll(async () => {
    caller = await generateScopeStoreKeyPair();
    platform = await generateScopeStoreKeyPair();
    const driverRoot = join(PACKAGE, 'src');
    const built = withPythonStoreEntry(
      {
        entry: 'driver_counter/store.py',
        modules: filesUnder(join(driverRoot, 'driver_counter')).map((path) => ({
          name: relative(driverRoot, path).replaceAll('\\', '/'),
          content: readFileSync(path),
        })),
      },
      { className: 'CounterStore', script: SCRIPT, callerPublicKeys: [caller.publicKey], platformPublicKeys: [platform.publicKey] },
    );
    const modules = built.modules.map((module) => ({
      type: module.contentType === 'text/x-python' ? ('PythonModule' as const) : ('ESModule' as const),
      path: module.name,
      contents: module.content,
    }));
    const sdk = vendored ? sdkModules(await fetchedWheel()) : [];
    const bindings = built.bindings as readonly { type: string; name: string; text?: string; class_name?: string }[];
    persist = mkdtempSync(join(tmpdir(), 'store-fence-python-'));
    start = () => new Miniflare({
      workers: [{
        name: 'store',
        compatibilityDate: built.compatibilityDate,
        compatibilityFlags: built.compatibilityFlags,
        modules: [...modules, ...sdk],
        bindings: Object.fromEntries(bindings.filter((b) => b.type === 'plain_text').map((b) => [b.name, b.text!])),
        durableObjects: Object.fromEntries(
          bindings.filter((b) => b.type === 'durable_object_namespace').map((b) => [b.name, { className: b.class_name!, useSQLite: true }]),
        ),
      }],
      durableObjectsPersist: persist,
    });
    mf = start();
  }, TIMEOUT_MS);

  afterAll(async () => {
    await mf?.dispose();
    // Windows may hold a SQLite file a moment longer. The directory is the system's temp.
    try { rmSync(persist, { recursive: true, force: true }); } catch { /* left to the system */ }
  }, TIMEOUT_MS);

  let serial = 0;
  const newObject = () => `tenant/docs/${vendored ? 'vendored' : 'runtime'}-${Date.now()}-${serial++}/GRAPH`;

  async function signedCall(name: string, operation: string, aud: 'caller' | 'platform' = 'caller') {
    const body = JSON.stringify({ operation, objectName: name });
    const issued = await issueScopeStoreEnvelope({
      privateKey: aud === 'platform' ? platform.privateKey : caller.privateKey, aud, script: SCRIPT, name, op: operation, body,
    });
    return { body, headers: { 'content-type': 'application/json', 'x-substrat-store-envelope': issued.header, 'x-substrat-store-signature': issued.signature } };
  }
  async function deliver(call: Awaited<ReturnType<typeof signedCall>>) {
    const response = await mf.dispatchFetch('http://store/invoke', { method: 'POST', headers: call.headers, body: call.body });
    const text = await response.text();
    return { status: response.status, text };
  }
  const ask = async (name: string, operation: string, aud: 'caller' | 'platform' = 'caller') => deliver(await signedCall(name, operation, aud));
  const result = (answer: { text: string }) => (JSON.parse(answer.text) as { result: unknown }).result;
  const expectFenced = (answer: { status: number; text: string }) => {
    expect(answer.status, answer.text).toBe(410);
    expect((JSON.parse(answer.text) as { error: { code: string } }).error.code).toBe('store_fenced');
  };

  it('a live object writes; a fence wipes it through the driver, and refuses a caller and a stage from then on', { timeout: TIMEOUT_MS }, async () => {
    const name = newObject();
    expect(result(await ask(name, 'increment'))).toBe(1);
    expect(result(await ask(name, 'increment'))).toBe(2);
    const signedBefore = await signedCall(name, 'increment');
    const fenced = await ask(name, 'substrat.fence', 'platform');
    expect(fenced.status, fenced.text).toBe(200);
    expect(result(fenced)).toEqual({});
    expectFenced(await deliver(signedBefore));
    expectFenced(await ask(name, 'increment'));
    expectFenced(await ask(name, 'substrat.stage-page', 'platform'));
    expectFenced(await ask(name, 'substrat.commit-stage', 'platform'));
    // The mark survived the driver's deleteAll(), and the wipe really ran.
    expect(result(await ask(name, 'substrat.size', 'platform'))).toBe(0);
    expect((await ask(name, 'substrat.fence', 'platform')).status).toBe(200);
    expectFenced(await ask(name, 'increment'));
  });

  it('an alarm reaches the driver of a live object, and not of a fenced one', { timeout: TIMEOUT_MS }, async () => {
    const alarms = async (name: string) => (result(await ask(name, 'substrat.erase', 'platform')) as { alarms: number }).alarms;
    const live = newObject();
    await ask(live, 'substrat.selfcheck', 'platform');
    await expect.poll(() => alarms(live), { timeout: 5000, interval: 100 }).toBe(1);
    const fenced = newObject();
    await ask(fenced, 'substrat.fence', 'platform');
    // Set after the fence, as the wipe's deleteAll() would take one set before it.
    await ask(fenced, 'substrat.selfcheck', 'platform');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await alarms(fenced)).toBe(0);
  });

  // Last in this block: it restarts the runtime the others share.
  it('after a restart the mark is what refuses, on a written object and on one never written', { timeout: TIMEOUT_MS }, async () => {
    const written = newObject();
    expect((await ask(written, 'increment')).status).toBe(200);
    expect((await ask(written, 'substrat.fence', 'platform')).status).toBe(200);
    const neverWritten = newObject();
    expect((await ask(neverWritten, 'substrat.fence', 'platform')).status).toBe(200);
    const live = newObject();
    expect(result(await ask(live, 'increment'))).toBe(1);

    await mf.dispose();
    mf = start();

    expectFenced(await ask(written, 'increment'));
    expectFenced(await ask(written, 'substrat.stage-page', 'platform'));
    expectFenced(await ask(neverWritten, 'increment'));
    expect(result(await ask(live, 'increment'))).toBe(2);
  });
});
