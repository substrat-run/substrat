import { describe, expect, it } from 'vitest';
import {
  STORE_DRIVER_ADMITTED_ISOLATION_LIFTS,
  STORE_DRIVER_PLATFORM_REPOSITORY,
  normalizeStoreDriverRepositoryUrl,
  storeDriverIsolationBasis,
  storeDriverRegistration,
  storeDriverRepositoryIsPlatformRepository,
} from '../src/deploy.js';

describe('store driver registration isolation basis (D-65)', () => {
  it('admits only repo-written or explicitly admitted decision-record bases', () => {
    expect(STORE_DRIVER_ADMITTED_ISOLATION_LIFTS).toEqual([]);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'writtenInRepo' }).success).toBe(true);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'decisionRecord', decisionRecord: 'D-63' }).success).toBe(false);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'decisionRecord', decisionRecord: 'D-000' }).success).toBe(false);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'writtenInRepo', extra: true }).success).toBe(false);
  });

  it('is an id and a basis: a registration still carrying a release pin or its facts is refused', () => {
    const registration = { driver: 'graph', isolationBasis: { kind: 'writtenInRepo' } };
    expect(storeDriverRegistration.safeParse(registration).success).toBe(true);
    for (const pinned of [
      { releases: [{ sha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), schema: 0 }] },
      { className: 'GraphStore' },
      { operations: [] },
    ]) {
      expect(storeDriverRegistration.safeParse({ ...registration, ...pinned }).success, JSON.stringify(pinned)).toBe(false);
    }
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
