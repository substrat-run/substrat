import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RUNTIME_BASELINE } from '@substrat-run/contracts';
import { generateScopeStoreKeyPair } from '@substrat-run/contracts/scope-store-envelope';
import {
  importWireSigningKey,
  signWireEnvelope,
  signWireRequest,
  WIRE_AUDIENCE_VAR,
  WIRE_ENVELOPE_HEADER,
  WIRE_PLATFORM_KEYS_VAR,
  WIRE_ROUTER_KEYS_VAR,
  WIRE_SIGNATURE_HEADER,
  WIRE_STATE_VAR,
  wireRequestBinding,
  type WireEnvelopeInput,
  type WireSigningKey,
} from '@substrat-run/contracts/wire-signing';
import { WIRE_REFUSAL_BODY } from '../platform-entry/wire-gate.js';
import { PLATFORM_ENTRY_MODULE, withPlatformEntry } from '../src/platform-entry.js';

/**
 * #2245, on workerd: the platform entry imports `node:async_hooks` so a request's store calls
 * reach its line with no observer from the vertical, and workerd allows that import only under
 * `nodejs_als` or `nodejs_compat`. Whether a script with neither starts, and whether a request
 * then really is held in an `AsyncLocalStorage`, are facts about workerd that node cannot
 * answer. So each script here is what `withPlatformEntry` uploads, flags included, run in
 * workerd. The vertical's store call is the kernel's own `observeStoreCall`, bundled into the
 * vertical the way a pushed vertical bundles its kernel: a different copy from the entry's.
 */

const SECRET = 'router-sekret';
const routed = {
  'x-substrat-router': SECRET,
  'x-substrat-tenant': '01JZ0000000000000000TEN001',
  'x-substrat-scope': '01JZ0000000000000000SCP001',
  'x-substrat-vertical': 'acme/widgets',
  'x-substrat-surface': 'app',
};

/** The vertical: two store calls, then answers with the record the platform's stamp holds. */
const VERTICAL = `
import { observeStoreCall } from ${JSON.stringify(fileURLToPath(new URL('../../kernel/src/scope-store.ts', import.meta.url)))};
import { recordAuthCheck } from ${JSON.stringify(fileURLToPath(new URL('../../contracts/src/auth-diagnostics.ts', import.meta.url)))};
export default {
  async fetch(request) {
    await observeStoreCall('GRAPH', 'increment', async () => 1);
    await observeStoreCall('GRAPH', 'read', async () => 1);
    recordAuthCheck({ stage: 'bearer', outcome: 'accepted', reason: 'verified' });
    recordAuthCheck({ stage: 'mcp-caller', outcome: 'refused', reason: 'caller-refused' });
    const stamp = globalThis[Symbol.for('substrat.invocation-stamp')]?.get(request);
    return Response.json({ storeCalls: stamp?.record.storeCalls ?? null, authChecks: stamp?.record.authChecks ?? null });
  },
};`;

let vertical: string;
beforeAll(async () => {
  const out = await build({
    stdin: { contents: VERTICAL, loader: 'ts', resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'import'],
    mainFields: ['module', 'main'],
    write: false,
  });
  vertical = out.outputFiles[0]!.text;
});

const runtimes: Miniflare[] = [];
afterAll(async () => {
  await Promise.all(runtimes.map((mf) => mf.dispose()));
});

/** Upload `source` the way the platform does, with these declared flags and bindings, and run it on workerd. */
function deployed(
  source: string,
  {
    compatibilityFlags = [] as string[],
    compatibilityDate = RUNTIME_BASELINE,
    bindings = {} as Record<string, string>,
    durableObjects = {} as Record<string, { className: string; useSQLite: true }>,
  } = {},
) {
  const uploaded = withPlatformEntry({
    entry: 'worker.js',
    modules: [{ name: 'worker.js', content: new TextEncoder().encode(source), contentType: 'application/javascript+module' }],
    compatibilityFlags,
  });
  const lines: string[] = [];
  const mf = new Miniflare({
    modules: uploaded.modules.map((m) => ({ type: 'ESModule' as const, path: m.name, contents: new TextDecoder().decode(m.content) })),
    modulesRoot: '/',
    compatibilityDate,
    compatibilityFlags: uploaded.compatibilityFlags,
    bindings: { ROUTER_SECRET: SECRET, ...bindings },
    durableObjects,
    // #2192: the network, answered here — a host named `undeclared` the way the egress worker
    // answers one a vertical never declared, everything else 200.
    outboundService: (request: Request) =>
      new URL(request.url).hostname.startsWith('undeclared')
        ? new Response('{}', { status: 403, headers: { 'x-substrat-egress': 'refused' } })
        : new Response('{}', { status: 200 }),
    handleRuntimeStdio(stdout) {
      stdout.on('data', (chunk: Buffer) => lines.push(...chunk.toString().split('\n')));
    },
  });
  runtimes.push(mf);
  expect(uploaded.entry).toBe(PLATFORM_ENTRY_MODULE);
  return { mf, lines, flags: uploaded.compatibilityFlags };
}

