import { describe, expect, it } from 'vitest';
import type { IdentityLink } from '@substrat-run/contracts';
import { deriveIdentityDivergence, mirrorIdentityLink, type MirrorPlane } from '../src/identity-mirror.js';

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
  it('does not confuse two tuples that a flat key would merge', () => {
    // Both halves accept any non-empty string, so a delimiter is a convention the
    // data can break — including the `US` byte this first used. These are two
    // different people; under a flat key they were one, and the shared
    // directory's link for the second would have been read as the first's.
    const a = link('\u001fb', 'p1', { provider: 'better-auth' });
    const b = link('b', 'p2', { provider: 'better-auth\u001f' });
    const d = deriveIdentityDivergence([a, b], [a, b]);
    expect(d.inSync).toBe(true);
    const half = deriveIdentityDivergence([a, b], [a]);
    expect(half.missing.map((l) => l.principal)).toEqual(['p2']);
  });
});

/**
 * The mirror step's own failure paths. Its `catch` is what makes the mirror
 * best-effort, and the plane is CONSTRUCTED inside it: a deployment with no
 * `CONTROL_PLANE_SVC` binding throws there (#978), and that throw used to happen
 * before the try — escaping into the sign-up, invite-accept or `/api/me` the
 * mirror was riding on, which is the opposite of best-effort.
 */
describe('mirrorIdentityLink (#1343)', () => {
  const activeTeam = { slug: 'acme', name: 'Acme', status: 'active' };
  const plane = (over: Partial<MirrorPlane> = {}): MirrorPlane => ({
    ensureTenant: async () => undefined,
    getTenant: async () => ({ name: 'Acme' }),
    setTenantName: async () => undefined,
    linkIdentity: async () => undefined,
    ...over,
  });
  const deps = (over: Record<string, unknown>) => ({
    provider: 'better-auth',
    externalId: 'u1',
    tenantId: T,
    team: async () => activeTeam,
    resolve: async () => ({ principal: 'p1' }),
    plane: () => plane(),
    log: () => {},
    ...over,
  });

  it('mirrors the link when the plane is there', async () => {
    const written: unknown[] = [];
    const outcome = await mirrorIdentityLink(
      deps({ plane: () => plane({ linkIdentity: async (l) => void written.push(l) }) }),
    );
    expect(outcome).toBe('mirrored');
    expect(written).toEqual([{ provider: 'better-auth', externalId: 'u1', principal: 'p1' }]);
  });

  it('swallows a MISSING BINDING and reports it, rather than failing the request', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const outcome = await mirrorIdentityLink(
      deps({
        plane: () => {
          throw new Error('the dashboard is not connected to the control plane');
        },
        log: (line: Record<string, unknown>) => void lines.push(line),
      }),
    );
    expect(outcome).toBe('failed');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'dashboard.identity-mirror.failed', tenantId: T });
    expect(String(lines[0]!.detail)).toContain('not connected to the control plane');
  });

  it('reports a plane that answers but refuses the write', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const outcome = await mirrorIdentityLink(
      deps({
        plane: () =>
          plane({
            linkIdentity: async () => {
              throw new Error('503 upstream');
            },
          }),
        log: (line: Record<string, unknown>) => void lines.push(line),
      }),
    );
    expect(outcome).toBe('failed');
    expect(String(lines[0]!.detail)).toContain('503');
  });

  it('skips — silently, because it is not a failure — when there is nothing to mirror', async () => {
    const lines: unknown[] = [];
    const log = (line: unknown) => void lines.push(line);
    expect(await mirrorIdentityLink(deps({ team: async () => undefined, log }))).toBe('skipped');
    expect(await mirrorIdentityLink(deps({ team: async () => ({ ...activeTeam, status: 'suspended' }), log }))).toBe(
      'skipped',
    );
    expect(await mirrorIdentityLink(deps({ resolve: async () => undefined, log }))).toBe('skipped');
    expect(lines).toEqual([]);
  });

  it('syncs a stale display name, and stays writeless when it already agrees', async () => {
    const names: string[] = [];
    await mirrorIdentityLink(
      deps({
        plane: () => plane({ getTenant: async () => ({ name: 'owner@example.com' }), setTenantName: async (n: string) => void names.push(n) }),
      }),
    );
    expect(names).toEqual(['Acme']);
    const quiet: string[] = [];
    await mirrorIdentityLink(deps({ plane: () => plane({ setTenantName: async (n: string) => void quiet.push(n) }) }));
    expect(quiet).toEqual([]);
  });
});
