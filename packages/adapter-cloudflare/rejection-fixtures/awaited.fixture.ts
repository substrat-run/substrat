import { expect, it } from 'vitest';
import { BAD_DUMP, directory } from './stub.js';

// The twin: rejections every caller observes. workerd still reports the Durable Object's side
// as unhandled, then as handled; nothing here may fail.
it('an awaited RPC rejection, asserted through a thunk', async () => {
  await expect(() => directory().importDump(BAD_DUMP)).rejects.toThrow(/not a plain SQL identifier/);
});

it('an awaited RPC rejection, caught', async () => {
  const error = await directory()
    .importDump(BAD_DUMP)
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(error).toBeInstanceOf(Error);
});