/** Upload the vertical with these declared flags, and serve one request. */
async function served(compatibilityFlags: string[], compatibilityDate = RUNTIME_BASELINE, source = vertical, path = '/api/things') {
  const { mf, lines, flags } = deployed(source, { compatibilityFlags, compatibilityDate });
  const res = await mf.dispatchFetch(`https://acme.example${path}`, { headers: routed });
  const body = (await res.json()) as { storeCalls: Array<{ operation: string }> | null; outboundCalls?: unknown; authChecks?: unknown };
  return { flags, status: res.status, body, lines };
}

/** The JSON lines in a script's stdout with this `substrat` discriminator. */
const linesOf = (lines: string[], substrat: string) =>
  lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return undefined; } }).filter((l) => l?.['substrat'] === substrat) as Record<string, unknown>[];

/** The invocation line in a script's stdout. */
const lineOf = (lines: string[]) => linesOf(lines, 'invocation')[0];

const NAMED = [
  { binding: 'GRAPH', operation: 'increment', outcome: 'ok', durationMs: expect.any(Number) },
  { binding: 'GRAPH', operation: 'read', outcome: 'ok', durationMs: expect.any(Number) },
];

describe('the platform entry, uploaded and run on workerd (#2245)', () => {
  it('a script with no flags is given nodejs_als, starts, and names its store calls', async () => {
    const run = await served([]);
    expect(run.flags).toEqual(['nodejs_als']);
    expect(run.status).toBe(200);
    expect(run.body.storeCalls).toEqual(NAMED);
    // And the line the entry writes for the request carries them.
    await expect.poll(() => lineOf(run.lines)?.storeCalls).toEqual(NAMED);
    const checks = [
      { stage: 'bearer', outcome: 'accepted', reason: 'verified' },
      { stage: 'mcp-caller', outcome: 'refused', reason: 'caller-refused' },
    ];
    expect(run.body.authChecks).toEqual(checks);
    expect(lineOf(run.lines)?.authChecks).toEqual(checks);
  });

  it('nodejs_als needs no particular compatibility date', async () => {
    const run = await served([], '2022-01-01');
    expect(run.flags).toEqual(['nodejs_als']);
    expect(run.body.storeCalls).toEqual(NAMED);
  });

  it('a nodejs_compat script is uploaded with its flags unchanged, and names its store calls', async () => {
    const run = await served(['nodejs_compat']);
    expect(run.flags).toEqual(['nodejs_compat']);
    expect(run.body.storeCalls).toEqual(NAMED);
  });

  it('a script that already carries nodejs_als is uploaded unchanged', async () => {
    const run = await served(['nodejs_als']);
    expect(run.flags).toEqual(['nodejs_als']);
    expect(run.body.storeCalls).toEqual(NAMED);
  });

  it('a script that opts out with no_nodejs_als still starts and answers; its line names no calls', async () => {
    const run = await served(['no_nodejs_als']);
    expect(run.flags).toEqual(['no_nodejs_als']);
    expect(run.status).toBe(200);
    expect(run.body.storeCalls).toBeNull();
    expect(run.body.authChecks).toBeNull();
  });

  it('an opt-out beside nodejs_compat still names its calls, through process.getBuiltinModule', async () => {
    const run = await served(['nodejs_compat', 'no_nodejs_als']);
    expect(run.flags).toEqual(['nodejs_compat', 'no_nodejs_als']);
    expect(run.body.storeCalls).toEqual(NAMED);
  });

  it('without the flag the entry could not start: the import is why nodejs_als is added', async () => {
    const mf = new Miniflare({
      modules: [{ type: 'ESModule', path: 'entry.js', contents: `import { AsyncLocalStorage } from "node:async_hooks"; export default { fetch: () => new Response(String(typeof AsyncLocalStorage)) };` }],
      compatibilityDate: RUNTIME_BASELINE,
    });
    try {
      await expect(mf.dispatchFetch('https://acme.example/')).rejects.toThrow(/node:async_hooks/);
    } finally {
      await mf.dispose().catch(() => undefined);
    }
  });
});

