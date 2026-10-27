import { describe, it } from 'vitest';
import { sweepTransitions } from './business-time-sweep.js';

describe('openings are one union across midnight', () => {
  it('America/Nuuk: every transition 2025–2035 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('America/Nuuk', 2025, 2035, 20);
  }, 600_000);

  it('Europe/Stockholm: every transition 2025–2035 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('Europe/Stockholm', 2025, 2035, 20);
  }, 600_000);

  // Samoa's DST and the whole-day dateline jump over 2011-12-30.
  it('Pacific/Apia: every transition 2010–2012 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('Pacific/Apia', 2010, 2012, 4);
  }, 600_000);
});
