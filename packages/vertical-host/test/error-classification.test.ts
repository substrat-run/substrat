import v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { HTTPException } from 'hono/http-exception';
import {
  fromWireFailure,
  PROBLEM_TYPE_BLANK,
  problemTypeFor,
  substratError,
  toWireFailure,
  NO_APPLICATION_DETAIL,
  SCOPE_GATE_REASONS,
  type ErrorCode,
} from '@substrat-run/contracts';
import { PermissionDenied } from '@substrat-run/kernel';
import { Hono } from 'hono';
import { classifyError, problemFor, problemOf } from '../src/errors.js';

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
 * The sentence fallbacks, deprecated (#113). A throw that declared nothing still gets the
 * status its wording used to earn, for one more release — and says so in the vertical's
 * own logs (once per code and sentence prefix, at most a hundred times per isolate), so
 * the author learns before the status moves.
 *
 * The dedupe is per isolate and these tests share one, so each case throws a sentence of
 * its own (`fresh`), never one another case has already announced.
 */
describe('classifyError announces a status it read from a sentence', () => {
  let n = 0;
  const fresh = (sentence: string): string => `${sentence} #${++n}-${Math.random()}`;
  let warn: MockInstance<typeof console.warn>;
  const announcements = () => warn.mock.calls.filter(([tag]) => tag === 'vertical-host.untyped-refusal');
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it.each([
    ['permission denied: invoice:void', 403, 'permission_denied'],
    ['customer not found: c1', 404, 'not_found'],
    ['unknown scope for tenant: (t, s)', 404, 'not_found'],
    ["invalid transition: order is 'closed'", 409, 'conflict'],
    ['an exported underlag is immutable', 409, 'conflict'],
  ])('keeps %j at %i for now, and names the code that would keep it', (sentence, status, code) => {
    const message = fresh(sentence);
    expect(classifyError(new Error(message))).toEqual({ status, message });
    expect(announcements()).toEqual([
      [
        'vertical-host.untyped-refusal',
        {
          status,
          message,
          deprecated: `this status was read from the sentence, which a later release stops doing; throw substratError('${code}', …) to keep it`,
        },
      ],
    ]);
  });

  it('announces a sentence once, and a different one again', () => {
    const first = fresh('bike not found: b1');
    classifyError(new Error(first));
    classifyError(new Error(first));
    classifyError(new HTTPException(400, { message: first }));
    expect(announcements()).toHaveLength(1);

    classifyError(new Error(fresh('bike not found: b2')));
    expect(announcements()).toHaveLength(2);
  });

  it('remembers at most a hundred sentences, so a stream of distinct ones cannot grow it', async () => {
    // A fresh module, so the count starts at zero whatever the cases above announced.
    vi.resetModules();
    const fresh100 = await import('../src/errors.js');
    for (let i = 0; i < 100; i++) fresh100.classifyError(new Error(`cart not found: ${i}`));
    expect(announcements()).toHaveLength(100);
    // Past the cap a new sentence still gets its status; it is only no longer remembered.
    expect(fresh100.classifyError(new Error('cart not found: 100'))?.status).toBe(404);
    expect(announcements()).toHaveLength(100);
  });

  it('retains and logs a bounded prefix of a huge sentence, so its size cannot pin memory', async () => {
    // The isolate serves every tenant. A count cap alone let a hundred megabyte-long sentences
    // pin a hundred megabytes; the key and the log line are cut to 120 characters instead.
    vi.resetModules();
    const isolate = await import('../src/errors.js');
    const huge = (i: number) => `order not found: ${i} ${'x'.repeat(1_000_000)}`;
    for (let i = 0; i < 3; i++) expect(isolate.classifyError(new Error(huge(i)))?.status).toBe(404);

    const keys = isolate.announcedKeys();
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual('not_found:'.length + 120);

    const logged = announcements().map(([, line]) => (line as { message: string }).message);
    expect(logged).toEqual([0, 1, 2].map((i) => `${huge(i).slice(0, 120)}… (truncated)`));

    // The prefix is the identity: a different tail past the bound is the same sentence.
    isolate.classifyError(new Error(`${huge(0)}y`));
    expect(announcements()).toHaveLength(3);
  });

  it('retains the bound, not the sentence: a hundred megabyte sentences pin no megabytes', async () => {
    // A key's LENGTH proves nothing about what it keeps alive: V8 can answer `slice` with a
    // view onto the whole parent string. So this measures the heap once the sentences are
    // unreachable from everything but the dedupe set.
    v8.setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as () => void;
    vi.resetModules();
    const isolate = await import('../src/errors.js');
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 100; i++) {
      isolate.classifyError(new Error(`order not found: ${i} ${'x'.repeat(1_000_000)}${i}`));
    }
    gc();
    const retained = process.memoryUsage().heapUsed - before;
    expect(isolate.announcedKeys()).toHaveLength(100);
    expect(retained).toBeLessThan(10_000_000); // ~100 MB when each key pins its sentence
  });

  it('logs a sentence at the bound whole, unmarked', async () => {
    vi.resetModules();
    const isolate = await import('../src/errors.js');
    const atTheBound = `order not found: ${'x'.repeat(120 - 'order not found: '.length)}`;
    expect(atTheBound).toHaveLength(120);
    isolate.classifyError(new Error(atTheBound));
    expect(announcements().map(([, line]) => (line as { message: string }).message)).toEqual([atTheBound]);
    expect(isolate.announcedKeys()).toEqual([`not_found:${atTheBound}`]);
  });

  it("keeps main's order around a parse failure that lost its name", () => {
    // An `issues[]` with no code is a parse failure (400) — but a denial's sentence was always
    // read before it, and the state sentences after it. Neither moves in this release.
    const parse = (message: string) => Object.assign(new Error(message), { issues: [] });
    expect(classifyError(parse(fresh('permission denied: x')))?.status).toBe(403);
    expect(announcements()).toHaveLength(1);
    expect(classifyError(parse(fresh('customer not found: c1')))?.status).toBe(400);
    expect(classifyError(parse(fresh('invalid transition: y')))?.status).toBe(400);
    expect(announcements()).toHaveLength(1);
  });

  it('is silent for a throw that declared its code, however it is worded', () => {
    // The same sentences, typed: the code decides before any wording is read, so nothing
    // is guessed and nothing is announced.
    expect(classifyError(substratError('not_found', fresh('customer not found: c1')))?.status).toBe(404);
    expect(classifyError(new PermissionDenied(fresh('permission denied: x')))?.status).toBe(403);
    expect(classifyError(substratError('conflict', fresh('invalid transition: y')))?.status).toBe(409);
    expect(announcements()).toEqual([]);
  });

  it('reads a permission denial that kept only its class name, without the sentence', () => {
    // The structured clone of a `PermissionDenied`: no prototype, no `code`, only the name
    // — and a sentence that matches no pattern. `errorCodeOf` reads the name, which is why
    // the classifier needs no `PermissionDenied` check of its own.
    const cloned = Object.assign(new Error(fresh('nope')), { name: 'PermissionDenied' });
    expect(classifyError(cloned)?.status).toBe(403);
    expect(announcements()).toEqual([]);
  });

  it('is silent, and has no opinion, for a sentence that matches nothing', () => {
    expect(classifyError(new Error(fresh('the club is closed on 2026-08-25')))).toBeUndefined();
    expect(announcements()).toEqual([]);
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

describe('classifyError on a ScopeDO refusing a projection for another tenant (#1738)', () => {
  const sentence =
    'applyProjection refused: this scope was provisioned for tenant 01AAA, and a projection for tenant 01BBB would re-point it';

  it('answers 409 rather than the caller\'s 400, read from the code', () => {
    expect(classifyError(substratError('conflict', sentence))?.status).toBe(409);
  });

  it('the flattened form keeps no opinion now that the pattern is gone (#113)', () => {
    expect(classifyError(new Error(`Substrat.conflict: ${sentence}`))).toBeUndefined();
  });
});

/**
 * #113: the directory refusals that reach a vertical door too. The scope gate's (a tenant or
 * scope not active, a scope with no tenant record) answer the router's neutral 404 at this public
 * edge; the introspection read answers its own code. Untyped, all of them were the caller's 400.
 */
describe('a vertical door on the gate and introspection refusals (#113)', () => {
  const gate: readonly Error[] = [
    substratError('conflict', 'tenant not active (status: suspended): 01T', { reason: SCOPE_GATE_REASONS.notActive }),
    substratError('conflict', 'scope not active (status: archived): 01S', { reason: SCOPE_GATE_REASONS.notActive }),
    substratError('not_found', 'scope has no tenant record: (01T, 01S)', { reason: SCOPE_GATE_REASONS.unrecorded }),
  ];

  it.each(gate.map((e) => [e.message, e] as const))('%s → the router\'s neutral 404', (_m, refusal) => {
    const { status, body } = problemFor(refusal);
    expect(status).toBe(404);
    expect(body.code).toBe('not_found');
    expect(body.detail).toBe(NO_APPLICATION_DETAIL);
    expect(body.reason).toBeUndefined();
    // The same through `mountOperations`' wrapper, whose cause is the refusal.
    const wrapped = new HTTPException(classifyError(refusal)!.status, { message: classifyError(refusal)!.message, cause: refusal });
    expect(problemFor(wrapped).body).toEqual(body);
  });

  it('a public surface that maps its own errors cannot widen the gate either', async () => {
    // A vertical's own `onError`, deciding a status first and rendering through `problemOf`.
    const app = new Hono();
    app.get('/thing', () => {
      throw gate[0];
    });
    app.get('/other', () => {
      throw new Error('seat taken');
    });
    app.onError((err, c) => {
      const { status, body } = problemOf({ status: 409, message: (err as Error).message }, err, c.req.path);
      return c.json(body, status);
    });
    const gated = await app.request('/thing');
    expect(gated.status).toBe(404);
    const body = (await gated.json()) as Record<string, unknown>;
    expect(body.code).toBe('not_found');
    expect(body.detail).toBe(NO_APPLICATION_DETAIL);
    // The twin: the vertical's own decision stands for an ordinary error.
    const ordinary = await app.request('/other');
    expect(ordinary.status).toBe(409);
    expect(((await ordinary.json()) as Record<string, unknown>).detail).toBe('seat taken');
  });

  it('the twin: a conflict that is not the gate keeps its own status and sentence', () => {
    const { status, body } = problemFor(substratError('conflict', 'tenant not active (status: suspended): 01T'));
    expect(status).toBe(409);
    expect(body.detail).toBe('tenant not active (status: suspended): 01T');
  });

  const cases: readonly [sentence: string, code: ErrorCode, status: number][] = [
    [`unknown table 'ghost'`, 'not_found', 404],
    ['read-only console: empty statement', 'validation_failed', 400],
  ];

  it.each(cases)('%s → %s %i', (sentence, code, status) => {
    const { status: answered, body } = problemFor(substratError(code, sentence));
    expect(answered).toBe(status);
    expect(body.code).toBe(code);
    expect(body.detail).toBe(sentence);
  });
});
