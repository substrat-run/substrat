import { describe, expect, it } from 'vitest';
import { CONTRACT_CHECKS, registerContract, runContract } from '../src/index.js';
import { headOnlyHarness, LIARS, localHarness } from './fixtures.js';

registerContract('local source', localHarness(), { describe, it });
registerContract('local source without a tail', localHarness({ tail: false }), { describe, it });
registerContract('head-only fixture (the hosted shape)', headOnlyHarness(), { describe, it });

describe('the contract suite bites', () => {
  it('every liar names a check that exists', () => {
    const names = CONTRACT_CHECKS.map((c) => c.name);
    for (const liar of LIARS) expect(names).toContain(liar.fails);
  });

  for (const liar of LIARS) {
    it(`a source that ${liar.lie} fails exactly ${liar.fails}`, async () => {
      const failed = (await runContract(liar.harness)).filter((o) => !o.ok);
      expect(failed.map((o) => o.name)).toEqual([liar.fails]);
    });
  }

  it('an honest source fails nothing (the positive twin of every liar)', async () => {
    for (const harness of [localHarness(), localHarness({ tail: false }), headOnlyHarness()]) {
      expect((await runContract(harness)).filter((o) => !o.ok)).toEqual([]);
    }
  });
});