/**
 * #2192: the vertical's outbound calls, on workerd. The runtime's `fetch` throws `Illegal
 * invocation` when called on any receiver but `globalThis` (#1291), which node never does — so
 * whether the wrapper the entry installs hands each call on correctly is a workerd fact. The
 * vertical calls `fetch` bare, through an object (`obj.fetch(…)`, the receiver that broke
 * #1291), and with a streamed body, and answers with what each call returned.
 */
const CALLER = `
export default {
  async fetch(request) {
    const client = { fetch };
    const a = await fetch('https://api.example.com/v1/users/42/0123456789abcdef0123456789abcdef?token=sekret');
    const b = await client.fetch('https://undeclared.example.com/oauth/token', { method: 'POST' });
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('chunk')); c.close(); } });
    const c = await globalThis.fetch(new Request('https://api.example.com/upload', { method: 'PUT', body, duplex: 'half' }));
    const stamp = globalThis[Symbol.for('substrat.invocation-stamp')]?.get(request);
    return Response.json({ statuses: [a.status, b.status, c.status], outboundCalls: stamp?.record.outboundCalls ?? null });
  },
};`;

/**
 * RFC wire-signing, step 1: the verifier the entry wraps around the stamp, on workerd. The
 * vertical runs its own legacy checks from vertical-host's and contracts' source, as a pushed
 * vertical bundles them, and answers with what they proved and the body it was handed.
 */
const CHECKING = `
import { readRoutedNode } from ${JSON.stringify(fileURLToPath(new URL('../../vertical-host/src/routed-node.ts', import.meta.url)))};
import { assertPlatformCall } from ${JSON.stringify(fileURLToPath(new URL('../../contracts/src/wire-auth.ts', import.meta.url)))};
export default {
  async fetch(request, env) {
    let node;
    try {
      node = readRoutedNode(request.headers, { expectedSecret: env.ROUTER_SECRET });
    } catch {
      return new Response('router assertion refused', { status: 400 });
    }
    if (new URL(request.url).pathname.startsWith('/internal/')) {
      try {
        assertPlatformCall(request.headers, { expectedSecret: env.PLATFORM_SECRET });
      } catch {
        return new Response('not a platform call', { status: 403 });
      }
    }
    const stamped = globalThis[Symbol.for('substrat.invocation-stamp')]?.get(request) !== undefined;
    return Response.json({ node, stamped, body: await request.text() });
  },
};`;

