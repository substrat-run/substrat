import { describe, expect, it } from 'vitest';
import {
  STORE_DRIVER_ADMITTED_ISOLATION_LIFTS,
  STORE_DRIVER_PLATFORM_REPOSITORY,
  STORE_DRIVERS,
  normalizeStoreDriverRepositoryUrl,
  storeDriverBasisAdmits,
  storeDriverErasesSubjects,
  storeDriverIsolationBasis,
  storeDriverRegistration,
  storeDriverRepositoryIsPlatformRepository,
  storeDriverServesVertical,
} from '../src/deploy.js';

describe('store driver registration isolation basis (D-65)', () => {
  it('admits only repo-written or explicitly admitted decision-record bases', () => {
    expect(STORE_DRIVER_ADMITTED_ISOLATION_LIFTS).toEqual(['D-67']);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'writtenInRepo' }).success).toBe(true);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'decisionRecord', decisionRecord: 'D-67' }).success).toBe(true);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'decisionRecord', decisionRecord: 'D-63' }).success).toBe(false);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'decisionRecord', decisionRecord: 'D-000' }).success).toBe(false);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'writtenInRepo', extra: true }).success).toBe(false);
  });

  it('admits the driver’s own repositories under a decision-record basis, and only the platform’s under writtenInRepo', () => {
    const own = [{ repository: 'https://github.com/other-org/graph' }];
    const graph = STORE_DRIVERS.find((d) => d.driver === 'graph')!;
    expect(storeDriverBasisAdmits(graph.isolationBasis, own)).toBe(true);
    expect(storeDriverBasisAdmits({ kind: 'writtenInRepo' }, own)).toBe(false);
    expect(storeDriverBasisAdmits({ kind: 'writtenInRepo' }, [{ repository: STORE_DRIVER_PLATFORM_REPOSITORY }])).toBe(true);
  });

  it('is an id and a basis: a registration still carrying a release pin or its facts is refused', () => {
    const registration = { driver: 'graph', isolationBasis: { kind: 'writtenInRepo' }, dumpPageMaxBytes: 1000 };
    expect(storeDriverRegistration.safeParse(registration).success).toBe(true);
    for (const pinned of [
      { releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), schema: 0 }] },
      { className: 'GraphStore' },
      { operations: [] },
    ]) {
      expect(storeDriverRegistration.safeParse({ ...registration, ...pinned }).success, JSON.stringify(pinned)).toBe(false);
    }
  });

  it('a driver on a decision record names the verticals it serves; one in the repo may serve every vertical', () => {
    const lifted = { driver: 'graph', isolationBasis: { kind: 'decisionRecord', decisionRecord: 'D-67' }, dumpPageMaxBytes: 1000 };
    const parsed = storeDriverRegistration.safeParse(lifted);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('names the verticals it serves');
    expect(storeDriverRegistration.safeParse({ ...lifted, verticals: ['notes'] }).success).toBe(true);
    const inRepo = storeDriverRegistration.parse({ driver: 'graph', isolationBasis: { kind: 'writtenInRepo' }, dumpPageMaxBytes: 1000 });
    expect(storeDriverServesVertical(inRepo, 'any')).toBe(true);
  });

  it('a driver whose erasure is pending is marked so, and the hosted graph driver is', () => {
    const graph = STORE_DRIVERS.find((d) => d.driver === 'graph')!;
    expect(storeDriverErasesSubjects(graph)).toBe(false);
    expect(storeDriverErasesSubjects({ driver: 'graph', isolationBasis: { kind: 'writtenInRepo' }, dumpPageMaxBytes: 1000 })).toBe(true);
  });

  it('normalizes only the platform repo identity and refuses mirrors and look-alikes', () => {
    expect(STORE_DRIVER_PLATFORM_REPOSITORY).toBe('https://github.com/substrat-run/substrat');
    const accepted = [
      'https://github.com/substrat-run/substrat',
      'git+https://github.com/substrat-run/substrat.git',
      'https://github.com/substrat-run/substrat.git/',
      'HTTPS://GITHUB.COM/substrat-run/substrat/',
    ];
    for (const url of accepted) {
      expect(normalizeStoreDriverRepositoryUrl(url)).toBe(STORE_DRIVER_PLATFORM_REPOSITORY);
      expect(storeDriverRepositoryIsPlatformRepository(url)).toBe(true);
    }
    const refused = [
      'https://github.com/other-org/substrat',
      'https://github.com/substrat-run/other-repo',
      'https://github.com.evil.example/substrat-run/substrat',
      'https://mirror.example/substrat-run/substrat',
    ];
    for (const url of refused) expect(storeDriverRepositoryIsPlatformRepository(url), url).toBe(false);
  });
});
