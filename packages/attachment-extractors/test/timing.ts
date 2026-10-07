/**
 * How the extractor suites bound time without the wall clock (#2085). A machine starved by
 * other processes stretches elapsed time, so a bound on it decides a row by how busy the
 * machine is. Two measures do not move with load:
 *
 * - **CPU time** (`cpuMs`), for a claim about work the thread does: holding it without a turn,
 *   or settling at all. Starvation stretches the wall clock, not this thread's CPU.
 * - **Counts** (`afterAbort`), for what an extraction does once aborted: the units of work it
 *   still charges. CPU time would also bill a parser for its teardown, and not see work it
 *   should not have done at all.
 *
 * What neither sees is an extraction that sits IDLE before honouring an abort. Counting loop
 * turns looks like it would, and does not: while genuinely async work is in flight (a
 * `DecompressionStream`'s inflate, its cancel) a turn counter spins for as long as that takes
 * in wall time, a clock in disguise (14 turns under load, 0 at rest). The rows' hang guards are
 * what bound an idle wait.
 */
import { expect, vi } from 'vitest';
import { EXTRACTION_STRIDE } from '@substrat-run/kernel';
import { CALL_COST, Pace } from '../src/shared.js';

/** Milliseconds of CPU this thread has spent. */
export function cpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/**
 * The work an aborted extraction may still charge: the rest of the stride it was in, "give or
 * take the few characters a search must see whole" (`Pace`) — a step's fixed cost of slack. An
 * abort that lands at a yield other than a checkpoint (a decoder's own await) is noticed at the
 * next one, a stride on: under load that is where it lands, 8 units past the stride.
 */
export const ABORTED_UNITS = EXTRACTION_STRIDE + CALL_COST;

/** An extraction aborted once `abortWhen` settles: its answer, and the units it charged to its `Pace` after the abort. */
export async function afterAbort(
  extract: (signal: { aborted: boolean }) => Promise<unknown>,
  abortWhen: () => Promise<void>,
): Promise<{ answer: unknown; units: number }> {
  const charge = vi.spyOn(Pace.prototype, 'charge');
  try {
    const signal = { aborted: false };
    const extracting = extract(signal);
    await abortWhen();
    signal.aborted = true;
    const from = charge.mock.calls.length;
    const answer = await extracting;
    return { answer, units: charge.mock.calls.slice(from).reduce((n, [units]) => n + units, 0) };
  } finally {
    charge.mockRestore();
  }
}

/** It stopped within the stride it was in. */
export function expectStoppedPromptly(after: { units: number }, label?: string): void {
  expect(after.units, label ?? 'work done after the abort').toBeLessThanOrEqual(ABORTED_UNITS);
}