describe('the wire-signing verifier in the platform entry, on workerd (RFC wire-signing §5)', () => {
  const CALL_VALUE = 'call-legacy-value-0002';
  const AUD = 'acme-widgets-deployment';
  let checking: string;
  let router: WireSigningKey;
  let platform: WireSigningKey;
  let lists: Record<string, string>;
  beforeAll(async () => {
    const out = await build({
      stdin: { contents: CHECKING, loader: 'ts', resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      write: false,
    });
    checking = out.outputFiles[0]!.text;
    const [r, p] = await Promise.all([generateScopeStoreKeyPair(), generateScopeStoreKeyPair()]);
    [router, platform] = await Promise.all([importWireSigningKey(r.privateKey), importWireSigningKey(p.privateKey)]);
    lists = { [WIRE_ROUTER_KEYS_VAR]: r.publicKey, [WIRE_PLATFORM_KEYS_VAR]: p.publicKey, [WIRE_AUDIENCE_VAR]: AUD };
  });

  /** The checking vertical, uploaded as the platform uploads it, with these bindings. */
  function checked(bindings: Record<string, string>) {
    const { mf, lines } = deployed(checking, { bindings: { PLATFORM_SECRET: CALL_VALUE, SUBSTRAT_VERSION_ID: '01JZ0000000000000000VER001', ...bindings } });
    return { mf, lines, wire: () => linesOf(lines, 'wire'), invocation: () => lineOf(lines) };
  }

  const ROUTE = 'https://acme.example/api/things?page=2';
  const routeEnvelope = async (over: Partial<WireEnvelopeInput> = {}) => {
    const issued = await signWireEnvelope(router, {
      iss: 'router',
      kind: 'route',
      aud: AUD,
      tenantId: routed['x-substrat-tenant'],
      scopeId: routed['x-substrat-scope'],
      surface: 'app',
      vertical: 'acme/widgets',
      ...wireRequestBinding({ method: 'GET', url: ROUTE }),
      ...over,
    });
    return { [WIRE_ENVELOPE_HEADER]: issued.header, [WIRE_SIGNATURE_HEADER]: issued.signature };
  };
  type Answer = { node: { tenantId: string; scopeId: string } | null; stamped: boolean; body: string };

  it('with no key lists nothing changes: served as before, and no wire line is written', async () => {
    const d = checked({});
    const res = await d.mf.dispatchFetch(ROUTE, { headers: { ...routed, ...(await routeEnvelope()) } });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as Answer;
    expect(answer).toMatchObject({ node: { tenantId: routed['x-substrat-tenant'] }, stamped: true });
    await expect.poll(() => d.invocation()?.['tenantId']).toBe(routed['x-substrat-tenant']);
    expect(d.wire()).toEqual([]);
  });

  it('step 2, no key lists yet: the signers’ own requests are served as before, a call’s body byte for byte, and no wire line', async () => {
    const d = checked({});
    // Built by `signWireRequest`, the one function the router and the control plane sign with.
    const route = await signWireRequest(router, new Request(ROUTE, { headers: routed }), {
      iss: 'router',
      kind: 'route',
      aud: AUD,
      tenantId: routed['x-substrat-tenant'],
      scopeId: routed['x-substrat-scope'],
      surface: 'app',
      vertical: 'acme/widgets',
    });
    const routeRes = await d.mf.dispatchFetch(route.url, { headers: Object.fromEntries(route.headers) });
    expect(routeRes.status).toBe(200);
    expect(((await routeRes.json()) as Answer).node).toMatchObject({ tenantId: routed['x-substrat-tenant'] });
    const body = JSON.stringify({ note: 'é'.repeat(1000) });
    const call = await signWireRequest(
      platform,
      new Request('https://vertical/internal/query', { method: 'POST', headers: { 'x-substrat-platform': CALL_VALUE }, body }),
      { iss: 'platform', kind: 'call', aud: AUD },
    );
    const callRes = await d.mf.dispatchFetch(call.url, { method: 'POST', headers: Object.fromEntries(call.headers), body: await call.text() });
    expect(callRes.status).toBe(200);
    expect(((await callRes.json()) as Answer).body).toBe(body);
    await expect.poll(() => d.invocation()?.['tenantId']).toBe(routed['x-substrat-tenant']);
    expect(d.wire()).toEqual([]);
  });

  it('dual: a routed request is served as today and its envelope counted beside the invocation line', async () => {
    const d = checked({ ...lists, [WIRE_STATE_VAR]: 'dual' });
    const res = await d.mf.dispatchFetch(ROUTE, { headers: { ...routed, ...(await routeEnvelope()) } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Answer).stamped).toBe(true);
    await expect.poll(() => d.wire()).toEqual([expect.objectContaining({ substrat: 'wire', state: 'dual', outcome: 'signed-accepted', legacy: 'valid' })]);
    await expect.poll(() => d.invocation()?.['tenantId']).toBe(routed['x-substrat-tenant']);
  });

  it('dual: an envelope alone admits a routed request, and the vertical and its line see the envelope’s identity', async () => {
    const d = checked({ ...lists, [WIRE_STATE_VAR]: 'dual' });
    const res = await d.mf.dispatchFetch(ROUTE, { headers: await routeEnvelope() });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as Answer;
    expect(answer.node).toMatchObject({ tenantId: routed['x-substrat-tenant'], scopeId: routed['x-substrat-scope'] });
    // The request the vertical was handed is the one the platform stamped: one request, one line.
    expect(answer.stamped).toBe(true);
    await expect.poll(() => d.invocation()?.['scopeId']).toBe(routed['x-substrat-scope']);
    expect(d.wire()).toEqual([expect.objectContaining({ outcome: 'signed-accepted', legacy: 'absent' })]);
  });

  it('dual: a call’s body is read to be verified and still reaches the vertical byte for byte', async () => {
    const d = checked({ ...lists, [WIRE_STATE_VAR]: 'dual' });
    const url = 'https://vertical/internal/query';
    const body = JSON.stringify({ note: 'é'.repeat(70_000) });
    const issued = await signWireEnvelope(platform, { iss: 'platform', kind: 'call', aud: AUD, ...wireRequestBinding({ method: 'POST', url }), body });
    const res = await d.mf.dispatchFetch(url, {
      method: 'POST',
      headers: { 'x-substrat-platform': CALL_VALUE, [WIRE_ENVELOPE_HEADER]: issued.header, [WIRE_SIGNATURE_HEADER]: issued.signature },
      body,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Answer).body).toBe(body);
    await expect.poll(() => d.wire()).toEqual([expect.objectContaining({ kind: 'call', outcome: 'signed-accepted', legacy: 'valid' })]);
  });

  it('signed-only: a refusal is the fixed answer, the vertical never runs, and no credential is in any output', async () => {
    const d = checked({ ...lists, [WIRE_STATE_VAR]: 'signed-only' });
    const refused = await d.mf.dispatchFetch(ROUTE, { headers: routed });
    expect(refused.status).toBe(401);
    const text = await refused.text();
    expect(text).toBe(WIRE_REFUSAL_BODY);
    // Its positive twin: the same request with its envelope is served.
    const served = await d.mf.dispatchFetch(ROUTE, { headers: { ...routed, ...(await routeEnvelope()) } });
    expect(served.status).toBe(200);
    await served.text();
    await expect.poll(() => d.wire().map((l) => l['outcome'])).toEqual(['refused', 'signed-accepted']);
    const everything = [text, JSON.stringify([...refused.headers]), JSON.stringify([...served.headers]), ...d.lines].join('\n');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(CALL_VALUE);
  });
});

/**
 * RFC wire-signing §4, on workerd: a vertical whose bundle carries a current adapter and registers
 * its host, as `mountPlatformSurface` does, has its signed calls' nonces spent in the scope's own
 * object, the adapter's own `defineScopeDO` bound as the vertical binds it. The vertical answers
 * with the body it was handed, after the legacy check every vertical makes.
 */
const STORING = `
import { CloudflareScopeHost, defineScopeDO } from ${JSON.stringify(fileURLToPath(new URL('../../adapter-cloudflare/src/index.ts', import.meta.url)))};
import { registerScopeSweepHost } from ${JSON.stringify(fileURLToPath(new URL('../../vertical-host/src/scope-sweep-host.ts', import.meta.url)))};
import { assertPlatformCall } from ${JSON.stringify(fileURLToPath(new URL('../../contracts/src/wire-auth.ts', import.meta.url)))};
export const ScopeDO = defineScopeDO([], {});
registerScopeSweepHost((env) => new CloudflareScopeHost({ scope: env.SCOPE }));
export default {
  async fetch(request, env) {
    try {
      assertPlatformCall(request.headers, { expectedSecret: env.PLATFORM_SECRET });
    } catch {
      return new Response('not a platform call', { status: 403 });
    }
    // Read through the platform's stamp, as a current vertical-host does, so the entry wraps it.
    const stamped = globalThis[Symbol.for('substrat.invocation-stamp')]?.get(request) !== undefined;
    return Response.json({ stamped, body: await request.text() });
  },
};`;

describe('the nonce store the entry claims in, on workerd (RFC wire-signing §4)', () => {
  const CALL_VALUE = 'call-legacy-value-0002';
  const AUD = 'acme-widgets-deployment';
  const TENANT = '01JZ0000000000000000TEN001';
  const SCOPE = '01JZ0000000000000000SCP001';
  const PROVISION = 'https://vertical/internal/provision';
  let storing: string;
  let platform: WireSigningKey;
  let lists: Record<string, string>;
  beforeAll(async () => {
    const out = await build({
      stdin: { contents: STORING, loader: 'ts', resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'import'],
      mainFields: ['module', 'main'],
      external: ['cloudflare:*', 'node:*'],
      write: false,
    });
    storing = out.outputFiles[0]!.text;
    const [r, p] = await Promise.all([generateScopeStoreKeyPair(), generateScopeStoreKeyPair()]);
    platform = await importWireSigningKey(p.privateKey);
    lists = { [WIRE_ROUTER_KEYS_VAR]: r.publicKey, [WIRE_PLATFORM_KEYS_VAR]: p.publicKey, [WIRE_AUDIENCE_VAR]: AUD };
  });

  function stored(state: string) {
    const { mf, lines } = deployed(storing, {
      compatibilityFlags: ['nodejs_compat'],
      bindings: { PLATFORM_SECRET: CALL_VALUE, ...lists, [WIRE_STATE_VAR]: state },
      durableObjects: { SCOPE: { className: 'ScopeDO', useSQLite: true } },
    });
    return { mf, wire: () => linesOf(lines, 'wire') };
  }
  const body = JSON.stringify({ tenantId: TENANT, scopeId: SCOPE });
  const envelope = async () => {
    const issued = await signWireEnvelope(platform, {
      iss: 'platform',
      kind: 'call',
      aud: AUD,
      tenantId: TENANT,
      scopeId: SCOPE,
      ...wireRequestBinding({ method: 'POST', url: PROVISION }),
      body,
    });
    return { [WIRE_ENVELOPE_HEADER]: issued.header, [WIRE_SIGNATURE_HEADER]: issued.signature };
  };
  const send = (d: ReturnType<typeof stored>, headers: Record<string, string>) => d.mf.dispatchFetch(PROVISION, { method: 'POST', headers, body });

  it('signed-only: a call that changes state is accepted once, and the same envelope again is refused', async () => {
    const d = stored('signed-only');
    const first = await envelope();
    const accepted = await send(d, first);
    expect(accepted.status).toBe(200);
    await accepted.text();
    const replayed = await send(d, first);
    expect(replayed.status).toBe(401);
    expect(await replayed.text()).toBe(WIRE_REFUSAL_BODY);
    await expect.poll(() => d.wire().map((l) => l['reason'])).toEqual([null, 'replay']);
  });
});

describe('the platform entry records a vertical’s outbound calls, on workerd (#2192)', () => {
  it('every call reaches the network with the receiver workerd needs, and the line names each one', async () => {
    const run = await served([], RUNTIME_BASELINE, CALLER);
    expect(run.status).toBe(200);
    const body = run.body as unknown as { statuses: number[]; outboundCalls: unknown };
    expect(body.statuses).toEqual([200, 403, 200]);
    const named = [
      { host: 'api.example.com', path: '/v1/users/42/[redacted]', method: 'GET', status: 200, outcome: 'ok', durationMs: expect.any(Number), atMs: expect.any(Number) },
      { host: 'undeclared.example.com', path: '/oauth/token', method: 'POST', status: 403, outcome: 'refused', durationMs: expect.any(Number), atMs: expect.any(Number) },
      { host: 'api.example.com', path: '/upload', method: 'PUT', status: 200, outcome: 'ok', durationMs: expect.any(Number), atMs: expect.any(Number) },
    ];
    expect(body.outboundCalls).toEqual(named);
    await expect.poll(() => lineOf(run.lines)?.outboundCalls).toEqual(named);
    // Redacted on the way to the line, in the entry as it is uploaded.
    expect(run.lines.join('\n')).not.toContain('sekret');
    expect(run.lines.join('\n')).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('a script that opts out of AsyncLocalStorage still makes its calls; its line names none', async () => {
    // No recorder is installed here, so the runtime's own `fetch` is reached directly, and it
    // still refuses an object receiver: the call is made bare.
    const run = await served(['no_nodejs_als'], RUNTIME_BASELINE, CALLER.replace('client.fetch(', 'fetch('));
    expect(run.status).toBe(200);
    const body = run.body as unknown as { statuses: number[]; outboundCalls: unknown };
    expect(body.statuses).toEqual([200, 403, 200]);
    expect(body.outboundCalls).toBeNull();
  });
});
