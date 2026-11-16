import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REVIEW_ITEMS } from '../src/review-rules.generated.js';
import { loadSeeds, parseSeed, priceOf, resolveExpectations, scoreSeed, summarise, type Seed, type SeedRun } from './corpus.mts';
import { materialize, SEEDS_DIR, seedDiff } from './materialize.mts';

const base = { commit: 'd08db0d1a752dc0b3a0f68f7ab4ef57b9b2e9258', root: 'demos/todo', files: ['a.ts'] };
const seedOf = (expect: Seed['expect'], kind: Seed['kind'] = 'bad'): Seed => ({ id: 'probe', kind, origin: '#1', base, expect });
const head = new Map([['a.ts', ['one', 'two', 'three', 'four', 'five', 'six', 'two'].join('\n')]]);

describe('resolveExpectations', () => {
  it('takes lines before, after, and through a later anchor', () => {
    const [r] = resolveExpectations(seedOf([{ item: 'S2', anyOf: [
      { file: 'a.ts', from: 'three', before: 1, after: 1 },
      { file: 'a.ts', from: 'four', through: 'six' },
    ] }]), head);
    assert.deepEqual(r!.ranges, [{ file: 'a.ts', from: 2, to: 4 }, { file: 'a.ts', from: 4, to: 6 }]);
  });

  it('refuses an anchor that is missing or not unique', () => {
    assert.throws(() => resolveExpectations(seedOf([{ item: 'S2', file: 'a.ts', from: 'seven' }]), head), /must occur once/);
    assert.throws(() => resolveExpectations(seedOf([{ item: 'S2', file: 'a.ts', from: 'two' }]), head), /must occur once/);
  });
});

describe('scoreSeed', () => {
  const resolved = [{ item: 'S2', ranges: [{ file: 'a.ts', from: 3, to: 5 }] }, { item: 'outside', ranges: [{ file: 'a.ts', from: 1, to: 1 }] }];

  it('hits an expectation by item and range; a second finding on it is not false; anything else is', () => {
    const score = scoreSeed(resolved, [
      { item: 'S2', file: 'a.ts', line: 4 },
      { item: 'S2', file: 'a.ts', line: 5 },
      { item: 'S7', file: 'a.ts', line: 4 }, // right place, wrong item
      { item: 'S2', file: 'a.ts', line: 6 }, // right item, outside the range
      { item: 'S2', file: 'b.ts', line: 4 }, // another file
    ]);
    assert.deepEqual(score.expected, [{ item: 'S2', hit: true }, { item: 'outside', hit: false }]);
    assert.deepEqual(score.falseFindings.map((f) => `${f.item}:${f.file}:${f.line}`), ['S7:a.ts:4', 'S2:a.ts:6', 'S2:b.ts:4']);
  });

  it('counts every finding on a seed that owes none as false', () => {
    assert.equal(scoreSeed([], [{ item: 'S1', file: 'a.ts', line: 1 }]).falseFindings.length, 1);
  });
});

describe('parseSeed', () => {
  it('refuses a bad seed that owes nothing, and a clean one that owes something', () => {
    assert.throws(() => parseSeed(seedOf([]), 'x'), /owes at least one/);
    assert.throws(() => parseSeed(seedOf([{ item: 'S1', file: 'a.ts', from: 'one' }], 'clean'), 'x'), /owes no finding/);
  });
});

describe('summarise', () => {
  const run = (over: Partial<SeedRun>): SeedRun => ({
    model: 'm', seed: 's', kind: 'bad', state: 'completed', reason: null, score: { expected: [], falseFindings: [] },
    dropped: 0, inputTokens: 10, outputTokens: 2, costUsd: '0.5', latencyMs: 1000, ...over,
  });

  it('adds recall per item, flags clean reads with findings, and sums tokens, cost and failures', () => {
    const [s] = summarise([
      run({ score: { expected: [{ item: 'S2', hit: true }, { item: 'S7', hit: false }], falseFindings: [] } }),
      run({ score: { expected: [{ item: 'S2', hit: false }], falseFindings: [{ item: 'S5', file: 'a.ts', line: 1 }] }, dropped: 2 }),
      run({ kind: 'clean', score: { expected: [], falseFindings: [{ item: 'S1', file: 'a.ts', line: 1 }] }, latencyMs: 3000 }),
      run({ kind: 'outside', state: 'incomplete', reason: 'output cap' }),
    ]);
    assert.deepEqual(s!.recall, { S2: { hit: 1, of: 2 }, S7: { hit: 0, of: 1 } });
    assert.deepEqual([s!.hits, s!.owed, s!.falseFindings, s!.dropped, s!.incomplete], [1, 3, 2, 2, 1]);
    assert.deepEqual(s!.cleanFlagged, { flagged: 1, of: 2 });
    assert.deepEqual(s!.incompleteBy, { 'output cap': 1 });
    assert.deepEqual(s!.falseByItem, { S5: 1, S1: 1 });
    assert.deepEqual([s!.inputTokens, s!.costUsd, s!.latencyMs], [40, 2, { median: 1000, max: 3000 }]);
  });

  it('reports no cost when any read was unpriced', () => {
    assert.equal(summarise([run({}), run({ costUsd: null })])[0]!.costUsd, null);
  });
});

describe('priceOf', () => {
  it('prices a Workers AI id from its own row and a partner-served id from its vendor\'s row', () => {
    assert.equal(priceOf('cloudflare:@cf/deepseek-ai/deepseek-v4.1-flash-1017', 1_000_000, 1_000_000), '1.5');
    assert.equal(priceOf('cloudflare:anthropic/claude-sonnet-5.5', 1_000_000, 0), priceOf('anthropic:claude-sonnet-5.5', 1_000_000, 0));
    assert.equal(priceOf('cloudflare:@cf/nobody/unknown', 1, 1), null);
  });
});

describe('the checked-in corpus', () => {
  it('materialises every seed into a readable diff whose expectations land on lines the assembler accepts, and covers every item', async () => {
    const seeds = loadSeeds(SEEDS_DIR);
    for (const seed of seeds) {
      const tree = materialize(seed);
      const diff = await seedDiff(tree);
      assert.equal(diff.kind, 'diff', seed.id);
      if (diff.kind !== 'diff') continue;
      assert.ok(diff.files.length > 0, `${seed.id}: nothing is sent`);
      for (const e of resolveExpectations(seed, tree.head)) {
        const accepted = e.ranges.some((r) => {
          const file = diff.files.find((f) => f.path === r.file);
          if (!file) return false;
          if (file.changed === undefined || file.changed === 'all') return true;
          const changed = file.changed;
          return Array.from({ length: r.to - r.from + 1 }, (_, i) => r.from + i).some((line) => changed.has(line));
        });
        assert.ok(accepted, `${seed.id}: ${e.item} points at no line the change adds or alters`);
      }
    }
    const judgement = REVIEW_ITEMS.filter((item) => item.judgement).map((item) => item.id);
    const owed = new Set(seeds.flatMap((s) => s.expect.map((e) => e.item)));
    assert.deepEqual(judgement.filter((id) => !owed.has(id)), [], 'every judgement item has a bad seed');
    assert.deepEqual([...owed].filter((id) => id !== 'outside' && !judgement.includes(id)), [], 'every owed item is a judgement item');
    assert.ok(seeds.some((s) => s.kind === 'clean') && seeds.some((s) => s.kind === 'outside'));
  });
});
