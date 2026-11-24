// The questions both runs ask. Each takes the reporter, the waits, a client per script name, and a
// tag that makes every scope and instance id new, since a hosted run keeps its instances.
import { factsFor } from './harness.mjs';

/** Binding and door: a step reaches the scope, and through which door. */
export async function bindingAndDoor({ r, w, client, tag }) {
  r.heading('binding and door');
  const c = await client('acme');
  const scope = `s-${tag}`;
  const order = `${tag}-o1`;
  const { id, error } = await c.start(scope, order);
  if (error) throw new Error(`start refused: ${error}`);
  await w.parked(c, scope, order);
  r.see('status-at-wait', 'the status reported for an instance parked in waitForEvent', (await c.status(id)).status);
  const stepFacts = factsFor(await c.dump(scope), order);
  r.check(stepFacts.some((f) => f.kind === 'open-order' && f.actor === 'app' && f.via === 'workflow'), 'a step runs a scope operation, as the app, from the Workflow class', stepFacts);

  // Every harness call goes through the entry, the dump that reads the count included (the entry
  // bumps before it hands on). The steps made scope calls too; none of them passed the gate.
  const gateScope = `__gate`;
  const before = (await c.dump(gateScope)).counters?.['gate-passes'] ?? 0;
  const callsBefore = c.calls();
  await c.approve(scope, order);
  const done = await w.statusIs(c, id, 'complete', 'errored');
  const after = (await c.dump(gateScope)).counters?.['gate-passes'] ?? 0;
  const harnessCalls = c.calls() - callsBefore;
  r.see('door', 'gate passes vs harness calls while the remaining steps ran', { gatePasses: after - before, harnessCalls });
  r.check(after - before === harnessCalls, "no step's scope call passed the entry's gate: run() is not reached through fetch", { gatePasses: after - before, harnessCalls });
  r.check(done.status === 'complete', 'an approval committed in the scope rings the instance and it completes', done);
  const facts = await c.dump(scope);
  r.check(factsFor(facts, order).filter((f) => f.kind === 'close-order').length === 1, 'the flow closes the order once', factsFor(facts, order));
  r.check(facts.counters?.['rings-sent'] === 1, 'the scope rang the instance once, after its commit', facts.counters);
}

/** Waking: an early bell, a bell before the instance exists, a repeated bell, a gone instance. */
export async function waking({ r, w, client, tag }) {
  r.heading('waking');
  const c = await client('acme');
  const scope = `s-${tag}-wake`;

  // An event sent after the instance exists but before it reaches its wait (it is asleep).
  const early = await c.start(scope, `${tag}-early`, { nap: '3 seconds' });
  await w.parked(c, scope, `${tag}-early`, 0);
  await c.bell(early.id, 'early');
  await c.approve(scope, `${tag}-early`, false); // the fact, committed with no ring of its own
  const e = await w.statusIs(c, early.id, 'complete', 'errored');
  r.check(e.status === 'complete', 'a bell sent before the wait is buffered and wakes the wait', e);

  // An event committed before the instance exists: sendEvent has nowhere to go.
  await c.approve(scope, `${tag}-before`);
  const d = await c.dump(scope);
  r.see('bell-before-instance', 'scope counters after ringing an instance that does not exist yet', d.counters);
  const before = await c.start(scope, `${tag}-before`);
  await w.parked(c, scope, `${tag}-before`, w.timing.settleMs * 3);
  const stuck = await c.status(before.id);
  r.see('lost-bell', 'an instance created after its event was committed, once parked', { status: stuck.status, outboxHasIt: d.outbox.some((x) => x.ref === `${tag}-before`) });
  r.check(stuck.status === 'complete', 'an event committed before the instance exists still reaches it', stuck.status);
  // The rescue is one more bell: the flow reads the scope after every bell, so it finds the row.
  await c.bell(before.id, 'rescue');
  r.see('rescue', 'the same instance after one more bell', (await w.statusIs(c, before.id, 'complete', 'errored')).status);

  // A repeated delivery when the event carries the fact.
  const pay = await c.start(scope, `${tag}-payload`, { mode: 'payload' });
  await w.parked(c, scope, `${tag}-payload`);
  await c.bell(pay.id, 'first');
  await c.bell(pay.id, 'repeat');
  const p = await w.statusIs(c, pay.id, 'complete', 'errored');
  r.see('repeat-payload', 'a payload flow given the same delivery twice', p.output);
  r.check(p.output?.second === null, 'a repeated delivery is harmless when the event carries the fact', p.output);

  // A repeated delivery when the event is only a bell and the scope holds the fact.
  const bellFlow = await c.start(scope, `${tag}-dup`);
  await w.parked(c, scope, `${tag}-dup`);
  await c.bell(bellFlow.id, 'stray');
  await c.bell(bellFlow.id, 'stray-again');
  await c.approve(scope, `${tag}-dup`);
  await c.bell(bellFlow.id, 'late-repeat');
  const b = await w.statusIs(c, bellFlow.id, 'complete', 'errored');
  const closes = factsFor(await c.dump(scope), `${tag}-dup`).filter((f) => f.kind === 'close-order');
  r.check(b.status === 'complete' && closes.length === 1, 'repeated and stray bells are harmless when the scope holds the fact', { status: b.status, closes: closes.length, output: b.output });

  // Delivery to an instance that is gone or never was.
  r.see('bell-unknown', 'sendEvent to an instance id that was never created', await c.bell(`flow-${scope}-never`));
  r.see('bell-complete', 'sendEvent to a completed instance', await c.bell(bellFlow.id, 'after-complete'));
}

/** A step that dies after its scope operation committed. */
export async function retrySafety({ r, w, client, tag }) {
  r.heading('a retried step');
  const c = await client('acme');
  const scope = `s-${tag}-retry`;
  const order = `${tag}-retry`;
  const { id } = await c.start(scope, order, { failFirstAttempt: true });
  await w.parked(c, scope, order);
  const d = await c.dump(scope);
  const opens = factsFor(d, order).filter((f) => f.kind === 'open-order').length;
  r.see('retry', 'attempts of the open step, and the open facts it left', { attempts: d.counters?.[`attempt:${id}`], opens });
  r.check(opens === 1, "a retried step's operation runs once, under the key (instance, step)", d);
}

/** A preview: its own script, its own workflow, its own copy, and the network a step reaches. */
export async function previewCopy({ r, w, client, tag, outsideHits, fetchUrl }) {
  r.heading('a preview');
  const prod = await client('acme');
  const prev = await client('acme-v2');
  const scope = `s-${tag}-pv`;
  const order = `${tag}-pv`;
  const { id } = await prev.start(scope, order, { fetchUrl });
  await w.parked(prev, scope, order);
  const copy = await prev.dump(scope);
  const real = await prod.dump(scope);
  r.check(factsFor(copy, order).length > 0 && factsFor(real, order).length === 0, "an instance started on the preview's script writes to the preview's copy only", { copy: factsFor(copy, order), real: factsFor(real, order) });
  r.check(copy.effects.every((e) => e.state === 'held'), "a step's outbound effect requested through a scope operation is held on the copy", copy.effects);
  const fetched = { counters: Object.fromEntries(Object.entries(copy.counters ?? {}).filter(([k]) => k.startsWith('direct-fetch'))), outsideHits: outsideHits?.() };
  r.see('preview-direct-fetch', "what a step's own fetch reached, on the copy", fetched);
  r.check(!fetched.counters['direct-fetch:reached'], "a step's own fetch is held on the copy too", fetched);
  r.see('preview-instance-from-prod', "the preview's instance id, asked of the production script's workflow", await prod.status(id));
}
