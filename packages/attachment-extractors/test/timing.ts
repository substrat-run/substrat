/**
 * How the extractor suites bound time without the wall clock (#2085). A machine starved by
 * other processes stretches elapsed time, so a bound on it decides a row by how busy the
 * machine is. Two measures do not move with load:
 *
 * - **CPU time** (`cpuMs`), for a claim about work the thread does: holding it without a turn,
 *   or settling at all. Starvation stretches the wall clock, not this thread's CPU.
 * - **Counts** (`afterAbort`), for what an extraction does once aborted: the units of work it
 *   still charges.
 *
 * Neither sees an extraction that sits IDLE before honouring an abort; the rows' hang guards
 * bound that. (Counting loop turns does not help: while real async work is in flight, an
 * inflate or its cancel, a turn counter spins for as long as that takes — a wall clock again.)
 */
import { expect } from 'vitest';
import { EXTRACTION_STRIDE, type ExtractionSignal } from '@substrat-run/kernel';
import { CALL_COST, Pace } from '../src/shared.js';

/** Milliseconds of CPU this thread has spent. */
export function cpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/**
 * The work an aborted extraction may still charge: the rest of the stride it was in, give or
 * take a step's fixed cost (`Pace`). An abort that lands at a yield other than a checkpoint (a
 * decoder's own await) is noticed at the next one, a stride on.
 */
const ABORTED_UNITS = EXTRACTION_STRIDE + CALL_COST;

/**
 * Start `extract`, abort it on a timer `afterMs` in, and count the units it charges to any
 * `Pace` after that. `firedAtCpu` is `cpuMs()` when the timer got its turn.
 */
export async function afterAbort(
  extract: (signal: ExtractionSignal) => Promise<unknown>,
  afterMs: number,
): Promise<{ answer: unknown; units: number; firedAtCpu: number }> {
  const charge = Pace.prototype.charge;
  let counting = false;
  let units = 0;
  Pace.prototype.charge = function (this: Pace, n: number) {
    if (counting) units += n;
    charge.call(this, n);
  };
  try {
    const signal = { aborted: false };
    const extracting = extract(signal);
    const firedAtCpu = await new Promise<number>((resolve) => setTimeout(() => resolve(cpuMs()), afterMs));
    signal.aborted = counting = true;
    return { answer: await extracting, units, firedAtCpu };
  } finally {
    Pace.prototype.charge = charge;
  }
}

/** It stopped within the stride it was in. */
export function expectStoppedPromptly(after: { units: number }, label?: string): void {
  expect(after.units, label ?? 'work done after the abort').toBeLessThanOrEqual(ABORTED_UNITS);
}

/** It answered that it was aborted, and stopped within the stride it was in. */
export function expectAbortedPromptly(after: { answer: unknown; units: number }, label?: string): void {
  expect(after.answer, label).toEqual({ failed: 'the extraction was aborted' });
  expectStoppedPromptly(after, label);
}
