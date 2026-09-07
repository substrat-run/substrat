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

/** `entitlementKey: 'x'` as an engine's manifest states it — one per engine. */
function declaredEntitlementKeys(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const name of readdirSync(enginesDir)) {
    const index = `${enginesDir}${name}/src/index.ts`;
    if (!existsSync(index)) continue;
    const match = /entitlementKey:\s*'([^']+)'/.exec(readFileSync(index, 'utf8'));
    if (match) found[name] = match[1]!;
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
