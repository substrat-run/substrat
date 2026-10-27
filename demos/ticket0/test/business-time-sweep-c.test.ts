import { describe, it } from 'vitest';
import { sweepTransitions } from './business-time-sweep.js';

describe('openings are one union across midnight', () => {
  it('Australia/Lord_Howe: every transition 2025–2035 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('Australia/Lord_Howe', 2025, 2035, 20);
  }, 600_000);

  it('Pacific/Chatham: every transition 2025–2035 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('Pacific/Chatham', 2025, 2035, 20);
  }, 600_000);

  // Kwajalein skipped 1993-08-21.
  it('Pacific/Kwajalein: every transition 1993–1993 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('Pacific/Kwajalein', 1993, 1993, 1);
  }, 600_000);
});
