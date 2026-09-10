import { describe, expect, it } from 'vitest';
import type { IdentityLink } from '@substrat-run/contracts';
import { deriveIdentityDivergence } from '../src/identity-mirror.js';

const T = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const link = (externalId: string, principal: string, over: Partial<IdentityLink> = {}): IdentityLink =>
  ({ provider: 'better-auth', externalId, principal, tenantId: T, ...over }) as IdentityLink;

/**
 * The readiness check #1343's migration needs (#265's mirror made observable).
 * Until this, the mirror wrote and never looked, and its `catch` swallowed every
 * failure — so "the mirror is complete" was a belief, and a live-data move cannot
 * be planned against a belief.
 */
describe('deriveIdentityDivergence (#1343)', () => {
  it('reports in-sync when both directories agree', () => {
    const links = [link('u1', 'p1'), link('u2', 'p2')];
    const d = deriveIdentityDivergence(links, [...links].reverse());
    expect(d.inSync).toBe(true);
    expect(d).toMatchObject({ missing: [], extra: [], conflicting: [] });
  });

  it('names the links the mirror never landed', () => {
    const d = deriveIdentityDivergence([link('u1', 'p1'), link('u2', 'p2')], [link('u1', 'p1')]);
    expect(d.missing.map((l) => l.externalId)).toEqual(['u2']);
    expect(d.inSync).toBe(false);
  });

  it('names a link the shared directory kept after a local unlink', () => {
    // The direction nothing reconciles today: a removal that landed locally and
    // never propagated leaves the shared plane still authenticating the person.
    const d = deriveIdentityDivergence([link('u1', 'p1')], [link('u1', 'p1'), link('gone', 'p9')]);
    expect(d.extra.map((l) => l.externalId)).toEqual(['gone']);
    expect(d.inSync).toBe(false);
  });

  it('catches the case a COUNT cannot see: same user, different principal', () => {
    // Both sides have "a link for u1", so any tally says the mirror is complete —
    // and the shared directory sends that login to somebody else. This is the whole
    // reason the comparison is keyed on (provider, externalId) rather than counted.
    const d = deriveIdentityDivergence([link('u1', 'p1')], [link('u1', 'DIFFERENT')]);
    expect(d.missing).toEqual([]);
    expect(d.extra).toEqual([]);
    expect(d.conflicting).toHaveLength(1);
    expect(d.conflicting[0]!.local.principal).toBe('p1');
    expect(d.conflicting[0]!.shared.principal).toBe('DIFFERENT');
    expect(d.inSync).toBe(false);
  });

  it('does not call a differing scopeId a conflict', () => {
    // The mirror omits `scopeId` for a tenant-level home, so it legitimately
    // differs. Only the principal decides who you become on sign-in.
    const d = deriveIdentityDivergence(
      [link('u1', 'p1', { scopeId: '01ARZ3NDEKTSV4RRFFQ69G5FA1' } as Partial<IdentityLink>)],
      [link('u1', 'p1')],
    );
    expect(d.inSync).toBe(true);
  });

  it('distinguishes providers with the same external id', () => {
    // Two providers can hand out the same `sub`; they are different people.
    const d = deriveIdentityDivergence(
      [link('u1', 'p1'), link('u1', 'p2', { provider: 'oidc:other' })],
      [link('u1', 'p1')],
    );
    expect(d.missing.map((l) => l.provider)).toEqual(['oidc:other']);
  });
});
