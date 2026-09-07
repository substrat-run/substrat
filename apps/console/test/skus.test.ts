import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_SKUS } from '../src/lib/skus';

/**
 * The grant dialog's SKU list is hand-maintained, because the platform publishes no
 * entitlement catalogue (#689). Hand-maintained means it goes stale silently: it named
 * five keys while `absence`, `booking`, `invites` and `metering` had already shipped as
 * engines, so an operator could not grant any of them from the console at all and
 * reached for a `curl` with a bearer token instead — which is what the issue was filed
 * about, after a mis-keyed entitlement sat dormant until a reconcile detonated it.
 *
 * So this reads the keys off disk rather than restating them: every engine that declares
 * an `entitlementKey` must be offerable. The next engine to ship turns this red in its
 * own PR, which is the cheapest stand-in for the catalogue endpoint until one exists.
 *
 * Engines only. A demo vertical also declares a key (`shop` does), but demos come and go
 * and the console is not obliged to offer every one of them — the direction that matters
 * is that no engine is missing.
 */

const enginesDir = fileURLToPath(new URL('../../../engines/', import.meta.url));

/**
 * The `entitlementKey` values one engine's manifest states, read out of its source.
 *
 * This is a text scan rather than a parse, so it FAILS CLOSED: a declaration it can see
 * but cannot read throws instead of being skipped. Skipping would be the worst outcome
 * available here — an engine spelling its key `"x"` rather than `'x'` would simply drop
 * out of the scan, the other six would still clear the minimum-count guard below, and
 * the suite would go green on exactly the staleness it exists to catch.
 */
export function entitlementKeysIn(where: string, source: string): string[] {
  // Every spelling of the value a manifest could plausibly use: '…', "…", `…`.
  const reads = [...source.matchAll(/entitlementKey:\s*(?:'([^']*)'|"([^"]*)"|`([^`$]*)`)/g)];
  // …counted against every declaration present, so a spelling not listed above — or a
  // computed one, which no text scan can resolve — is a throw, not a silent absence.
  const declarations = [...source.matchAll(/\bentitlementKey\s*:/g)].length;
  if (reads.length !== declarations) {
    throw new Error(
      `${where}: ${declarations} entitlementKey declaration(s), ${reads.length} readable — ` +
        'teach apps/console/test/skus.test.ts the spelling it uses',
    );
  }
  return reads.map((m) => m.slice(1).find((v) => v !== undefined)!);
}

/** Every engine's declared key, by engine directory name. */
function declaredEntitlementKeys(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of readdirSync(enginesDir)) {
    const index = `${enginesDir}${name}/src/index.ts`;
    if (!existsSync(index)) continue;
    const keys = entitlementKeysIn(`engines/${name}`, readFileSync(index, 'utf8'));
    if (keys[0]) found[name] = keys[0];
  }
  return found;
}

describe('KNOWN_SKUS', () => {
  it('offers every engine that declares an entitlement key', () => {
    const declared = declaredEntitlementKeys();
    // A silently empty scan would make this test pass forever; the engines exist.
    expect(Object.keys(declared).length).toBeGreaterThanOrEqual(7);

    const missing = Object.entries(declared)
      .filter(([, key]) => !KNOWN_SKUS.includes(key))
      .map(([engine, key]) => `${engine} → '${key}'`);
    expect(missing, 'add these to apps/console/src/lib/skus.ts').toEqual([]);
  });

  it('lists each key once, and keeps workorder as the dialog default', () => {
    expect(new Set(KNOWN_SKUS).size).toBe(KNOWN_SKUS.length);
    // KNOWN_SKUS[0] is what the grant dialog pre-selects, so the order is behaviour.
    expect(KNOWN_SKUS[0]).toBe('workorder');
  });
});

describe('entitlementKeysIn', () => {
  it('reads a key however the manifest quotes it', () => {
    expect(entitlementKeysIn('t', "entitlementKey: 'a',")).toEqual(['a']);
    expect(entitlementKeysIn('t', 'entitlementKey: "b",')).toEqual(['b']);
    expect(entitlementKeysIn('t', 'entitlementKey: `c`,')).toEqual(['c']);
    expect(entitlementKeysIn('t', 'entitlementKey:\n  "d",')).toEqual(['d']);
    expect(entitlementKeysIn('t', 'name: 1,')).toEqual([]);
  });

  it('throws on a declaration it cannot read rather than skipping it', () => {
    // The failure this guards: an unreadable key silently narrows the scan, and the
    // coverage test above then passes while an engine is genuinely un-grantable.
    expect(() => entitlementKeysIn('engines/x', 'entitlementKey: KEY,')).toThrow(/engines\/x/);
    expect(() => entitlementKeysIn('engines/x', 'entitlementKey: `p-${n}`,')).toThrow(/1 .*0 readable/);
  });
});
