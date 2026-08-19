import { describe, expect, it } from 'vitest';
import { fromWireFailure, substratError, toWireFailure } from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';
import { classifyError } from '../src/errors.js';

/**
 * The classifier's end of #113: a throw that declared what it is outranks every guess.
 *
 * The interesting case is the REHYDRATED one. An operation failure crossing the ScopeDO
 * boundary now arrives as a value and is rebuilt (`fromWireFailure`) — so it is not an
 * instance of the class that was thrown, and never can be, since contracts cannot import
 * the kernel. These tests pin that the classifier does not care: it reads the code.
 */
describe('classifyError reads the taxonomy first', () => {
  const acrossTheHop = (err: unknown): Error => fromWireFailure(toWireFailure(err));

  it('classifies a permission denial identically on both sides of the hop', () => {
    const thrown = new PermissionDenied('permission denied: customer:manage');
    const rebuilt = acrossTheHop(thrown);

    expect(classifyError(thrown)?.status).toBe(403);
    expect(classifyError(rebuilt)?.status).toBe(403);
    expect(rebuilt).not.toBeInstanceOf(PermissionDenied); // and it does not matter
  });

  it('classifies a conflict the message patterns would have missed', () => {
    // No 'invalid transition' or 'immutable' in this wording — before the taxonomy this
    // fell through to the caller's 400, which is the bug class the codes exist to end.
    const conflict = substratError('conflict', 'the period is closed for edits', {
      reason: 'period_closed',
    });
    expect(classifyError(conflict)?.status).toBe(409);
    expect(classifyError(acrossTheHop(conflict))?.status).toBe(409);
  });

  it('keeps a platform fault ahead of the taxonomy', () => {
    // #559: the RUNTIME failed, not the request. That reading must survive, because a
    // 502 tells the caller to retry where a 500 tells them to give up.
    const fault = Object.assign(new Error('internal error; reference = abc123'), {
      retryable: true,
    });
    const classified = classifyError(fault);
    expect(classified?.status).toBe(502);
    expect(classified?.platformFault).toBe(true);
  });

  it('still has no opinion about a foreign throw', () => {
    // "No opinion" is load-bearing: `mountOperations` rethrows so a vertical's own
    // `onError` still gets to map its own domain errors.
    expect(classifyError(new Error('something a vertical understands'))).toBeUndefined();
  });
});
