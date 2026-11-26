import { build } from 'esbuild';
import { Miniflare, type MiniflareOptions } from 'miniflare';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * PROBE, opt-in (`SUBSTRAT_PROBE_PEER_HOPS=1`): one peer call end to end, per hop, on workerd,
 * before and after the routing read model serves peer-call answers (#3395 follow-up).
 *
 *   caller vertical → egress (the real worker) → router `PeerCalls` (the real `handlePeerCall`,
 *   a real `ControlPlaneDO` and KV) → the target vertical, and back.
 *
 * Every hop is keyed by the call's W3C trace id (#3386): the caller sends a `traceparent`, egress
 * passes it beside the caller, the router records its hops under that id and continues it onto the
 * target, which hands it back. The phases:
 *
 * - **off**: `PEER_READ_MODEL` off, the directory on every call (before).
 * - **on, first ask**: the answer is not published yet, so the directory answers and is asked to
 *   publish it.
 * - **on, cold isolate**: the workers restarted (storage kept), so the router's memory is empty and
 *   the answer comes from KV.
 * - **on, warm isolate**: the same isolate again, from memory: no read at all.
 *
 * Local numbers measure the hop structure, not production distance: here the directory object sits
 * in the same process, where production's sits in one place for the world (290 ms p50 from Sydney
 * to Madrid for a route, K-72's measurement). What carries over is which hops a call takes.
 */

const PROBE = process.env.SUBSTRAT_PROBE_PEER_HOPS === '1';
const N = 40;
const compatibilityDate = '2025-01-01';
const AT = '2026-11-26T00:00:00.000Z';
const TENANT = '01JZ0000000000000000PEERH0';
const CALLER = '01J00000000000000000000C01';
const TARGET = '01J00000000000000000000T01';
const FROM = 'board-room';
const TO = 'crm';

const CALLER_SCRIPT = `export default {
  async fetch(request) {
    const { traceparent } = await request.json();
    const t0 = Date.now();
    const res = await fetch('https://peer.substrat.internal/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', traceparent },
      body: JSON.stringify({ vertical: '${TO}', operation: 'customer/list' }),
    });
    const body = await res.json();
    return Response.json({ t0, t1: Date.now(), status: res.status, body });
  },
};`;

const TARGET_SCRIPT = `export default {
  async fetch(request) {
    return Response.json({ result: { receivedAt: Date.now(), traceparent: request.headers.get('traceparent') } });
  },
};`;

const bundle = async (entry: string) =>
  (
    await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url).href)],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'import'],
      mainFields: ['module', 'main'],
      external: ['cloudflare:workers'],
      write: false,
    })
  ).outputFiles[0]!.text;

let mf: Miniflare;
let options: MiniflareOptions;
let persist = '';

const SEED: Array<[string, ...unknown[]]> = [
  [`INSERT INTO tenants (tenant_id, slug, name, created_at) VALUES (?, 'acme', 'T', ?)`, TENANT, AT],
  ...[FROM, TO].flatMap((slug): Array<[string, ...unknown[]]> => [
    [
      `INSERT INTO vertical_versions (id, vertical_slug, version, manifest_digest, permission_digest, migration_digest,
         admission, created_at, deployment_ref, manifest_json) VALUES (?, ?, '1.0.0', 'm', 'p', 'g', 'admitted', ?, ?, ?)`,
      `${slug}-v1`, slug, AT, `${slug}-v1`, JSON.stringify({ outbound: [], calls: slug === FROM ? [TO] : [] }),
    ],
    [
      `INSERT INTO verticals (slug, name, source, created_at, serving_ref, serving_version_id) VALUES (?, ?, 'cli', ?, ?, ?)`,
      slug, slug, AT, `${slug}-serving`, `${slug}-v1`,
    ],
  ]),
  ...[[CALLER, FROM], [TARGET, TO]].map(([scope, slug]): [string, ...unknown[]] => [
    `INSERT INTO scopes (scope_id, tenant_id, slug, kind, name, vertical, vertical_version_id, serving_ref, created_at)
     VALUES (?, ?, ?, 'install', 'S', ?, ?, ?, ?)`,
    scope, TENANT, `s-${slug}`, slug, `${slug}-v1`, `${slug}-serving`, AT,
  ]),
];

const router = async (path: string, init?: { method: string; body: string }) => (await mf.getWorker('router')).fetch(`https://router${path}`, init);
const hex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

interface Measured {
  total: number;
  egress: number;
  resolve: number;
  dispatch: number;
  back: number;
  directoryCalls: number;
  kvReads: number;
}

