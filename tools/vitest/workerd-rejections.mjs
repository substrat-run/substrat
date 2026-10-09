/**
 * The setup file every workerd suite runs (#2131): a rejection nobody handles fails the test,
 * and a rejection a Durable Object RPC caller awaited does not.
 *
 * workerd tracks unhandled rejections per isolate, and the plugin's node-compat `process`
 * hands its reports to vitest. When a Durable Object method rejects, the promise it returned
 * has no JS handler until the RPC layer takes it over, so workerd reports it as
 * `unhandledRejection` — and then, when the RPC layer attaches its handler, reports the same
 * promise as `rejectionHandled`. That second event is the discriminator: it always arrives
 * before the caller's `await` resumes, because the caller is waiting on exactly that handler.
 * A rejection nobody handles — a forgotten `await` on a local promise, or an un-awaited RPC
 * call on the caller's side — never gets it.
 *
 * So the rule is node's own: a rejection still unhandled at the end of a test fails that test,
 * and one still unhandled when the file ends fails the file. Registering a listener here also
 * stops vitest's own from reporting each event as it comes (vitest steps aside when the process
 * has another `unhandledRejection` listener), which is what turned every awaited RPC rejection
 * into an unhandled error. The listeners are removed when the file ends, so a rejection that
 * lands later still reaches vitest's own listener.
 */
import { afterAll, afterEach, beforeAll, chai, expect } from 'vitest';

/*
 * A workerd RPC promise is CALLABLE — `stub.method()` returns a function-shaped thenable, so a
 * further call can be pipelined onto its result — and vitest's `.rejects` calls `expect()`'s
 * subject when it is a function. So `expect(stub.method()).rejects` asserts on
 * `stub.method()()`, a pipelined call on the result, and leaves the real promise unhandled:
 * `.rejects.toThrow()` passes on a call that RESOLVES, because calling a resolved value rejects
 * too. Refuse that subject, so the assertion is written as a thunk, which vitest calls once to
 * get the real promise.
 *
 * This rests on vitest 5's internals (`__VITEST_REJECTS__` / `__VITEST_RESOLVES__` in its
 * expect chunk): `.rejects` runs `typeof obj === 'function' ? obj() : obj`, while `.resolves`
 * awaits its subject without calling it — so `expect(rpc).resolves` is right as written, and
 * refuses a thunk. A vitest upgrade that changes either is a reason to revisit this guard.
 */
const GUARDED = Symbol.for('substrat.workerd-rejections.guarded');
if (!Object.hasOwn(chai.Assertion.prototype, GUARDED)) {
  Object.defineProperty(chai.Assertion.prototype, GUARDED, { value: true });
  chai.util.overwriteProperty(chai.Assertion.prototype, 'rejects', (original) =>
    function () {
      const subject = chai.util.flag(this, 'object');
      if (typeof subject === 'function' && typeof subject.then === 'function') {
        throw new TypeError(
          'expect(<RPC promise>).rejects asserts on a pipelined call on its result, not on the call: ' +
            'write expect(() => stub.method(…)).rejects instead (#2131).',
        );
      }
      return original.call(this);
    },
  );
}

/** Each unhandled promise → its reason, wrapped to name the test it was raised in. */
/** @type {Map<Promise<unknown>, Error>} */
const pending = new Map();
/** @param {unknown} reason @param {Promise<unknown>} promise */
const onUnhandled = (reason, promise) => {
  const test = expect.getState().currentTestName;
  const message = reason instanceof Error ? reason.message : String(reason);
  pending.set(promise, new Error(`a rejection nobody handled, raised ${test ? `in "${test}"` : 'outside a test'}: ${message}`, { cause: reason }));
};
/** @param {Promise<unknown>} promise */
const onHandled = (promise) => pending.delete(promise);

function failOnPending() {
  if (pending.size === 0) return;
  const errors = [...pending.values()];
  pending.clear();
  throw errors.length === 1 ? errors[0] : new AggregateError(errors, `${errors.length} rejections nobody handled`);
}

beforeAll(() => {
  process.on('unhandledRejection', onUnhandled);
  process.on('rejectionHandled', onHandled);
});
afterEach(failOnPending);
afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  process.off('rejectionHandled', onHandled);
  failOnPending();
});
