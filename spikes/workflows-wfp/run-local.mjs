/**
 * The Workflows spike on local workerd (miniflare). No account is needed.
 *
 *   pnpm install --ignore-workspace
 *   node run-local.mjs
 *
 * Every line is one of:
 *   PASS  a property the RFC's rule needs, and it holds here
 *   FAIL  a property the rule needs, and it does not hold here (a finding, not a harness bug)
 *   SEEN  an observation the findings cite, with no expected value
 * A harness error (a timeout waiting for a state, an exception) exits 2. FAIL lines exit 1.
 *
 * Local workerd runs miniflare's own Workflows engine, not Cloudflare's. What it shows is how the
 * engine's API behaves and how our scope shapes meet it. What only the hosted engine can answer is
 * in RUNBOOK.md, and probe.mjs asks the shared questions of a deployed copy.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { factsFor, makeClient, reporter, sleep, waits } from './harness.mjs';
import { bindingAndDoor, previewCopy, retrySafety, waking } from './scenarios.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(root, 'src', 'entry.mjs');
const r = reporter();
const w = waits();

function verticalWorker(name, { workflowName, code = 'v1', plan = 'v1', primary = '1', outbound, scopeScript }) {
  return {
    name,
    modules: true,
    scriptPath: ENTRY,
    compatibilityDate: '2026-06-01',
    durableObjects: { SCOPE: { className: 'ScopeDO', useSQLite: true, ...(scopeScript ? { scriptName: scopeScript } : {}) } },
    workflows: { FLOW: { name: workflowName, className: 'OrderFlow' } },
    bindings: { CODE_VERSION: code, STEP_PLAN: plan, PRIMARY: primary },
    ...(outbound ? { outboundService: outbound } : {}),
  };
}

function open(workers, persist) {
  return new Miniflare({
    workers,
    ...(persist ? { durableObjectsPersist: join(persist, 'do'), workflowsPersist: join(persist, 'wf') } : {}),
  });
}

const clientsOf = (mf) => {
  const cache = new Map();
  return async (name) => {
    if (!cache.has(name)) {
      const worker = await mf.getWorker(name);
      cache.set(name, makeClient((path, q) => worker.fetch(`http://vertical${path}?${new URLSearchParams(q)}`)));
    }
    return cache.get(name);
  };
};

/** The scenarios probe.mjs asks of a deployed copy, asked here of one process. */
async function shared() {
  const outside = [];
  const mf = open([
    verticalWorker('acme', { workflowName: 'acme-flow' }),
    verticalWorker('acme-v2', {
      workflowName: 'acme-v2-flow',
      code: 'v2',
      primary: '0',
      outbound: async (req) => {
        outside.push(new URL(req.url).host);
        return new Response('reached');
      },
    }),
  ]);
  try {
    const ctx = { r, w, client: clientsOf(mf), tag: 'local' };
    await bindingAndDoor(ctx);
    await waking(ctx);
    await retrySafety(ctx);
    await previewCopy({ ...ctx, outsideHits: () => outside, fetchUrl: 'https://outside.example/hook' });
  } finally {
    await mf.dispose();
  }
}

/** Two scripts declaring one workflow name: an archive uploaded with the stable script's binding as it is. */
async function nameClash() {
  r.heading('one workflow name on two scripts');
  const mf = open([verticalWorker('acme', { workflowName: 'acme-flow' }), verticalWorker('acme-v2', { workflowName: 'acme-flow', code: 'v2', primary: '0' })]);
  try {
    const client = clientsOf(mf);
    const prod = await client('acme');
    const prev = await client('acme-v2');
    await prev.start('s1', 'clash');
    // Which script's code ran it shows in which script's scope its facts land.
    const outcome = await w.until('the clash instance to write anywhere', async () => {
      const copyFacts = factsFor(await prev.dump('s1'), 'clash').map((f) => `${f.kind}@${f.code}`);
      const realFacts = factsFor(await prod.dump('s1'), 'clash').map((f) => `${f.kind}@${f.code}`);
      return { ok: copyFacts.length + realFacts.length > 0, value: { createdThrough: 'acme-v2 (the copy)', copyFacts, realFacts } };
    });
    r.see('name-clash', 'an instance created through the second of two scripts declaring one workflow name', outcome);
    r.check(outcome.realFacts.length === 0, "an instance created through a preview's binding never writes to production", outcome);
  } finally {
    await mf.dispose();
  }
}