/** One peer call under a fresh trace, and its hops as the caller, the router and the target saw them. */
async function oneCall(): Promise<Measured> {
  const trace = hex(16);
  const res = await (await mf.getWorker('caller')).fetch('https://caller/', {
    method: 'POST',
    body: JSON.stringify({ traceparent: `00-${trace}-${hex(8)}-01` }),
  });
  const c = (await res.json()) as { t0: number; t1: number; status: number; body: { result: { receivedAt: number; traceparent: string } } };
  expect(c.status, JSON.stringify(c.body)).toBe(200);
  // The target's request continues the caller's trace under the router's span (#3386).
  expect(c.body.result.traceparent.split('-')[1]).toBe(trace);
  const h = (await (await router(`/hops?trace=${trace}`)).json()) as {
    routerEnter: number; dispatchStart: number; directory: { calls: number; ms: number }; kv: { calls: number; ms: number };
  };
  return {
    total: c.t1 - c.t0,
    egress: h.routerEnter - c.t0,
    resolve: h.directory.ms + h.kv.ms,
    dispatch: c.body.result.receivedAt - h.dispatchStart,
    back: c.t1 - c.body.result.receivedAt,
    directoryCalls: h.directory.calls,
    kvReads: h.kv.calls,
  };
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]!;
function summary(phase: string, runs: Measured[]) {
  const col = (k: keyof Measured) => runs.map((r) => r[k]);
  const ms = (k: keyof Measured) => `${pct(col(k), 0.5)} / ${pct(col(k), 0.95)}`;
  return {
    phase,
    calls: runs.length,
    'total ms p50/p95': ms('total'),
    'caller→router': ms('egress'),
    'resolve (directory+KV)': ms('resolve'),
    'router→target': ms('dispatch'),
    'target→caller': ms('back'),
    'directory RPCs/call': col('directoryCalls').reduce((a, b) => a + b, 0) / runs.length,
    'KV reads/call': col('kvReads').reduce((a, b) => a + b, 0) / runs.length,
  };
}

beforeAll(async () => {
  if (!PROBE) return;
  persist = mkdtempSync(join(tmpdir(), 'peer-hop-'));
  options = {
    kvPersist: join(persist, 'kv'),
    durableObjectsPersist: join(persist, 'do'),
    workers: [
      { name: 'caller', modules: true, script: CALLER_SCRIPT, compatibilityDate, outboundService: 'egress' },
      {
        name: 'egress',
        modules: [{ type: 'ESModule', path: 'worker.mjs', contents: await bundle('../src/worker.ts') }],
        compatibilityDate,
        bindings: { OUTBOUND_POLICY: { slug: FROM, tenant: TENANT, scope: CALLER, hosts: [], calls: [TO], depth: 0 } },
        serviceBindings: { PEER_CALLS: { name: 'router', entrypoint: 'PeerCalls' } },
      },
      {
        name: 'router',
        modules: [{ type: 'ESModule', path: 'worker.mjs', contents: await bundle('./peer-hop-entry.ts') }],
        compatibilityDate,
        kvNamespaces: { ROUTES: 'routes' },
        durableObjects: { CONTROL_PLANE: { className: 'ProbeControlPlaneDO', useSQLite: true } },
        serviceBindings: { TARGET: 'target' },
      },
      { name: 'target', modules: true, script: TARGET_SCRIPT, compatibilityDate },
    ],
  };
  mf = new Miniflare(options);
  await router('/seed', { method: 'POST', body: JSON.stringify(SEED) });
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
  if (persist) rmSync(persist, { recursive: true, force: true });
});

describe.runIf(PROBE)('PROBE: one peer call, per hop, before and after the read model (#3395 follow-up)', () => {
  it('measures each phase under its trace ids', async () => {
    const off: Measured[] = [];
    for (let i = 0; i < N; i++) off.push(await oneCall());

    await router('/mode?m=on');
    const firstAsk = [await oneCall()];
    await router('/settle');

    // A fresh isolate: the router's memory is gone, KV and the directory are kept.
    await mf.setOptions(options);
    await router('/mode?m=on');
    const cold = [await oneCall()];
    const warm: Measured[] = [];
    for (let i = 1; i < N; i++) warm.push(await oneCall());

    const table = [summary('off (before)', off), summary('on, first ask', firstAsk), summary('on, cold isolate', cold), summary('on, warm isolate', warm)];
    console.table(table);
    console.log(JSON.stringify({ probe: 'peer-hops', table }));

    expect(off.every((r) => r.directoryCalls === 1 && r.kvReads === 0)).toBe(true);
    expect(firstAsk[0]).toMatchObject({ directoryCalls: 1 });
    expect(cold[0]).toMatchObject({ directoryCalls: 0, kvReads: 2 }); // the answer and the target's serving policy
    expect(warm.every((r) => r.directoryCalls === 0 && r.kvReads === 0)).toBe(true);
  }, 120_000);
});
