import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { warmControlPlane } from './do-warmup.js';

/**
 * #2131: the `.rejects` guard in `tools/vitest/workerd-rejections.mjs`, on a real Durable Object.
 * A workerd RPC promise is callable, and vitest's `.rejects` calls a callable subject, so
 * `expect(stub.method()).rejects` asserted on a pipelined call on the result — and passed on a
 * call that resolves. These pin the hazard, the refusal and the thunk that replaces it.
 */
type Directory = { listScopes(filter: object): Promise<unknown[]>; importDump(tables: unknown): Promise<void> };
const directory = () => env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')) as unknown as Directory;

describe('expect(<RPC promise>).rejects (#2131)', () => {
  beforeAll(() => warmControlPlane(env.CONTROL_PLANE));

  it('an RPC promise is callable, and calling it rejects even when the call resolves', async () => {
    const call = directory().listScopes({});
    expect(typeof call).toBe('function');
    // …and the pipelined call is itself a callable RPC promise, so it is asserted through a thunk too.
    await expect(() => (call as unknown as () => Promise<unknown>)()).rejects.toThrow(/is not a function/);
    await expect(call).resolves.toEqual(expect.any(Array));
  });

  it('is refused, with the fix in the message', async () => {
    const call = directory().listScopes({});
    expect(() => expect(call).rejects).toThrow(/write expect\(\(\) => stub\.method\(…\)\)\.rejects instead/);
    await call;
  });

  it('twin: the thunk fails on a call that resolves', async () => {
    const outcome = await expect(() => directory().listScopes({}))
      .rejects.toThrow()
      .then(
        () => 'passed',
        (e: Error) => e.message,
      );
    expect(outcome).toMatch(/resolved .* instead of rejecting/);
  });

  it('twin: the thunk holds on a call that rejects', async () => {
    await expect(() => directory().importDump([{ name: 42 }])).rejects.toThrow(/not a plain SQL identifier/);
  });

  it('a native promise is untouched', async () => {
    await expect(Promise.reject(new Error('native'))).rejects.toThrow('native');
  });
});
