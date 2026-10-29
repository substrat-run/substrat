import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STORE_DRIVER_ADMITTED_ISOLATION_LIFTS,
  STORE_DRIVER_PLATFORM_REPOSITORY,
  normalizeStoreDriverRepositoryUrl,
  storeDriverIsolationBasis,
  storeDriverRepositoryIsPlatformRepository,
} from '../src/deploy.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function workspacePackageJsons(directory: string): string[] {
  const result: string[] = [];
  const manifest = join(directory, 'package.json');
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { repository?: { url?: unknown } };
    if (typeof parsed.repository?.url === 'string') result.push(manifest);
  } catch {
    // Workspace source directories need not be package roots.
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['.git', 'dist', 'node_modules', 'template'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    result.push(...workspacePackageJsons(path));
  }
  return result;
}

describe('store driver registration isolation basis (D-65)', () => {
  it('admits only repo-written or explicitly admitted decision-record bases', () => {
    expect(STORE_DRIVER_ADMITTED_ISOLATION_LIFTS).toEqual([]);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'writtenInRepo' }).success).toBe(true);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'decisionRecord', decisionRecord: 'D-63' }).success).toBe(false);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'decisionRecord', decisionRecord: 'D-000' }).success).toBe(false);
    expect(storeDriverIsolationBasis.safeParse({ kind: 'writtenInRepo', extra: true }).success).toBe(false);
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

  it('keeps the compiled repository identity aligned with every workspace package manifest', () => {
    const manifests = ['packages', 'engines', 'connectors', 'demos', 'apps', 'spikes/k3s-sharding']
      .flatMap((dir) => workspacePackageJsons(join(ROOT, dir)));
    expect(manifests.length).toBeGreaterThan(0);
    for (const path of manifests) {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { repository: { url: string } };
      expect(storeDriverRepositoryIsPlatformRepository(manifest.repository.url), relative(ROOT, path)).toBe(true);
    }
  });
});
