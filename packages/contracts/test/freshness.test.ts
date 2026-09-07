import { describe, expect, it } from 'vitest';
import { moduleManifest } from '../src/manifest.js';

/**
 * The freshness declaration's parse-time guard (#1232): an expectation naming a
 * type the module neither emits nor consumes would read as permanently stale
 * forever — a typo becoming a permanent red pill — so the manifest refuses it
 * where the error is readable (push/registration), never at render time.
 */
describe('moduleManifest.freshness — the emits ∪ consumes refinement', () => {
  const base = {
    id: '@test/bridge',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [],
    events: {
      emits: [{ type: 'receipt.landed', schemaVersion: 1 }],
      consumes: [{ type: 'invoice.requested', schemaVersion: 1 }],
    },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [],
    entitlementKey: 'bridge',
  };

  it('admits an expectation on an emitted type, and on a consumed one', () => {
    const m = moduleManifest.parse({
      ...base,
      freshness: [
        { eventType: 'receipt.landed', within: { hours: 24 } },
        { eventType: 'invoice.requested', within: { hours: 72 } },
      ],
    });
    expect(m.freshness).toHaveLength(2);
  });

  it('refuses a type the module neither emits nor consumes, naming the module and the type', () => {
    const r = moduleManifest.safeParse({
      ...base,
      freshness: [{ eventType: 'reciept.landed', within: { hours: 24 } }], // the typo case
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join('\n');
      expect(msg).toContain("'reciept.landed'");
      expect(msg).toContain('@test/bridge');
      expect(msg).toContain('permanently stale');
    }
  });

  it('a manifest with no freshness parses exactly as before — additive (D-28)', () => {
    expect(moduleManifest.parse(base).freshness).toBeUndefined();
  });
});
