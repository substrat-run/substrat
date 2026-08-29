/**
 * The model-usage vocabulary's invariants (#1054).
 *
 * These are the checks the drain leans on: the payload it parses comes from a VERTICAL,
 * so anything the schema merely documents is something a caller can ignore.
 */
import { describe, expect, it } from 'vitest';
import { marginFactor, modelAttribution, modelUsageLine } from '../src/model-usage.js';

const attribution = {
  tenant: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  scope: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  vertical: '@substrat-run/demo-ticket0',
  version: '0.1.0',
  operation: 'ticket0/answer',
};

const line = {
  attribution,
  model: 'anthropic:claude-opus-5',
  provider: 'anthropic',
  modelId: 'claude-opus-5',
  reported: true,
  inputTokens: 100,
  outputTokens: 10,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  listUsd: '0.75',
  at: '2026-08-29T10:00:00.000Z',
  elapsedMs: 5,
};

describe('marginFactor', () => {
  it('turns a whole-percent margin into the exact decimal factor', () => {
    expect(marginFactor(0)).toBe('1');
    expect(marginFactor(7)).toBe('1.07');
    expect(marginFactor(20)).toBe('1.2');
    expect(marginFactor(100)).toBe('2');
    expect(marginFactor(125)).toBe('2.25');
  });

  it('refuses fractions and negatives — nobody prices at 12.5%, and a discount is not a margin', () => {
    expect(() => marginFactor(12.5)).toThrow(RangeError);
    expect(() => marginFactor(-1)).toThrow(RangeError);
  });
});

describe('modelAttribution', () => {
  it('is exactly five keys — a sixth is refused rather than dropped on the wire', () => {
    expect(modelAttribution.safeParse(attribution).success).toBe(true);
    expect(modelAttribution.safeParse({ ...attribution, install: 'x' }).success).toBe(false);
    expect(modelAttribution.safeParse({ ...attribution, operation: undefined }).success).toBe(false);
  });
});

describe('modelUsageLine', () => {
  it('refuses tokens or a price on an UNREPORTED line — an estimate must never become a bill', () => {
    const unreported = { ...line, reported: false, inputTokens: 0, outputTokens: 0, listUsd: null };
    expect(modelUsageLine.safeParse(unreported).success).toBe(true);
    // Each of these is a well-formed object the ledger must still refuse.
    expect(modelUsageLine.safeParse({ ...unreported, inputTokens: 9_000_000 }).success).toBe(false);
    expect(modelUsageLine.safeParse({ ...unreported, outputTokens: 1 }).success).toBe(false);
    expect(modelUsageLine.safeParse({ ...unreported, cachedInputTokens: 1 }).success).toBe(false);
    expect(modelUsageLine.safeParse({ ...unreported, cacheWriteTokens: 1 }).success).toBe(false);
    expect(modelUsageLine.safeParse({ ...unreported, listUsd: '1.5' }).success).toBe(false);
  });

  it('takes a decimal price and refuses anything that is not one', () => {
    for (const ok of ['0', '0.75', '1234.567890', '-0.5']) {
      expect(modelUsageLine.safeParse({ ...line, listUsd: ok }).success, ok).toBe(true);
    }
    // `''` and `'free'` are the ones that mattered: a bare `z.string()` took both, and
    // `addDecimal` would then fold them into somebody's bill.
    for (const bad of ['', ' ', 'free', '1.2.3', '0.1234567', '1e3', 'NaN', '$1.00']) {
      expect(modelUsageLine.safeParse({ ...line, listUsd: bad }).success, bad).toBe(false);
    }
    expect(modelUsageLine.safeParse({ ...line, listUsd: null }).success).toBe(true);
    // A number is not a decimal string, however price-shaped it looks.
    expect(modelUsageLine.safeParse({ ...line, listUsd: 0.5 }).success).toBe(false);
  });

  it('still refuses negative counts and a malformed instant', () => {
    expect(modelUsageLine.safeParse({ ...line, inputTokens: -1 }).success).toBe(false);
    expect(modelUsageLine.safeParse({ ...line, at: 'yesterday' }).success).toBe(false);
  });
});
