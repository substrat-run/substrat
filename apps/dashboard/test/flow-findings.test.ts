import { describe, expect, it } from 'vitest';
import type { DeclaredEventSurface } from '@substrat-run/contracts';
import { deriveFlowFindings } from '../src/flow-findings.js';

const decl = (type: string, direction: 'emits' | 'consumes', moduleId = 'crm'): DeclaredEventSurface =>
  ({ moduleId, type, direction }) as DeclaredEventSurface;

const NOW = '2026-05-01T00:00:00.000Z';
/** `daysAgo(n)` — a timestamp n days before NOW, so staleness reads as a date. */
const daysAgo = (n: number) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
/** An observation: seen `count` times, most recently `n` days ago. */
const seen = (type: string, n: number, count = 1) => ({ type, count, lastSeen: daysAgo(n) });

const base = {
  declaredEvents: [] as DeclaredEventSurface[],
  requires: [] as string[],
  knownProviders: ['scrive', 'fortnox'],
  observed: [] as { type: string; count: number; lastSeen: string | null }[],
  now: NOW,
  staleAfterDays: 30,
  observedComplete: true,
  declaredComplete: true,
  connections: [] as { provider: string; status: string }[],
};

describe('deriveFlowFindings (#1234)', () => {
  /**
   * `[]` and "absent" are different answers, and collapsing them cost the PROVIDER
   * findings too — which need no declared events at all. A vertical whose modules emit
   * nothing used to read as "pushed before this feature existed", so its unconnected
   * provider went unreported on a card that said it had nothing to say.
   */
  it('an empty declared surface is a fact, not an unavailable view', () => {
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [],
      requires: ['scrive'],
      connections: [],
    });
    expect(v.available).toBe(true);
    expect(v.declaredTypes).toBe(0);
    expect(v.findings.map((f) => f.kind)).toEqual(['unconnected-provider']);
  });

  /** Absent — and ONLY absent — is the version that predates the surface. */
  it('a missing declared surface is the only thing that makes the view unavailable', () => {
    const v = deriveFlowFindings({ ...base, declaredEvents: null, requires: ['scrive'] });
    expect(v.available).toBe(false);
    expect(v.findings).toEqual([]);
  });

  /**
   * A cut declaration still yields real findings — a declared type that was never
   * observed is one whether or not other declarations were omitted — but the view has to
   * carry the fact, because the card's count line is a completeness claim.
   */
  it('carries a truncated declaration through without withholding its findings', () => {
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('receipt.landed', 'emits')],
      declaredComplete: false,
    });
    expect(v.declaredComplete).toBe(false);
    expect(v.findings.map((f) => f.subject)).toEqual(['receipt.landed']);
  });

  it('names a declared emit that has never been seen', () => {
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('receipt.landed', 'emits'), decl('invoice.sent', 'emits')],
      observed: [seen('invoice.sent', 0)],
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
      observed: [seen('a.thing', 0)],
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
      observed: [seen('a.thing', 0)],
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
  it('reports a type that ran and STOPPED, which a count alone hides', () => {
    // The finding #1234 names. A consumer with thousands of events that fell silent
    // two months ago looks perfectly healthy on volume — recency is the only thing
    // that separates "busy" from "was busy".
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('receipt.landed', 'emits', 'sync')],
      observed: [seen('receipt.landed', 61, 4210)],
    });
    expect(v.findings.map((f) => f.kind)).toEqual(['stale']);
    expect(v.findings[0]!.detail).toMatch(/Last recorded 61 days ago, after 4,210 in all — emitted by sync/);
    // NOT "never having run" as the headline: the path demonstrably works.
    expect(v.findings[0]!.detail).toMatch(/ran and stopped/);
  });

  /**
   * The facet groups by event TYPE. Its count and its recency therefore belong to the
   * type across the whole scope, and attributing them to a declaring module would say
   * that module emitted all 4,210 of them and the newest one — which the data cannot
   * support and which is false outright when two modules declare the same type.
   */
  it('keeps a stale claim type-level rather than pinning it on one declaring module', () => {
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('shared.type', 'emits', 'mod-a'), decl('shared.type', 'emits', 'mod-b')],
      observed: [seen('shared.type', 61, 4210)],
    });
    // ONE finding for the type, not one per producer each claiming the whole count.
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.moduleId).toBeNull();
    expect(v.findings[0]!.detail).toMatch(/emitted by mod-a, mod-b/);
  });

  it('does not report one module twice for a type it both emits and handles', () => {
    // `@test/flow` in the contract fixtures declares a type in BOTH directions. Two
    // findings sharing kind, subject and moduleId would also collide as a render key.
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('flow.step1', 'emits', 'flow'), decl('flow.step1', 'consumes', 'flow')],
      observed: [seen('flow.step1', 61, 8)],
    });
    expect(v.findings).toHaveLength(1);
    expect(v.findings[0]!.detail).toMatch(/emitted by flow and handled by flow/);
  });

  it('gives every finding a distinct identity, so a render key cannot collide', () => {
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [
        decl('both.ways', 'emits', 'flow'),
        decl('both.ways', 'consumes', 'flow'),
        decl('gone.quiet', 'emits', 'flow'),
      ],
      requires: ['scrive'],
      observed: [seen('gone.quiet', 61, 8)],
    });
    const keys = v.findings.map((f) => `${f.kind}:${f.subject}:${f.moduleId ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('says nothing about a type seen inside the window', () => {
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('receipt.landed', 'emits')],
      observed: [seen('receipt.landed', 29, 3)],
    });
    expect(v.findings).toEqual([]);
  });

  it('keeps "stopped" and "never ran" as separate findings', () => {
    // Different fixes: one is a regression to investigate, the other may be a feature
    // nobody built yet. A view that merged them would send someone to the wrong place.
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('stopped.type', 'emits'), decl('never.type', 'emits')],
      observed: [seen('stopped.type', 90, 12)],
    });
    expect(v.findings.map((f) => `${f.kind}:${f.subject}`).sort()).toEqual([
      'stale:stopped.type',
      'unemitted:never.type',
    ]);
  });

  it('names the handler as a declarer without blaming it for the silence', () => {
    // The handler is fine; nothing is feeding it. The sentence says it handles the
    // type and that the type stopped — it does not say the handler stopped.
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('invoice.sent', 'consumes', 'billing')],
      observed: [seen('invoice.sent', 45, 900)],
    });
    expect(v.findings[0]!.kind).toBe('stale');
    expect(v.findings[0]!.detail).toMatch(/handled by billing/);
  });

  it('withholds ABSENCE under a truncated observation, but not staleness', () => {
    // The two are not alike. A type the facet did not return may never have been
    // recorded or may have fallen off the tail — unknowable, so unreported. A bucket
    // it DID return carries a real count and a real timestamp, and withholding that
    // would be caution about a fact rather than about a gap. It is also what the map
    // draws, and the two must not disagree within one read.
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('missing.type', 'emits'), decl('old.type', 'emits')],
      observed: [seen('old.type', 61, 12)],
      observedComplete: false,
    });
    expect(v.findings.map((f) => `${f.kind}:${f.subject}`)).toEqual(['stale:old.type']);
  });

  it('reports nothing for a type the truncated facet never returned', () => {
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('a.thing', 'emits')],
      observed: [],
      observedComplete: false,
    });
    expect(v.findings).toEqual([]);
  });

  it('will not call a type stale on a recency the facet could not supply', () => {
    // `lastSeen: null` is "not known", never "long ago". A count with no timestamp
    // says the type exists and says nothing about when — so nothing is claimed.
    const v = deriveFlowFindings({
      ...base,
      declaredEvents: [decl('a.thing', 'emits')],
      observed: [{ type: 'a.thing', count: 5, lastSeen: null }],
    });
    expect(v.findings).toEqual([]);
  });
});
