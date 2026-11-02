import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { storeDriverRepositoryIsPlatformRepository } from '../src/deploy.js';

// A repo-wide check (`pnpm lint:store-driver-repository`, run by CI's checks job): it reads
// every workspace manifest, so it runs on every PR there rather than with contracts' suite.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const PRIVATE_WORKSPACE_PACKAGES = [
  'apps/builder', 'apps/builder/web', 'apps/console', 'apps/control-plane', 'apps/dashboard', 'apps/dashboard/web',
  'apps/docs', 'apps/router', 'apps/social-relay', 'apps/vertical-egress',
  'connectors/mail-in', 'connectors/microsoft365',
  'demos/auth-server', 'demos/auth-server/app', 'demos/handlebar', 'demos/handlebar/app', 'demos/manyfold', 'demos/manyfold/app',
  'demos/meridian', 'demos/meridian/app', 'demos/shop', 'demos/shop/admin', 'demos/shop/app', 'demos/ticket0', 'demos/ticket0/app',
  'demos/tock', 'demos/tock/app', 'demos/todo', 'demos/todo/app',
  'engines/assistant',
  'packages/adapter-email', 'packages/builder-generator', 'packages/builder-workspace', 'packages/console-data',
  'packages/engine-test-kit', 'packages/template-check', 'packages/ui',
  'spikes/k3s-sharding',
] as const;

// Enumerate the package-root workspace globs from pnpm-workspace.yaml. The gitignored
// .builder/projects globs are intentionally omitted: they are disposable generated projects,
// not checked-in source workspaces (see the workspace file's scratch-project note).
function workspacePackageDirs(): string[] {
  const roots = ['packages', 'engines', 'connectors', 'demos', 'apps'];
  const dirs = roots.flatMap((root) => readdirSync(join(ROOT, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const top = join(ROOT, root, entry.name);
      return [top, ...['app', 'admin', 'web'].map((child) => join(top, child)).filter((child) => existsSync(child))];
    }));
  dirs.push(join(ROOT, 'spikes/k3s-sharding'));
  return dirs.filter((dir) => existsSync(join(dir, 'package.json'))).map((dir) => relative(ROOT, dir).replaceAll('\\', '/')).sort();
}

type WorkspaceManifest = { private?: unknown; repository?: { url?: unknown } };
function validateWorkspaceManifest(path: string, text: string): 'private' | string {
  let manifest: WorkspaceManifest;
  try {
    manifest = JSON.parse(text) as WorkspaceManifest;
  } catch {
    throw new Error(`${path}: package.json is not valid JSON`);
  }
  const isPrivate = manifest.private === true;
  if (isPrivate) {
    if (!(PRIVATE_WORKSPACE_PACKAGES as readonly string[]).includes(path)) throw new Error(`${path}: private workspace is missing from the explicit private list`);
    return 'private';
  }
  if (manifest.private !== undefined && manifest.private !== false) throw new Error(`${path}: private must be a boolean`);
  if (typeof manifest.repository?.url !== 'string' || manifest.repository.url.length === 0) throw new Error(`${path}: public workspace requires repository.url`);
  if (!storeDriverRepositoryIsPlatformRepository(manifest.repository.url)) throw new Error(`${path}: repository.url must identify the platform repository`);
  return manifest.repository.url;
}

describe('store driver platform repository, held to every workspace manifest (D-65)', () => {
  it('requires every public workspace manifest to name the platform repository and explicitly lists private workspaces', () => {
    const dirs = workspacePackageDirs();
    const privatePaths = dirs.filter((path) => {
      const manifest = JSON.parse(readFileSync(join(ROOT, path, 'package.json'), 'utf8')) as { private?: boolean };
      return manifest.private === true;
    });
    expect(privatePaths).toEqual([...PRIVATE_WORKSPACE_PACKAGES].sort());
    for (const path of dirs) {
      const result = validateWorkspaceManifest(path, readFileSync(join(ROOT, path, 'package.json'), 'utf8'));
      if (result !== 'private') expect(storeDriverRepositoryIsPlatformRepository(result), path).toBe(true);
    }
  });

  it.each([
    ['malformed JSON', 'packages/example', '{', /not valid JSON/],
    ['missing repository URL', 'packages/example', '{"name":"example"}', /requires repository.url/],
    ['non-string repository URL', 'packages/example', '{"repository":{"url":42}}', /requires repository.url/],
    ['unlisted private workspace', 'packages/example', '{"private":true}', /missing from the explicit private list/],
  ])('fails closed for %s', (_label, path, text, message) => {
    expect(() => validateWorkspaceManifest(path, text)).toThrow(message);
  });

  it('skips an explicitly listed private workspace', () => {
    expect(validateWorkspaceManifest('packages/ui', '{"private":true}')).toBe('private');
  });
});
