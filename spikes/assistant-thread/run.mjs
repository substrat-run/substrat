/**
 * Runs both placements against local workerd (miniflare) and prints what it measured.
 *
 *   node run.mjs          # about a minute
 *   SLOW=1 node run.mjs   # adds the hibernation probe (waits 25 s)
 *
 * Assertions are claims about correctness (a resumed stream is complete, an altered
 * approval is refused, a zombie is fenced). Numbers are printed, not asserted: they are
 * local, with a fake model, so they say how much the PLATFORM adds and how the two
 * placements compare, not what a user will wait for. Results also go to results.json.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { sseClient, wsClient, percentile, render } from './src/client.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const TTFT = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : 'n/a');

const results = { assertions: [], metrics: {}, notes: [] };
let failed = 0;
function check(name, cond, detail = '') {
  results.assertions.push({ name, ok: !!cond, detail });
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  (${detail})` : ''}`);
}
function note(text) {
  results.notes.push(text);
  console.log(`NOTE  ${text}`);
}
function metric(key, value) {
  results.metrics[key] = value;
  console.log(`      ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
}

const worker = (name, script, durableObjects) => ({
  name,
  modules: true,
  scriptPath: join(root, 'src', script),
  compatibilityDate: '2026-06-01',
  durableObjects,
});
const mf = new Miniflare({
  workers: [
    worker('a', 'worker-a.mjs', { RECORD: { className: 'Record', useSQLite: true } }),
    worker('b', 'worker-b.mjs', {
      RECORD: { className: 'Record', useSQLite: true },
      THREAD: { className: 'ThreadDO', useSQLite: true },
    }),
  ],
});
const A = await mf.getWorker('a');
const B = await mf.getWorker('b');

let n = 0;
const uniq = () => `t${Date.now().toString(36)}${n++}`;
// A run of `text-delta` events collapses to one: the 50 ms coalescing in the loop decides how
// many deltas a step writes, and that depends on timing (8 in one run, 9 in another), not on
// the loop. The rendered text is compared separately and exactly.
const typesOf = (events) =>
  events
    .map((e) => e.event?.t ?? e.t)
    .filter((t, i, ts) => !(t === 'text-delta' && ts[i - 1] === 'text-delta'));
const contiguous = (events) => events.every((e, i) => e.id === events[0].id + i);

// ---- placement drivers -------------------------------------------------------------
const aSend = (thread, text, qs = '') =>
  sseClient(A, `/a/${thread}/message${qs}`, { method: 'POST', body: { text } });
const aApprove = (thread, callId, digest, approved = true, qs = '') =>
  sseClient(A, `/a/${thread}/approve${qs}`, { method: 'POST', body: { callId, digest, approved } });
const aAttach = (thread, after, opts) =>
  sseClient(A, `/a/${thread}/events?after=${after}`, opts);
const aState = async (t) => (await A.fetch(`http://spike/a/${t}/state`)).json();
const bState = async (t) => (await B.fetch(`http://spike/b/${t}/state`)).json();

async function bOpen(thread, after = 0, opts) {
  const c = await wsClient(B, `/b/${thread}`, opts);
  c.send({ type: 'hello', after });
  await c.waitFor((e) => e.event.t === 'attached');
  return c;
}

// ---- S0: the happy path, and what each placement's stream looks like ----------------
console.log('\n# S0  happy path, both placements, identical event sequences');
let golden1;
let golden2;
let a0;
{
  const t = uniq();
  const r1 = aSend(t, 'log my set');
  await r1.done;
  const ev = r1.events.map((e) => e.event);
  const ask = ev.find((e) => e.t === 'approval-request');
  check('A: turn pauses at an approval request', !!ask && ev.at(-1).t === 'turn-finish' && ev.at(-1).reason === 'awaiting-approval');
  check('A: ids are contiguous from 1', ev[0].id === 1 && contiguous(ev));
  golden1 = render(ev);
  const r2 = aApprove(t, ask.callId, ask.digest);
  await r2.done;
  const ev2 = r2.events.map((e) => e.event);
  check('A: approval resumes and finishes', ev2.at(-1).t === 'turn-finish' && ev2.at(-1).reason === 'done');
  golden2 = render([...ev, ...ev2]);
  a0 = typesOf([...ev, ...ev2]);
  check('A: lease released at rest', (await aState(t)).runId === null);
}
{
  const t = uniq();
  const c = await bOpen(t);
  c.send({ type: 'send', text: 'log my set' });
  const fin = await c.waitFor((e) => e.event.t === 'turn-finish');
  const ev = c.events.map((e) => e.event).filter((e) => e.id);
  const ask = ev.find((e) => e.t === 'approval-request');
  check('B: turn pauses at an approval request', fin.event.reason === 'awaiting-approval' && !!ask);
  check('B: first-phase render equals A', render(ev) === golden1, `${render(ev)}`);
  c.send({ type: 'approve', callId: ask.callId, digest: ask.digest });
  await c.waitFor((e) => e.event.t === 'turn-finish' && e.event.reason === 'done');
  const all = c.events.map((e) => e.event).filter((e) => e.id);
  check('B: full render equals A', render(all) === golden2);
  check('B: event type sequence equals A, modulo delta coalescing (same loop, same record)',JSON.stringify(typesOf(all)) === JSON.stringify(a0));
  c.close();
}

// ---- S1: what the platform adds to a turn --------------------------------------------
console.log('\n# S1  latency the platform adds (model is a fixed 300 ms to first token)');
{
  const run = 8;
  const aFirst = [];
  const bFirst = [];
  const aGap = [];
  const bGap = [];
  // Gaps between frames of ONE text part: the 300 ms pause before the next part is the
  // model's, not the platform's.
  const gaps = (entries) => {
    const d = entries.filter((e) => e.event.t === 'text-delta' && e.event.pid === 'p1');
    return d.slice(1).map((x, i) => x.at - d[i].at);
  };
  for (let i = 0; i < run; i++) {
    const r = aSend(uniq(), 'hi');
    await r.done;
    aFirst.push(r.events.find((e) => e.event.t === 'text-delta').at - TTFT);
    aGap.push(...gaps(r.events));
  }
  const conn = [];
  for (let i = 0; i < run; i++) {
    const t0 = performance.now();
    const c = await bOpen(uniq());
    conn.push(performance.now() - t0);
    const sentAt = performance.now();
    c.send({ type: 'send', text: 'hi' });
    await c.waitFor((e) => e.event.t === 'turn-finish');
    const first = c.events.find((e) => e.event.t === 'text-delta');
    bFirst.push(first.at + c.t0 - sentAt - TTFT);
    bGap.push(...gaps(c.events));
    c.close();
  }
  // One round trip from the worker to the record, to explain the overhead above: the
  // loop writes before it delivers, and several writes happen before the first token.
  const rttState = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    await aState('rtt-probe');
    rttState.push(performance.now() - t0);
  }
  metric('one request into the worker + one record call, ms (p50/p95)', `${fmt(percentile(rttState, 50))} / ${fmt(percentile(rttState, 95))}`);
  metric('A overhead to first text token, ms (p50/p95)', `${fmt(percentile(aFirst, 50))} / ${fmt(percentile(aFirst, 95))}`);
  metric('B overhead to first text token, ms (p50/p95)', `${fmt(percentile(bFirst, 50))} / ${fmt(percentile(bFirst, 95))}`);
  metric('B cold connect + attach, ms (p50/p95)', `${fmt(percentile(conn, 50))} / ${fmt(percentile(conn, 95))}`);
  metric('A gap between text frames, ms (p50/p95)', `${fmt(percentile(aGap, 50))} / ${fmt(percentile(aGap, 95))}`);
  metric('B gap between text frames, ms (p50/p95)', `${fmt(percentile(bGap, 50))} / ${fmt(percentile(bGap, 95))}`);
}

// ---- S2: disconnect mid-turn, the run keeps going, the client resumes -----------------
console.log('\n# S2  disconnect mid-turn, then resume from the last id');
{
  // A
  const t = uniq();
  let deltas = 0;
  const r = sseClient(A, `/a/${t}/message`, {
    method: 'POST',
    body: { text: 'log my set' },
    onEvent: (e, res) => {
      if (e.event.t === 'text-delta' && ++deltas === 3) res.abort();
    },
  });
  await r.done;
  const lastSeen = r.events.at(-1).event.id;
  const cut = performance.now();
  let st;
  do {
    await sleep(50);
    st = await aState(t);
  } while (st.runId !== null && performance.now() - cut < 8000);
  metric('A: run kept going after disconnect, finished in ms', Math.round(performance.now() - cut));
  check('A: run completed with no client attached', st.runId === null && st.lastId > lastSeen);
  const resumed = aAttach(t, lastSeen);
  await resumed.done;
  const merged = [...r.events, ...resumed.events].map((e) => e.event);
  check('A: resumed stream continues exactly after the last id', resumed.events[0].event.id === lastSeen + 1);
  check('A: seen + resumed is contiguous, no gap, no duplicate', merged[0].id === 1 && contiguous(merged));
  check('A: resumed render equals the uninterrupted one', render(merged) === golden1);
}
{
  // B
  const t = uniq();
  const c = await bOpen(t);
  c.send({ type: 'send', text: 'log my set' });
  await c.waitFor((e) => e.event.t === 'text-delta');
  await c.waitFor((e) => e.event.t === 'text-delta' && c.events.filter((x) => x.event.t === 'text-delta').length >= 3);
  const lastSeen = c.lastId();
  c.close();
  const cut = performance.now();
  let st;
  do {
    await sleep(50);
    st = (await bState(t)).record;
  } while (st.runId !== null && performance.now() - cut < 8000);
  metric('B: run kept going after disconnect, finished in ms', Math.round(performance.now() - cut));
  check('B: run completed with no client attached', st.runId === null && st.lastId > lastSeen);
  const c2 = await bOpen(t, lastSeen);
  await sleep(100);
  const merged = [...c.events, ...c2.events].map((e) => e.event).filter((e) => e.id);
  check('B: resumed stream continues exactly after the last id', c2.events.find((e) => e.event.id)?.event.id === lastSeen + 1);
  check('B: seen + resumed is contiguous, no gap, no duplicate', merged[0].id === 1 && contiguous(merged));
  check('B: resumed render equals the uninterrupted one', render(merged) === golden1);
  c2.close();
}

// ---- S3: a second client tailing a live run ------------------------------------------
console.log('\n# S3  a second client attached while the run is live: how late do events reach it');
{
  const t = uniq();
  const primary = aSend(t, 'log my set');
  await sleep(60);
  const secondary = aAttach(t, 0);
  await Promise.all([primary.done, secondary.done]);
  const lag = primary.events
    .map((p) => {
      const s = secondary.events.find((x) => x.event.id === p.event.id);
      return s ? s.at + secondary.t0 - (p.at + primary.t0) : null;
    })
    .filter((x) => x !== null);
  metric('A tail lag behind the primary stream, ms (p50/p95/max)', `${fmt(percentile(lag, 50))} / ${fmt(percentile(lag, 95))} / ${fmt(Math.max(...lag))}`);
  check('A: tailing client received the whole turn', secondary.events.at(-1).event.t === 'turn-finish');
}
{
  const t = uniq();
  const secondary = await bOpen(t);
  const primary = await bOpen(t);
  primary.send({ type: 'send', text: 'log my set' });
  await Promise.all([
    primary.waitFor((e) => e.event.t === 'turn-finish'),
    secondary.waitFor((e) => e.event.t === 'turn-finish'),
  ]);
  const pe = primary.events.filter((e) => e.event.id);
  const lag = pe
    .map((p) => {
      const s = secondary.events.find((x) => x.event.id === p.event.id);
      return s ? s.at + secondary.t0 - (p.at + primary.t0) : null;
    })
    .filter((x) => x !== null);
  metric('B tail lag behind the primary socket, ms (p50/p95/max)', `${fmt(percentile(lag, 50))} / ${fmt(percentile(lag, 95))} / ${fmt(Math.max(...lag))}`);
  check('B: attached client received the whole turn', secondary.events.at(-1).event.t === 'turn-finish');
  primary.close();
  secondary.close();
}

// ---- S4: approvals --------------------------------------------------------------------
console.log('\n# S4  approvals across a gap, altered input, double approval, denial');
{
  const t = uniq();
  const r1 = aSend(t, 'log my set');
  await r1.done;
  const ask = r1.events.map((e) => e.event).find((e) => e.t === 'approval-request');
  await sleep(1500);
  const bad = aApprove(t, ask.callId, 'f'.repeat(64));
  await bad.done;
  check('A: an approval for a different input is refused', bad.status === 400 && bad.body?.error === 'digest_mismatch');
  const ok = aApprove(t, ask.callId, ask.digest);
  await ok.done;
  check('A: the right digest, 1.5 s later, is accepted', ok.status === 200 && ok.events.at(-1).event.reason === 'done');
  const again = aApprove(t, ask.callId, ask.digest);
  await again.done;
  check('A: approving twice is refused', again.status === 409);
  const t2 = uniq();
  const q = aSend(t2, 'log my set');
  await q.done;
  const ask2 = q.events.map((e) => e.event).find((e) => e.t === 'approval-request');
  const no = aApprove(t2, ask2.callId, ask2.digest, false);
  await no.done;
  const ev = no.events.map((e) => e.event);
  check('A: a denial skips the tool and says so', !ev.some((e) => e.t === 'tool-output' && e.tool === 'logSet') && ev.at(-1).reason === 'done');
}
{
  const t = uniq();
  let c = await bOpen(t);
  c.send({ type: 'send', text: 'log my set' });
  await c.waitFor((e) => e.event.t === 'turn-finish');
  const ask = c.events.map((e) => e.event).find((e) => e.t === 'approval-request');
  const lastSeen = c.lastId();
  c.close();
  await sleep(1500);
  c = await bOpen(t, lastSeen);
  c.send({ type: 'approve', callId: ask.callId, digest: 'f'.repeat(64) });
  const refused = await c.waitFor((e) => e.event.t === 'error');
  check('B: an approval for a different input is refused', refused.event.error === 'digest_mismatch');
  c.send({ type: 'approve', callId: ask.callId, digest: ask.digest });
  await c.waitFor((e) => e.event.t === 'turn-finish');
  check('B: the right digest, from a new socket 1.5 s later, is accepted', c.events.some((e) => e.event.t === 'tool-output' && e.event.tool === 'logSet'));
  c.send({ type: 'approve', callId: ask.callId, digest: ask.digest });
  const dup = await c.waitFor((e) => e.event.t === 'error' && e.event.error === 'already_resolved');
  check('B: approving twice is refused', !!dup);
  c.close();
}

// ---- S5: the holder dies mid-run ------------------------------------------------------
console.log('\n# S5  the holder disappears mid-run (and, for A, nobody comes back)');
{
  // A: died in the middle of a step.
  const t = uniq();
  const r = aSend(t, 'log my set', '?dieAtEvent=6');
  await r.done;
  const lastSeen = r.events.at(-1).event.id;
  check('A: the stream ended without a terminal event', !['turn-finish', 'turn-error'].includes(r.events.at(-1).event.t));
  await sleep(4500);
  const idle = await aState(t);
  check('A: with nobody attached, a dead run stays dead', idle.lastId === lastSeen);
  const t0 = performance.now();
  const back = aAttach(t, lastSeen);
  await back.done;
  const firstAfter = back.events[0].at;
  metric('A: a client returning after the lease went stale resumes the run in ms', Math.round(firstAfter));
  const merged = [...r.events, ...back.events].map((e) => e.event);
  check('A: recovery announces the restarted step', merged.filter((e) => e.t === 'step-restart').length === 1);
  check('A: recovered render equals the uninterrupted one', render(merged) === golden1);
  check('A: ids contiguous across the death', contiguous(merged));
  void t0;
}
{
  // A: died on a clean step boundary.
  const t = uniq();
  const r = aSend(t, 'log my set', '?dieAfterStep=1');
  await r.done;
  const lastSeen = r.events.at(-1).event.id;
  const diedAt = performance.now();
  const back = aAttach(t, lastSeen); // straight away: the lease is still fresh
  await back.done;
  metric('A: a client that returns at once waits this long for the dead run to be taken over, ms (staleness 3000)', Math.round(back.events[0].at));
  void diedAt;
  const merged = [...r.events, ...back.events].map((e) => e.event);
  check('A: death on a step boundary needs no restart marker', !merged.some((e) => e.t === 'step-restart'));
  check('A: and still renders the same', render(merged) === golden1);
}
{
  // B: the object is reset mid-step (ctx.abort), with a client attached.
  const t = uniq();
  const c = await bOpen(t);
  const boots0 = (await bState(t)).boots;
  c.send({ type: 'send', text: 'log my set', opts: { abortAtEvent: 6 } });
  await c.waitFor((e) => e.event.t === 'text-delta');
  const closedAt = await new Promise((resolve) => {
    const start = performance.now();
    const poll = setInterval(() => {
      if (c.closed) {
        clearInterval(poll);
        resolve(performance.now() - start);
      }
    }, 10);
    setTimeout(() => {
      clearInterval(poll);
      resolve(null);
    }, 5000);
  });
  note(`B: after ctx.abort the attached socket ${closedAt === null ? 'stayed open' : `closed after ${Math.round(closedAt)} ms`}`);
  // Nobody reconnects: does the object recover the run on its own?
  const start = performance.now();
  let st;
  do {
    await sleep(100);
    st = (await bState(t)).record;
  } while ((st.runId !== null || st.lastId === 0) && performance.now() - start < 8000);
  // the state call itself wakes the object; ask the record whether the turn finished
  const rec = (await bState(t)).record;
  const fin = await (async () => {
    const c2 = await bOpen(t, 0);
    await sleep(150);
    const evs = c2.events.map((e) => e.event).filter((e) => e.id);
    c2.close();
    return evs;
  })();
  const finished = fin.at(-1)?.t === 'turn-finish';
  metric('B: object recovered the run with no client, ms after the reset', Math.round(performance.now() - start));
  check('B: with nobody attached, the object recovered the run by itself (alarm)', finished);
  check('B: the object was constructed again after the reset', (await bState(t)).boots > boots0);
  check('B: recovered render equals the uninterrupted one', render(fin) === golden1);
  check('B: ids contiguous across the reset', contiguous(fin));
  void rec;
  c.close();
}

// ---- S6: a zombie holder is fenced ----------------------------------------------------
console.log('\n# S6  fencing');
{
  const r = await (await A.fetch(`http://spike/a/${uniq()}/_fence`)).json();
  check('a holder that lost the lease cannot write (zombie fenced)', r.zombie.ok === false && r.zombie.fenced === true && r.owner === true);
  check('the takeover was recognised as a takeover', r.l2.tookOver === true);
}

// ---- S7: concurrent sends -------------------------------------------------------------
console.log('\n# S7  two sends at once');
{
  const t = uniq();
  const [x, y] = [aSend(t, 'one'), aSend(t, 'two')];
  await Promise.all([x.done, y.done]);
  const statuses = [x.status, y.status].sort();
  check('A: exactly one send wins the lease (the other gets 409)', statuses[0] === 200 && statuses[1] === 409, statuses.join(','));
}
{
  const t = uniq();
  const c = await bOpen(t);
  c.send({ type: 'send', text: 'one' });
  c.send({ type: 'send', text: 'two' });
  await c.waitFor((e) => e.event.t === 'error' && e.event.error === 'busy');
  await c.waitFor((e) => e.event.t === 'turn-finish');
  const starts = c.events.filter((e) => e.event.t === 'turn-start').length;
  check('B: exactly one turn started; the other send was told it is busy', starts === 1, `starts=${starts}`);
  c.close();
}

// ---- S8: what a long turn writes ------------------------------------------------------
console.log('\n# S8  what a long answer (400 words) costs the record, by batching window');
{
  const rows = {};
  for (const flushMs of [0, 50, 250]) {
    const t = uniq();
    const r = aSend(t, 'long', `?longTokens=400&tokenMs=2&ttftMs=50&flushMs=${flushMs}`);
    await r.done;
    const st = await aState(t);
    const frames = r.events.length;
    rows[`flushMs=${flushMs}`] = { rows: st.rows, bytes: st.bytes, appendCalls: st.calls, clientFrames: frames };
  }
  metric('rows, bytes, record calls and client frames for one long answer', rows);
  check('batching reduces rows and calls', rows['flushMs=50'].rows < rows['flushMs=0'].rows && rows['flushMs=50'].appendCalls < rows['flushMs=0'].appendCalls);
}

// ---- S9: hibernation ------------------------------------------------------------------
if (process.env.SLOW) {
  console.log('\n# S9  does an idle socket-holding object hibernate, and does the socket survive');
  const t = uniq();
  const c = await bOpen(t);
  const before = (await bState(t)).boots;
  await sleep(25000);
  const mid = (await bState(t)).boots;
  c.send({ type: 'send', text: 'log my set' });
  const ok = await c.waitFor((e) => e.event.t === 'turn-finish', 10000).then(() => true, () => false);
  note(`B: boots ${before} -> ${mid} after 25 s idle with one socket attached; the old socket ${ok ? 'still worked' : 'did not work'} afterwards`);
  check('B: a socket idle for 25 s still carries a turn', ok);
  c.close();
} else {
  note('B: hibernation probe skipped (SLOW=1 to run it, 25 s)');
}

// ---- S10: a run longer than waitUntil allows ------------------------------------------
if (process.env.SLOW) {
  console.log('\n# S10  the client leaves at once; the run needs 20 s or 32 s of wall time to reach a resting point');
  // The model's time to first token applies to each of the two text parts before the
  // approval request, so ttftMs=10000 is about 20 s of run and 16000 about 32 s.
  const leaveAtOnce = (path) =>
    sseClient(A, path, { method: 'POST', body: { text: 'long' }, onEvent: (e, res) => res.abort() });
  const short = uniq();
  const long = uniq();
  const bt = uniq();
  const runs = [
    leaveAtOnce(`/a/${short}/message?ttftMs=10000`),
    leaveAtOnce(`/a/${long}/message?ttftMs=16000`),
  ];
  const cb = await bOpen(bt);
  cb.send({ type: 'send', text: 'long', opts: { model: { ttftMs: 16000 } } });
  await cb.waitFor((e) => e.event.t === 'turn-start');
  cb.close();
  await Promise.all(runs.map((x) => x.done));
  await sleep(40000);
  const rested = (st) => st.runId === null && st.lastId > 6;
  const sShort = await aState(short);
  const sLong = await aState(long);
  const sB = (await bState(bt)).record;
  check('A: a 20 s run completes after the client has left', rested(sShort));
  note(`A: a 32 s run after the client left ${rested(sLong) ? 'COMPLETED' : 'did NOT complete (lease ' + (sLong.runId ? 'held' : 'free') + ', ' + sLong.lastId + ' events)'}`);
  note(`B: the same 32 s run ${rested(sB) ? 'COMPLETED' : 'did NOT complete (lease ' + (sB.runId ? 'held' : 'free') + ', ' + sB.lastId + ' events)'}`);
  metric('S10 outcome', { A20s: rested(sShort), A32s: rested(sLong), B32s: rested(sB) });
}

writeFileSync(join(root, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.assertions.length - failed}/${results.assertions.length} assertions passed`);
await mf.dispose();
process.exit(failed ? 1 : 0);