/** A promote: the same script name and the same persisted state, restarted on other code. */
async function promote() {
  r.heading('a promote with instances in flight');
  const persist = mkdtempSync(join(tmpdir(), 'wf-spike-'));
  try {
    // Version 1 starts three instances and stops while they wait or sleep.
    let mf = open([verticalWorker('acme', { workflowName: 'acme-flow', code: 'v1' })], persist);
    let c = await clientsOf(mf)('acme');
    const waiting = await c.start('s1', 'w');
    const sleeping = await c.start('s1', 'z', { nap: '2 seconds' });
    const inserted = await c.start('s1', 'i');
    await w.parked(c, 's1', 'w');
    await w.parked(c, 's1', 'i');
    await w.parked(c, 's1', 'z', 0); // stopped inside its two-second sleep
    await mf.dispose();

    // The same script, version 2, which renamed its first step.
    mf = open([verticalWorker('acme', { workflowName: 'acme-flow', code: 'v2', plan: 'renamed' })], persist);
    c = await clientsOf(mf)('acme');
    await c.approve('s1', 'w');
    const done = await w.statusIs(c, waiting.id, 'complete', 'errored');
    const wf = factsFor(await c.dump('s1'), 'w');
    r.see('promote-waiting', 'facts of an instance that waited across the promote (v2 renamed its first step)', wf.map((f) => `${f.kind}@${f.code}`));
    r.check(done.output?.closedBy === 'v2', 'a waiting instance resumes on the promoted code', done.output);
    r.check(wf.filter((f) => f.kind === 'open-order').length === 1, 'a step renamed by the promote is not run a second time', wf.map((f) => `${f.kind}@${f.code}`));

    await sleep(2500); // past the end of the sleep it was stopped in
    const during = (await c.status(sleeping.id)).status;
    await c.approve('s1', 'z');
    const z = await w.statusIs(c, sleeping.id, 'complete', 'errored');
    r.see('promote-sleeping', 'an instance stopped in a sleep, after the promote, woken and approved', { statusAfterItsSleep: during, output: z.output, facts: factsFor(await c.dump('s1'), 'z').map((f) => `${f.kind}@${f.code}`) });
    await mf.dispose();

    // Version 3 inserts a step before the wait the instance is in.
    mf = open([verticalWorker('acme', { workflowName: 'acme-flow', code: 'v3', plan: 'inserted' })], persist);
    c = await clientsOf(mf)('acme');
    await c.approve('s1', 'i');
    const i = await w.statusIs(c, inserted.id, 'complete', 'errored');
    const ifacts = factsFor(await c.dump('s1'), 'i').map((f) => `${f.kind}@${f.code}`);
    r.see('promote-inserted', 'facts of an instance whose code gained a step before its current wait', ifacts);
    r.check(!ifacts.some((f) => f.startsWith('note')), 'a step inserted before the current position does not run for an instance already past it', { status: i.status, facts: ifacts });
    await mf.dispose();
  } finally {
    rmSync(persist, { recursive: true, force: true });
  }
}

/**
 * Staying on a version: the workflow in a per-version script, its scope binding pointing at the
 * stable script's class (a cross-script binding the sandbox allowlist refuses today).
 */
async function pinned() {
  r.heading('an instance held on its version');
  const persist = mkdtempSync(join(tmpdir(), 'wf-spike-pin-'));
  const pinnedWorker = (code) => verticalWorker(`acme-${code}`, { workflowName: `acme-${code}-flow`, code, scopeScript: 'acme' });
  try {
    let mf = open([verticalWorker('acme', { workflowName: 'acme-flow', code: 'v1' }), pinnedWorker('v1')], persist);
    let pin = await clientsOf(mf)('acme-v1');
    const { id } = await pin.start('s1', 'pin');
    await w.parked(pin, 's1', 'pin');
    await mf.dispose();

    // The stable script is promoted to v2 (renamed steps); the v1 workflow script is left as it was.
    mf = open([verticalWorker('acme', { workflowName: 'acme-flow', code: 'v2', plan: 'renamed' }), pinnedWorker('v1')], persist);
    const client = clientsOf(mf);
    const prod = await client('acme');
    pin = await client('acme-v1');
    await prod.approve('s1', 'pin', false);
    await pin.bell(id, 'after-promote');
    const done = await w.statusIs(pin, id, 'complete', 'errored');
    const facts = factsFor(await prod.dump('s1'), 'pin').map((f) => `${f.kind}@${f.code}`);
    r.see('pinned', 'an instance in a per-version workflow script, across a promote of the stable script', { flowCode: done.output?.closedBy, factsInProduction: facts });
    r.check(done.output?.closedBy === 'v1' && facts.filter((f) => f.startsWith('open-order')).length === 1, 'an instance can stay on the version that started it, writing to the production scope', facts);
    await mf.dispose();
  } finally {
    rmSync(persist, { recursive: true, force: true });
  }
}

try {
  await shared();
  await nameClash();
  await promote();
  await pinned();
} catch (err) {
  console.error(`\nharness error: ${err?.stack ?? err}`);
  process.exit(2);
}
console.log(`\n${r.failures()} FAIL line(s). A FAIL is a finding: see FINDINGS.md.`);
process.exit(r.failures() ? 1 : 0);
