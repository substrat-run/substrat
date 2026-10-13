import { describe, it, expect } from 'vitest';
import { assertSignInPolicy } from '../src/sign-in-policy.js';
import {
  ANY_PROVIDER, describeFlow, draftFromStored, draftProblems, draftToStored, newRoute, parseDomains, resolveAny,
} from '../app/src/views/sign-in-draft.js';

const OFFERED = [{ id: 'microsoft', label: 'Microsoft' }, { id: 'bankid', label: 'BankID' }];

describe('the sign-in form writes what the server accepts', () => {
  it('round-trips the identifier-first policy through the form and the server schema', () => {
    const stored = {
      providers: ['bankid'], password: true, passwordSecondFactor: 'sms', identifierFirst: true,
      domainRoutes: [{ domains: ['acme.se', 'acme.com'], provider: 'microsoft' }],
    };
    const draft = draftFromStored(stored);
    expect(draftProblems(draft, OFFERED, false)).toEqual([]);
    const written = draftToStored(draft, OFFERED, false);
    expect(written).toEqual(stored);
    expect(() => assertSignInPolicy(written)).not.toThrow();
  });

  it('writes nothing when nothing is restricted — absent is the default', () => {
    expect(draftToStored(draftFromStored(undefined), OFFERED, false)).toBeUndefined();
  });

  it('expands "any provider" once the issuer list arrives', () => {
    const draft = draftFromStored({ password: true });
    expect(draft.methods.has(ANY_PROVIDER)).toBe(true);
    const resolved = resolveAny(draft, OFFERED);
    expect([...resolved.methods].sort()).toEqual(['bankid', 'microsoft', 'password']);
  });

  it('accepts the way people actually type domains', () => {
    expect(parseDomains('@Acme.se, acme.com\nacme.se')).toEqual(['acme.se', 'acme.com']);
  });

  it('says what is wrong, before the server has to', () => {
    const draft = draftFromStored({ providers: [], password: true, identifierFirst: true });
    draft.routes = [
      { ...newRoute('microsoft'), domains: 'anna@acme.se' },
      { ...newRoute(''), domains: 'acme.se' },
      { ...newRoute('microsoft'), domains: 'acme.se' },
    ];
    const problems = draftProblems(draft, OFFERED, false);
    expect(problems.some((p) => p.includes('not a domain name'))).toBe(true);
    expect(problems.some((p) => p.includes('choose the provider'))).toBe(true);
    expect(problems.some((p) => p.includes('already in rule'))).toBe(true);
  });

  it('never writes routes for the console, whose screen does not enforce them', () => {
    const draft = draftFromStored({ providers: ['microsoft'], password: true, identifierFirst: true, domainRoutes: [{ domains: ['acme.se'], provider: 'microsoft' }] });
    const written = draftToStored(draft, OFFERED, true);
    expect(written).not.toHaveProperty('domainRoutes');
    expect(written).not.toHaveProperty('identifierFirst');
  });

  it('previews the flow from the same draft, and warns about a dead end', () => {
    const draft = draftFromStored({ providers: ['bankid'], password: true, passwordSecondFactor: 'sms', identifierFirst: true, domainRoutes: [{ domains: ['acme.se'], provider: 'microsoft' }] });
    const flow = describeFlow(draft, OFFERED, false);
    expect(flow.first).toEqual(['BankID', 'Email address']);
    expect(flow.visitors[0]).toEqual({ who: 'Email @acme.se', what: 'Microsoft only' });
    expect(flow.visitors.find((v) => v.who === 'Any other email')?.what).toContain('SMS');
    expect(describeFlow(draftFromStored({ providers: [], password: false }), OFFERED, false).deadEnd).toBe(true);
  });
});
