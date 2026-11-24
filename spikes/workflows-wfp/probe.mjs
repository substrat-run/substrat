/**
 * The spike's questions, asked of a deployed copy through the dispatcher (RUNBOOK.md). One phase per
 * point where a person deploys something in between. Each prints PASS/FAIL/SEEN lines, then the
 * block to paste back.
 *
 *   node probe.mjs --url <dispatcher url> --token <token> --tag <run label> --phase <phase>
 *
 * Phases, in runbook order:
 *   shared          binding and door, waking, a retried step (stable script)
 *   preview         a preview's instance, its copy, and its steps' network (preview script)
 *   promote-start   starts three instances that will be in flight across the promotes
 *   promote-after   after the stable script is re-uploaded as v2 (a step renamed)
 *   inserted-after  after it is re-uploaded as v3 (a step inserted before the current wait)
 *   clash           after a second script declared the stable script's workflow name
 *   status          the status of every instance a tag started (any time, e.g. after a delete)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { factsFor, makeClient, reporter, sleep, waits } from './harness.mjs';
import { bindingAndDoor, previewCopy, retrySafety, waking } from './scenarios.mjs';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string' },
    token: { type: 'string' },
    tag: { type: 'string' },
    phase: { type: 'string' },
  },
});
for (const k of ['url', 'token', 'tag', 'phase']) {
  if (!args[k]) {
    console.error(`--${k} is required`);
    process.exit(2);
  }
}
if (!/^[a-z0-9-]{1,24}$/.test(args.tag)) {
  console.error('--tag: lowercase letters, digits and dashes, at most 24');
  process.exit(2);
}

const SCRIPT = { acme: 'substrat-spike-wf-acme', 'acme-v2': 'substrat-spike-wf-acme-v2', 'acme-clash': 'substrat-spike-wf-acme-clash' };
const base = args.url.replace(/\/$/, '');
const client = async (name) =>
  makeClient((path, q) => fetch(`${base}/${SCRIPT[name]}${path}?${new URLSearchParams(q)}`, { headers: { 'x-spike-token': args.token } }));
const r = reporter();
// Hosted: a new instance can take seconds to start, and a promote a little longer to reach everywhere.
const w = waits({ timeoutMs: 180_000, pollMs: 1000, settleMs: 3000 });
const stateFile = `.probe-state-${args.tag}.json`;
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const ctx = { r, w, client, tag: args.tag };

async function promoteStart() {
  r.heading('promote: instances put in flight on v1');
  const c = await client('acme');
  const scope = `s-${args.tag}-promote`;
  state.scope = scope;
  state.waiting = (await c.start(scope, `${args.tag}-w`)).id;
  state.sleeping = (await c.start(scope, `${args.tag}-z`, { nap: '10 minutes' })).id;
  state.inserted = (await c.start(scope, `${args.tag}-i`)).id;
  save();
  await w.parked(c, scope, `${args.tag}-w`);
  await w.parked(c, scope, `${args.tag}-i`);
  await w.parked(c, scope, `${args.tag}-z`);
  for (const k of ['waiting', 'sleeping', 'inserted']) r.see(`start-${k}`, `${k} instance on v1`, { id: state[k], status: (await c.status(state[k])).status });
  r.see('promote-started-at', 'the sleeping instance wakes ten minutes after', new Date().toISOString());
}

async function promoteAfter() {
  r.heading('promote: after the stable script was re-uploaded as v2 (renamed step)');
  const c = await client('acme');
  const { scope } = state;
  await c.approve(scope, `${args.tag}-w`);
  const done = await w.statusIs(c, state.waiting, 'complete', 'errored');
  const wf = factsFor(await c.dump(scope), `${args.tag}-w`).map((f) => `${f.kind}@${f.code}`);
  r.see('promote-waiting', 'facts of an instance that waited across the promote', wf);
  r.check(done.output?.closedBy === 'v2', 'a waiting instance resumes on the promoted code', done.output);
  r.check(wf.filter((f) => f.startsWith('open-order')).length === 1, 'a step renamed by the promote is not run a second time', wf);

  r.see('promote-sleeping-now', 'the sleeping instance, still inside its sleep', (await c.status(state.sleeping)).status);
  // Its ten minutes run from promote-start; wait them out, then ring.
  await w.until('the sleeping instance to wake and park at its wait', async () => {
    const d = await c.dump(scope);
    const opens = factsFor(d, `${args.tag}-z`).filter((f) => f.kind === 'open-order').length;
    return { ok: opens >= 2 || (Date.now() - Date.parse(state.startedAt ?? 0) > 11 * 60_000), value: d };
  }, 12 * 60_000);
  await c.approve(scope, `${args.tag}-z`);
  const z = await w.statusIs(c, state.sleeping, 'complete', 'errored');
  r.see('promote-sleeping', 'an instance that slept across the promote, woken and approved', { output: z.output, facts: factsFor(await c.dump(scope), `${args.tag}-z`).map((f) => `${f.kind}@${f.code}`) });
}

async function insertedAfter() {
  r.heading('promote: after the stable script was re-uploaded as v3 (inserted step)');
  const c = await client('acme');
  await c.approve(state.scope, `${args.tag}-i`);
  const i = await w.statusIs(c, state.inserted, 'complete', 'errored');
  const facts = factsFor(await c.dump(state.scope), `${args.tag}-i`).map((f) => `${f.kind}@${f.code}`);
  r.see('promote-inserted', 'facts of an instance whose code gained a step before its current wait', facts);
  r.check(!facts.some((f) => f.startsWith('note')), 'a step inserted before the current position does not run for an instance already past it', { status: i.status, facts });
}

async function clash() {
  r.heading('one workflow name on two scripts');
  const prod = await client('acme');
  const other = await client('acme-clash');
  const scope = `s-${args.tag}-clash`;
  const viaOther = await other.start(scope, `${args.tag}-c1`);
  const viaProd = await prod.start(scope, `${args.tag}-c2`);
  await sleep(20_000);
  const where = async (order) => ({
    stable: factsFor(await prod.dump(scope), order).map((f) => `${f.kind}@${f.code}`),
    clash: factsFor(await other.dump(scope), order).map((f) => `${f.kind}@${f.code}`),
  });
  r.see('clash-via-second', "an instance created through the second script's binding: where its steps wrote", { start: viaOther, ...(await where(`${args.tag}-c1`)) });
  r.see('clash-via-stable', "an instance created through the stable script's binding after the second deploy", { start: viaProd, ...(await where(`${args.tag}-c2`)) });
}

async function statusAll() {
  r.heading('status of every instance this tag started');
  for (const name of ['acme', 'acme-v2']) {
    const c = await client(name);
    for (const k of ['waiting', 'sleeping', 'inserted', 'preview']) if (state[k]) r.see(`status-${name}-${k}`, `${k} asked of ${name}`, await c.status(state[k]));
  }
}

const phases = {
  shared: async () => {
    await bindingAndDoor(ctx);
    await waking(ctx);
    await retrySafety(ctx);
  },
  preview: async () => {
    await previewCopy({ ...ctx, fetchUrl: 'https://example.com/' });
    state.preview = `flow-s-${args.tag}-pv-${args.tag}-pv`;
    save();
  },
  'promote-start': async () => {
    state.startedAt = new Date().toISOString();
    await promoteStart();
  },
  'promote-after': promoteAfter,
  'inserted-after': insertedAfter,
  clash,
  status: statusAll,
};
if (!phases[args.phase]) {
  console.error(`unknown --phase ${args.phase}; one of ${Object.keys(phases).join(', ')}`);
  process.exit(2);
}

let harnessError;
try {
  await phases[args.phase]();
} catch (err) {
  harnessError = String(err?.stack ?? err);
  console.error(`\nharness error: ${harnessError}`);
}
console.log('\n==== PASTE BACK FROM HERE ====');
console.log(JSON.stringify({ phase: args.phase, tag: args.tag, at: new Date().toISOString(), lines: r.lines.filter((l) => !l.startsWith('\n')), harnessError }, null, 2));
console.log('==== PASTE BACK TO HERE ====');
process.exit(harnessError ? 2 : r.failures() ? 1 : 0);
