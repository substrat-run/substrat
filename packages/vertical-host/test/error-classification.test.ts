import { describe, expect, it } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import {
  fromWireFailure,
  PROBLEM_TYPE_BLANK,
  problemTypeFor,
  substratError,
  toWireFailure,
} from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';
import { classifyError, problemFor } from '../src/errors.js';

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

/**
 * The body half — #113 phase 4. `classifyError` already decided the status; these pin
 * what the caller actually receives, which until now was `{ error: <message> }` and
 * nothing a client could branch on.
 */
describe('problemFor renders the body', () => {
  const acrossTheHop = (err: unknown): Error => fromWireFailure(toWireFailure(err));

  it('names the taxonomy entry when the status is what that code means', () => {
    const { status, body } = problemFor(new PermissionDenied('permission denied: customer:manage'));
    expect(status).toBe(403);
    expect(body.code).toBe('permission_denied');
    expect(body.type).toBe(problemTypeFor('permission_denied'));
    expect(body.detail).toBe('permission denied: customer:manage');
    // The deprecation window (§1): every SPA in the repo still reads `{ error }`.
    expect(body.error).toBe('permission denied: customer:manage');
  });

  it('carries the declared extensions, and carries them across the hop', () => {
    const conflict = substratError('conflict', 'work order is already exported', {
      reason: 'already_exported',
    });
    expect(problemFor(conflict).body.reason).toBe('already_exported');
    expect(problemFor(acrossTheHop(conflict)).body.reason).toBe('already_exported');
  });

  /**
   * The wrapper `mountOperations` puts on what it classifies. Reading the OUTER error
   * would answer `about:blank` for exactly the failures the taxonomy describes best —
   * this is why `problemFor` looks at the cause.
   */
  it('reads through an HTTPException to the typed error underneath', () => {
    const denied = new PermissionDenied('permission denied: order:close');
    const wrapped = new HTTPException(403, { message: denied.message, cause: denied });
    const { status, body } = problemFor(wrapped);
    expect(status).toBe(403);
    expect(body.code).toBe('permission_denied');
  });

  it('answers about:blank for a throw nobody typed, at the status blame already chose', () => {
    // #559: an unrecognised throw is the caller's 400, and inventing a code for it
    // would put our vocabulary on a failure we cannot describe.
    const { status, body } = problemFor(new Error('the club is closed on 2026-08-25'));
    expect(status).toBe(400);
    expect(body.type).toBe(PROBLEM_TYPE_BLANK);
    expect(body.code).toBeUndefined();
    expect(body.detail).toBe('the club is closed on 2026-08-25');
  });

  it('answers about:blank for a platform fault, which the taxonomy has no 502 for', () => {
    const fault = Object.assign(new Error('durable object reset'), { retryable: true });
    const { status, body, platformFault } = problemFor(fault);
    expect(status).toBe(502);
    expect(platformFault).toBe(true);
    expect(body.type).toBe(PROBLEM_TYPE_BLANK);
    expect(body.code).toBeUndefined();
  });

  /**
   * The disagreement case, stated: a route that threw `HTTPException(404)` over an
   * error the taxonomy calls a 409 has already had its status win. Claiming `conflict`
   * beside a `404` would describe the failure as something the response line denies.
   */
  it('drops the code when the classified status is not what the code means', () => {
    const conflict = substratError('conflict', 'already exported', { reason: 'x' });
    const body = problemFor(new HTTPException(404, { message: 'gone', cause: conflict })).body;
    expect(body.status).toBe(404);
    expect(body.code).toBeUndefined();
    expect(body.type).toBe(PROBLEM_TYPE_BLANK);
  });

  it('keeps `internal` generic — the one message nobody reviewed', () => {
    const { status, body } = problemFor(substratError('internal', 'ledger integrity violated'));
    expect(status).toBe(500);
    expect(body.code).toBe('internal');
    expect(body.detail).toBeUndefined();
    expect(body.error).toBeUndefined();
  });

  it('records the request it refers to', () => {
    expect(problemFor(new Error('nope'), '/api/op/rally/book').body.instance).toBe(
      '/api/op/rally/book',
    );
  });
});
