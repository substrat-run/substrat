import { describe, it } from 'vitest';
import { sweepTransitions } from './business-time-sweep.js';

describe('openings are one union across midnight', () => {
  it('America/New_York: every transition 2025–2035 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('America/New_York', 2025, 2035, 20);
  }, 600_000);

  it('Australia/Sydney: every transition 2025–2035 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('Australia/Sydney', 2025, 2035, 20);
  }, 600_000);

  // The Line Islands skipped 1994-12-31.
  it('Pacific/Kiritimati: every transition 1994–1995 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('Pacific/Kiritimati', 1994, 1995, 1);
  }, 600_000);
});
