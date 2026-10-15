/**
 * Placement A: the run lives in the request that started it (`ctx.waitUntil`), a client
 * attaches over SSE, and a client that comes back later tails the record by polling.
 *
 * Nothing here holds the thread between requests, so everything that must outlive a
 * request (the lease, the events, the pending approval) is in the record. Recovery of a
 * run that died is triggered by a client arriving, because nothing else is awake.
 */
import { Record } from './record.mjs';
import { runTurn, currentTurn, Fenced, Died } from './loop.mjs';
import { sseFrame, digestOf, TERMINAL } from './protocol.mjs';

export { Record };

const STALE_MS = 3000;
const POLL_MS = 100;
const enc = new TextEncoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const recOf = (env, thread) => env.RECORD.get(env.RECORD.idFromName(thread));

function optsOf(url) {
  const q = url.searchParams;
  const num = (k, d) => (q.has(k) ? Number(q.get(k)) : d);
  return {
    flushMs: num('flushMs', 50),
    dieAfterStep: q.has('dieAfterStep') ? Number(q.get('dieAfterStep')) : undefined,
    dieAtEvent: q.has('dieAtEvent') ? Number(q.get('dieAtEvent')) : undefined,
    model: {
      ttftMs: num('ttftMs', 300),
      tokenMs: num('tokenMs', 15),
      toolMs: num('toolMs', 40),
      longTokens: num('longTokens', 0),
    },
  };
}

/** Start (or take over) a run. `first` are events to append before the loop starts. */
async function startRun({ env, ctx, thread, first, opts, attachWriter }) {
  const rec = recOf(env, thread);
  const runId = crypto.randomUUID();
  const lease = await rec.lease(runId, Date.now(), STALE_MS);
  if (!lease.ok) return { error: json({ error: 'busy', holder: lease.holder }, 409) };

  let writer = null;
  let readable = null;
  let clientGone = false;
  if (attachWriter) {
    const ts = new TransformStream();
    writer = ts.writable.getWriter();
    readable = ts.readable;
  }
  const deliver = (events) => {
    if (!writer || clientGone) return;
    for (const e of events) {
      writer.write(enc.encode(sseFrame(e))).catch(() => {
        clientGone = true;
      });
    }
  };

  const run = (async () => {
    let died = false;
    try {
      if (first?.length) {
        const res = await rec.append(runId, Date.now(), first);
        if (!res.ok) throw new Fenced('lease lost');
        deliver(res.events);
      }
      await runTurn({
        rec,
        runId,
        deliver,
        flushMs: opts.flushMs,
        model: opts.model,
        hooks: {
          afterStep: (n) => {
            if (opts.dieAfterStep === n) throw new Died();
          },
          beforeEmit: (n) => {
            if (opts.dieAtEvent === n) throw new Died();
          },
        },
      });
    } catch (err) {
      if (err instanceof Died) died = true;
      else if (!(err instanceof Fenced)) console.error('run failed', err);
    } finally {
      if (!died) await rec.release(runId).catch(() => {});
      writer?.close().catch(() => {});
    }
  })();
  ctx.waitUntil(run);
  return { readable, runId, tookOver: lease.tookOver };
}

const sse = (readable) =>
  new Response(readable, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
  });

/** Attach to a thread: replay from `after`, then tail the record until the turn rests. */
function tail({ env, ctx, thread, after, opts }) {
  const rec = recOf(env, thread);
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();
  ctx.waitUntil(
    (async () => {
      let cursor = after;
      try {
        for (;;) {
          const events = await rec.read(cursor);
          for (const e of events) {
            await writer.write(enc.encode(sseFrame(e)));
            cursor = e.id;
          }
          const st = await rec.state();
          const turn = currentTurn(events.length ? events : await rec.read(0));
          const last = turn[turn.length - 1];
          const resting = last && TERMINAL.has(last.t);
          if (resting && cursor >= st.lastId) break;
          // A turn that is not resting and whose holder has stopped beating is a dead run:
          // the only thing awake to notice is this client's request, so it takes over.
          if (!resting && st.runId !== null && Date.now() - st.beat > STALE_MS) {
            const taken = await startRun({ env, ctx, thread, first: null, opts, attachWriter: false });
            if (taken.error) await sleep(POLL_MS);
          } else if (!resting && st.runId === null && last) {
            // free lease, unfinished turn: also dead (a holder that released does so at rest)
            const taken = await startRun({ env, ctx, thread, first: null, opts, attachWriter: false });
            if (taken.error) await sleep(POLL_MS);
          } else {
            await sleep(POLL_MS);
          }
        }
      } catch {
        // the client went away; nothing to clean up, the record is the state
      } finally {
        writer.close().catch(() => {});
      }
    })(),
  );
  return sse(ts.readable);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/a\/([^/]+)\/([a-z_]+)$/);
    if (!m) return json({ error: 'not_found' }, 404);
    const [, thread, action] = m;
    const opts = optsOf(url);
    const rec = recOf(env, thread);

    if (action === 'state') return json(await rec.state());

    if (action === 'message' && req.method === 'POST') {
      const { text } = await req.json();
      const r = await startRun({
        env,
        ctx,
        thread,
        first: [{ t: 'user-message', text }, { t: 'turn-start' }],
        opts,
        attachWriter: true,
      });
      return r.error ?? sse(r.readable);
    }

    if (action === 'events') {
      const after = Number(req.headers.get('last-event-id') ?? url.searchParams.get('after') ?? 0);
      return tail({ env, ctx, thread, after, opts });
    }

    if (action === 'approve' && req.method === 'POST') {
      const { callId, digest, approved } = await req.json();
      const turn = currentTurn(await rec.read(0));
      const ask = turn.find((e) => e.t === 'approval-request' && e.callId === callId);
      if (!ask) return json({ error: 'no_such_request' }, 404);
      if (turn.some((e) => e.t === 'approval-resolved' && e.callId === callId)) {
        return json({ error: 'already_resolved' }, 409);
      }
      // The approval is bound to the input as it was proposed. A digest that does not
      // match the stored input is a refusal, not a retry: it means the client approved
      // something other than what the engine holds.
      if (digest !== ask.digest || digest !== (await digestOf(ask.input))) {
        return json({ error: 'digest_mismatch' }, 400);
      }
      const r = await startRun({
        env,
        ctx,
        thread,
        first: [{ t: 'approval-resolved', callId, approved: approved !== false }],
        opts,
        attachWriter: true,
      });
      return r.error ?? sse(r.readable);
    }

    if (action === '_fence') {
      // A zombie: a holder believed dead that is not. After a takeover it must not write.
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      const t0 = Date.now();
      const l1 = await rec.lease(a, t0, 10);
      await sleep(30);
      const l2 = await rec.lease(b, Date.now(), 10);
      const zombie = await rec.append(a, Date.now(), [{ t: 'zombie-write' }]);
      const owner = await rec.append(b, Date.now(), [{ t: 'owner-write' }]);
      await rec.release(b);
      return json({ l1, l2, zombie, owner: owner.ok });
    }
    return json({ error: 'not_found' }, 404);
  },
};
