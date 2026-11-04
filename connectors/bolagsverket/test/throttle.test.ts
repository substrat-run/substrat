import { expect, it } from 'vitest';
import { RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS, SlidingWindow } from '../src/throttle.js';

it('lets concurrent waiters take only the slots that free up', async () => {
  // A real clock: sleepers wake at their deadline, not one after another.
  let t = 0;
  let wakers: { at: number; wake: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((wake) => wakers.push({ at: t + ms, wake }));
  const window = new SlidingWindow(() => t, sleep, []);

  // A full window, its oldest request at t = 0 and the rest a second later.
  await window.acquire();
  t = 1_000;
  for (let i = 1; i < RATE_LIMIT_REQUESTS; i += 1) await window.acquire();

  let admitted = 0;
  const waiting = [window.acquire(), window.acquire()].map((p) => p.then(() => (admitted += 1)));
  await Promise.resolve();
  expect(wakers).toHaveLength(2);

  // Both wake when the oldest leaves; one slot is free, so one goes and one waits again.
  t = RATE_LIMIT_WINDOW_MS;
  const due = wakers;
  wakers = [];
  for (const w of due) w.wake();
  await new Promise((r) => setTimeout(r, 0));
  expect(admitted).toBe(1);
  expect(wakers).toHaveLength(1);

  t = RATE_LIMIT_WINDOW_MS + 1_000;
  wakers[0]!.wake();
  await Promise.all(waiting);
  expect(admitted).toBe(2);
});
