import { describe, it } from 'vitest';
import { sweepTransitions } from './business-time-sweep.js';

describe('openings are one union across midnight', () => {
  it('America/Havana: every transition 2025–2035 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('America/Havana', 2025, 2035, 20);
  }, 600_000);

  it('Asia/Beirut: every transition 2025–2035 — oracle, monotonic, round trip, path independence', async () => {
    await sweepTransitions('Asia/Beirut', 2025, 2035, 20);
  }, 600_000);
});
