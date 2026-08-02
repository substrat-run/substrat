import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliVersion, distStaleAdvisory, staleAdvisory } from '../src/version.js';

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

describe('distStaleAdvisory — the workspace stale-build detector (#386)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-stale-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'dist'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const at = (file: string, epochSec: number) => {
    writeFileSync(join(dir, file), '// x');
    utimesSync(join(dir, file), epochSec, epochSec);
  };

  it('warns when any src file is newer than the newest built file', () => {
    at('dist/cli.js', 1_000);
    at('src/cli.ts', 900);
    at('src/push.ts', 2_000); // the pulled change nobody rebuilt
    expect(distStaleAdvisory(join(dir, 'src'), join(dir, 'dist'))).toMatch(
      /OLDER than its sources.*pnpm --filter @substrat-run\/cli build/s,
    );
  });

  it('is silent when the build is current (or same-instant)', () => {
    at('src/cli.ts', 1_000);
    at('dist/cli.js', 1_000);
    expect(distStaleAdvisory(join(dir, 'src'), join(dir, 'dist'))).toBeNull();
    at('dist/cli.js', 2_000);
    expect(distStaleAdvisory(join(dir, 'src'), join(dir, 'dist'))).toBeNull();
  });

  it('is silent when either side has nothing to compare (npm install shape)', () => {
    at('dist/cli.js', 1_000); // src/ empty — the tarball ships none
    expect(distStaleAdvisory(join(dir, 'src'), join(dir, 'dist'))).toBeNull();
    at('src/cli.ts', 2_000);
    rmSync(join(dir, 'dist', 'cli.js'));
    expect(distStaleAdvisory(join(dir, 'src'), join(dir, 'dist'))).toBeNull();
  });

  it('ignores non-source files — a README or map does not count', () => {
    at('dist/cli.js', 1_000);
    at('src/notes.md', 2_000);
    at('dist/cli.js.map', 500);
    expect(distStaleAdvisory(join(dir, 'src'), join(dir, 'dist'))).toBeNull();
  });
});
