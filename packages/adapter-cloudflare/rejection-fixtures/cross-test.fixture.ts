import { it } from 'vitest';
import { sleep } from './stub.js';

// A forgotten await whose rejection lands in the NEXT test, which fails for it — and then passes
// on retry. The file must still fail.
it('a: leaves a rejection due in 30 ms', () => {
  setTimeout(() => void Promise.reject(new Error('cross-test: raised after a returned')), 30);
});

it('b: is running when it lands', async () => {
  await sleep(100);
});
