import { describe, expect, it } from 'vitest';
import type { DeclaredEventSurface } from '@substrat-run/contracts';
import { deriveFlowFindings } from '../src/flow-findings.js';

const decl = (type: string, direction: 'emits' | 'consumes', moduleId = 'crm'): DeclaredEventSurface =>
  ({ moduleId, type, direction }) as DeclaredEventSurface;

const base = {
  declaredEvents: [] as DeclaredEventSurface[],
  requires: [] as string[],
  knownProviders: ['scrive', 'fortnox'],
  observedTypes: [] as string[],
  observedComplete: true,
  connections: [] as { provider: string; status: string }[],
};

describe('deriveFlowFindings (#1234)', () => {
  it('names a declared emit that has never been seen', () => {
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('receipt.landed', 'emits'), decl('invoice.sent', 'emits')],
      observedTypes: ['invoice.sent'],
    });
    expect(v.findings.map((f) => f.subject)).toEqual(['receipt.landed']);
    expect(v.findings[0]!.kind).toBe('unemitted');
    expect(v.declaredTypes).toBe(2);
    expect(v.observedTypes).toBe(1);
  });

  it('distinguishes a handler with nothing to do from a dead emit', () => {
    // The star topology means these are declared by different modules that never
    // import each other, and they mean different things: an unemitted type may be
    // a code path that never runs; an unconsumed one is a handler that has never
    // been given anything.
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('a.thing', 'emits', 'mod-a'), decl('b.thing', 'consumes', 'mod-b')],
    });
    expect(v.findings.map((f) => f.kind).sort()).toEqual(['unconsumed', 'unemitted']);
    expect(v.findings.find((f) => f.kind === 'unconsumed')!.detail).toMatch(/never had anything to do/);
  });

  it('is silent when everything declared has been observed', () => {
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('a.thing', 'emits'), decl('a.thing', 'consumes', 'other')],
      observedTypes: ['a.thing'],
    });
    expect(v.available).toBe(true);
    expect(v.findings).toEqual([]);
    // One type, two declarations — the count is of TYPES, not declarations.
    expect(v.declaredTypes).toBe(1);
  });

  it('says UNAVAILABLE, not "declares nothing", for a version predating the surface', () => {
    // The load-bearing case: with no declarations there is nothing to compare, and
    // rendering the join anyway would report every older app as declaring nothing.
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: null,
      requires: ['scrive'],
      observedTypes: ['a.thing'],
    });
    expect(v.available).toBe(false);
    expect(v.findings).toEqual([]);
    expect(v.declaredTypes).toBe(0);
  });

  it('reports a declared provider nobody has connected', () => {
    const v = deriveFlowFindings({ ...base, requires: ['scrive'] });
    expect(v.findings.map((f) => f.kind)).toEqual(['unconnected-provider']);
    // Never "fails closed": a dispatch with no live connection settles pending and
    // retries, so the copy must not send someone hunting a fault that isn't there.
    expect(v.findings[0]!.detail).not.toMatch(/fails closed|until (it is |one is )?connected/i);
    expect(v.findings[0]!.detail).toMatch(/waits rather than failing/);
  });

  it('ignores a required capability that is not a connectable provider', () => {
    // `oidc-issuer` is bound by the platform at install, not from the Integrations
    // tab. Treating it as a provider would put a false finding on nearly every app.
    const v = deriveFlowFindings({ ...base, requires: ['oidc-issuer'] });
    expect(v.findings).toEqual([]);
  });

  it('separates a connection that was never made from one that lapsed', () => {
    const lapsed = deriveFlowFindings({
      ...base,
      requires: ['scrive'],
      connections: [{ provider: 'scrive', status: 'expired' }],
    });
    expect(lapsed.findings.map((f) => f.kind)).toEqual(['unhealthy-provider']);
    expect(lapsed.findings[0]!.detail).toMatch(/expired/);

    // One live connection is enough, even beside a revoked one — a tenant may hold
    // several for one provider (the bureau's Fortnox fleet), and any active one works.
    const healthy = deriveFlowFindings({
      ...base,
      requires: ['scrive'],
      connections: [
        { provider: 'scrive', status: 'revoked' },
        { provider: 'scrive', status: 'active' },
      ],
    });
    expect(healthy.findings).toEqual([]);
  });

  it('does not report the same provider twice when two modules require it', () => {
    const v = deriveFlowFindings({ ...base, requires: ['fortnox', 'fortnox'] });
    expect(v.findings.map((f) => f.subject)).toEqual(['fortnox']);
  });

  it('withholds event findings when the observation was cut short, but not provider ones', () => {
    // A type absent only because its bucket fell off the facet's tail is not
    // evidence of anything — reporting it would be a fabricated finding. The
    // provider half does not come from the facet, so it still renders.
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('never.seen', 'emits')],
      requires: ['scrive'],
      observedComplete: false,
    });
    expect(v.observedComplete).toBe(false);
    expect(v.findings.map((f) => f.kind)).toEqual(['unconnected-provider']);
    // Counted even so: the "N of M" line stays true whether or not it can report.
    expect(v.declaredTypes).toBe(1);
  });
});
