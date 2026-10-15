/**
 * The turn loop, shared by both placements so that the only thing that differs between
 * them is who holds the run and how a client attaches. It reads the record, decides the
 * next step from it, runs the step, and writes what the step produced.
 *
 * Nothing the loop needs lives in memory across steps: kill it anywhere and the next
 * holder of the lease can continue from the record. A step that was cut off is restarted
 * from its beginning, announced by a `step-restart` event so a client drops the partial
 * text of that step instead of showing it twice.
 */
import { runStep, stepOf } from './model.mjs';

export class Fenced extends Error {}
export class Died extends Error {}

/** The events of the turn in progress: everything from the last `turn-start`. */
export function currentTurn(all) {
  let from = 0;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].t === 'turn-start') {
      from = i;
      break;
    }
  }
  return all.slice(from);
}

function openStep(turn) {
  let start = -1;
  let end = -1;
  turn.forEach((e, i) => {
    if (e.t === 'step-start') start = i;
    if (e.t === 'step-end') end = i;
  });
  return start > end ? turn[start].step : null;
}

/**
 * Persisting emitter. Events are buffered and written to the record in batches
 * (`flushMs`, or at once when 0). Structural events flush immediately so a client sees a
 * tool call or an approval request without waiting for the next tick.
 */
/** Merge neighbouring deltas of one text part into one event: fewer rows, fewer frames. */
function coalesce(batch) {
  const out = [];
  for (const e of batch) {
    const prev = out[out.length - 1];
    if (prev && e.t === 'text-delta' && prev.t === 'text-delta' && prev.pid === e.pid) {
      out[out.length - 1] = { ...prev, delta: prev.delta + e.delta };
    } else {
      out.push(e);
    }
  }
  return out;
}

export function makeEmitter({ rec, runId, flushMs, deliver }) {
  let buffer = [];
  let timer = null;
  let chain = Promise.resolve();
  let lastFlushAt = 0;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // With no batching window every token is its own row; with one, they are merged.
    const batch = flushMs === 0 ? buffer : coalesce(buffer);
    buffer = [];
    if (batch.length === 0) return chain;
    lastFlushAt = Date.now();
    chain = chain.then(async () => {
      const res = await rec.append(runId, Date.now(), batch);
      if (!res.ok) throw new Fenced('lease lost');
      deliver(res.events);
    });
    return chain;
  };
  const emit = (event) => {
    buffer.push(event);
    const structural = event.t !== 'text-delta';
    if (flushMs === 0 || structural) return flush();
    // Leading edge: the first delta after a quiet spell goes out at once, so the window
    // costs a user nothing on the first token; the rest of the burst is merged.
    const since = Date.now() - lastFlushAt;
    if (since >= flushMs) return flush();
    if (!timer) timer = setTimeout(() => void flush().catch(() => {}), flushMs - since);
    return chain;
  };
  return { emit, flush };
}

/**
 * Run the turn to its next resting point: an approval request, or the end.
 * `hooks.afterStep(n)` may throw `Died` to simulate the holder disappearing mid-turn.
 */
export async function runTurn({ rec, runId, deliver, flushMs = 50, model = {}, hooks = {} }) {
  const base = makeEmitter({ rec, runId, flushMs, deliver });
  const { flush } = base;
  let completed = 0;
  let emitted = 0;
  // `beforeEmit(n)` lets a test kill the holder in the middle of a step.
  const emit = (event) => {
    emitted += 1;
    hooks.beforeEmit?.(emitted, event);
    return base.emit(event);
  };
  try {
    for (;;) {
      const turn = currentTurn(await rec.read(0));
      const open = openStep(turn);
      if (open) await emit({ t: 'step-restart', step: open });
      const step = stepOf(turn);
      const last = turn[turn.length - 1];
      if (step === 'done') {
        if (!(last.t === 'turn-finish' && last.reason === 'done')) await emit({ t: 'turn-finish', reason: 'done' });
        break;
      }
      if (step === 'waiting') {
        if (last.t !== 'turn-finish') await emit({ t: 'turn-finish', reason: 'awaiting-approval' });
        break;
      }
      await emit({ t: 'step-start', step });
      await runStep(step, turn, emit, model);
      await emit({ t: 'step-end', step });
      completed += 1;
      await hooks.afterStep?.(completed);
    }
    await flush();
  } finally {
    // A fenced or killed holder must not release a lease it no longer has; `release` is
    // keyed by run id, so a stale call is a no-op. A holder that DIED (Died) never reaches
    // here in a real eviction, which is the case the lease's staleness window covers.
  }
}
