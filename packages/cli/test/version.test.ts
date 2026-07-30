import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cliVersion, staleAdvisory } from '../src/version.js';

describe('cliVersion', () => {
  it('reports the version from the package.json in the tarball', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(cliVersion()).toBe(pkg.version);
  });
});

describe('staleAdvisory — the control-plane-driven freshness decision', () => {
  it('is silent when up to date with latest', () => {
    expect(staleAdvisory('1.2.3', { latest: '1.2.3', min: '1.0.0' })).toBeNull();
  });

  it('is silent when the server advertises nothing', () => {
    expect(staleAdvisory('1.2.3', {})).toBeNull();
    expect(staleAdvisory('1.2.3', { min: null, latest: null })).toBeNull();
  });

  it('nudges (behind) when a newer version exists but we are still above the floor', () => {
    const a = staleAdvisory('1.2.3', { min: '1.0.0', latest: '1.5.0' });
    expect(a?.level).toBe('behind');
    expect(a?.message).toContain('1.5.0');
  });

  it('blocks when below the minimum supported version — the floor wins over "behind"', () => {
    const a = staleAdvisory('0.9.0', { min: '1.0.0', latest: '1.5.0' });
    expect(a?.level).toBe('blocked');
    expect(a?.message).toContain('1.0.0');
  });

  it('treats being exactly at the floor as fine', () => {
    expect(staleAdvisory('1.0.0', { min: '1.0.0', latest: '1.0.0' })).toBeNull();
  });

  it('ignores prerelease/build suffixes on either side', () => {
    expect(staleAdvisory('1.2.3-rc.1', { latest: '1.2.3' })).toBeNull();
    expect(staleAdvisory('1.2.3', { latest: '1.4.0+build.7' })?.level).toBe('behind');
  });

  it('yields no advisory when our own version is unparseable', () => {
    expect(staleAdvisory('not-a-version', { min: '1.0.0', latest: '2.0.0' })).toBeNull();
  });
});
