import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { ask } from '../src/prompt.js';

/** A stand-in terminal: what the person types goes into `input`, the prompt comes out of `output`. */
function io(terminal: boolean) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return { input, output, terminal, onInterrupt: vi.fn() };
}

describe('ask — every way a prompt can end is an answer the caller sees', () => {
  it.each([true, false])('an answer, trimmed (terminal: %s)', async (terminal) => {
    const t = io(terminal);
    const answer = ask('slug? ', t);
    t.input.write('  acme \n');
    await expect(answer).resolves.toBe('acme');
  });

  it.each([true, false])('the end of input is `undefined`, never a promise left pending (terminal: %s)', async (terminal) => {
    // The bug this pins: readline closes on EOF without calling back, and a prompt that only
    // settled in the callback let Node exit 0 halfway through `substrat login`.
    const t = io(terminal);
    const answer = ask('slug? ', t);
    t.input.end();
    await expect(answer).resolves.toBeUndefined();
    expect(t.onInterrupt).not.toHaveBeenCalled();
  });

  it('Ctrl+C on a terminal stops the command — it is not read as "no answer"', async () => {
    const t = io(true);
    let settled: unknown = 'pending';
    void ask('pin it? [Y/n] ', t).then((v) => (settled = v));
    t.input.write('\x03');
    await new Promise((r) => setTimeout(r, 20));
    expect(t.onInterrupt).toHaveBeenCalledOnce();
    // Not resolved as `undefined`, which a caller would take as "no answer" and carry on.
    expect(settled).toBe('pending');
  });
});
