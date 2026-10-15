/**
 * A scripted model. It is deterministic so a run that was interrupted and resumed can be
 * compared with one that was not, and it has configurable delays so what the platform adds
 * can be told apart from what the model costs.
 *
 * It decides the next step from the HISTORY (the record's events for the thread), not from
 * anything held in memory. That is the property under test: a turn must be resumable from
 * the record alone, because an approval can arrive hours after the run that asked for it,
 * and an object can be evicted mid-run.
 */
import { digestOf } from './protocol.mjs';

export const DEFAULTS = { ttftMs: 300, tokenMs: 15, toolMs: 40, longTokens: 0 };

const SESSIONS = [
  { day: 'Mon', lift: 'squat', top: '100 kg x 5' },
  { day: 'Wed', lift: 'bench', top: '70 kg x 5' },
  { day: 'Fri', lift: 'deadlift', top: '120 kg x 3' },
  { day: 'Sun', lift: 'squat', top: '102.5 kg x 5' },
];

const LOG_INPUT = { exercise: 'squat', reps: 5, weightKg: 105 };

/** Which step comes next, from the events of the current turn only. */
export function stepOf(turn) {
  const has = (t, pred = () => true) => turn.some((e) => e.t === t && pred(e));
  if (has('text-end', (e) => e.pid === 'p3')) return 'done';
  if (!has('tool-output', (e) => e.tool === 'getSessions')) return 'lookup';
  if (!has('approval-request')) return 'propose';
  if (!has('approval-resolved')) return 'waiting';
  if (!has('tool-output', (e) => e.tool === 'logSet')) {
    return has('approval-resolved', (e) => e.approved) ? 'execute' : 'declined';
  }
  return 'conclude';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function* words(text, o) {
  await sleep(o.ttftMs);
  for (const w of text.split(' ')) {
    yield w + ' ';
    await sleep(o.tokenMs);
  }
}

function filler(n) {
  const base = 'Your squat has progressed steadily across the last four sessions and the volume is sensible. ';
  let out = '';
  while (out.split(' ').length < n) out += base;
  return out.split(' ').slice(0, n).join(' ');
}

/**
 * Run one step. `emit(event)` is called for every event; it may be slow (it persists).
 * Returns when the step is finished. Text parts are `text-start`, `text-delta`*, `text-end`.
 */
export async function runStep(step, turn, emit, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const text = async (pid, body) => {
    await emit({ t: 'text-start', pid });
    for await (const delta of words(body, o)) await emit({ t: 'text-delta', pid, delta });
    await emit({ t: 'text-end', pid });
  };
  switch (step) {
    case 'lookup': {
      await text('p1', o.longTokens ? filler(o.longTokens) : 'Let me look at your last four sessions.');
      const input = { limit: 4 };
      await emit({ t: 'tool-input', callId: 'c1', tool: 'getSessions', input });
      await sleep(o.toolMs);
      await emit({ t: 'tool-output', callId: 'c1', tool: 'getSessions', output: { sessions: SESSIONS } });
      return;
    }
    case 'propose': {
      await text('p2', 'Your top set was 102.5 kg for 5. I can log 105 kg for 5 as today’s set.');
      const digest = await digestOf(LOG_INPUT);
      await emit({ t: 'tool-input', callId: 'c2', tool: 'logSet', input: LOG_INPUT });
      await emit({
        t: 'approval-request',
        callId: 'c2',
        tool: 'logSet',
        input: LOG_INPUT,
        digest,
        preview: 'Log squat: 5 reps at 105 kg',
      });
      return;
    }
    case 'execute': {
      await sleep(o.toolMs);
      await emit({ t: 'tool-output', callId: 'c2', tool: 'logSet', output: { ok: true } });
      return;
    }
    case 'declined':
    case 'conclude': {
      await text('p3', step === 'conclude' ? 'Logged. Nice progress.' : 'Okay, I will not log it.');
      return;
    }
    default:
      throw new Error(`no step for ${step}`);
  }
}

export { LOG_INPUT };
