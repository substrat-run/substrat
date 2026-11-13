import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeWrangler } from './fake-wrangler.js';

/**
 * Push a throwaway project declaring `substrat` in its package.json, and answer the manifest
 * the push assembled, or the error it refused with before upload.
 */
function pushed(substrat: Record<string, unknown>): { status: number | null; stderr: string; manifests: Record<string, unknown>[] } {
  const dir = mkdtempSync(join(tmpdir(), 'peer-push-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'board', type: 'module', substrat: { permissions: 'permissions.mjs', ...substrat } }));
    writeFileSync(join(dir, 'permissions.mjs'), 'export const permissions = { modules: [], roles: [], entityGrants: [] };');
    writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({ main: 'worker.ts', compatibility_date: '2026-07-01' }));
    writeFileSync(join(dir, 'worker.ts'), 'export default { fetch: () => new Response("ok") };');
    installFakeWrangler(dir);
    // A real Node module loader can import the runtime-built permission file; Vitest cannot.
    // Replace only wrangler's subprocess. Metadata, manifest validation and upload stay real.
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      encoding: 'utf8',
      input: `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { writeFileSync, rmSync } from 'node:fs';
        import { join } from 'node:path';
        let bundleDir;
        cp.execFileSync = (file, args) => {
          // The project's own wrangler, run by node: installFakeWrangler gives the push one to resolve.
          if (file !== process.execPath || !args.includes('--dry-run')) throw new Error('unexpected subprocess');
          bundleDir = args[args.indexOf('--outdir') + 1];
          writeFileSync(join(bundleDir, 'worker.js'), 'export default {};');
          return Buffer.from('');
        };
        syncBuiltinESMExports();
        const { buildRelease: push, readVerticalMeta } = await import(${JSON.stringify(new URL('../dist/push.js', import.meta.url).href)});
        globalThis.fetch = async (_url, init) => {
          console.log('MANIFEST:' + init.body.get('manifest'));
          return Response.json({ id: 'v', admission: 'accepted', deploymentRef: 'board-v', verticalSlug: 'board' });
        };
        const dir = ${JSON.stringify(dir)};
        try {
          const built = await push({ dir, slug: 'board', version: '1.0.0', controlPlaneUrl: 'https://cp.example/api', authHeader: {},
            calls: readVerticalMeta(dir).calls, issuerScopes: readVerticalMeta(dir).issuerScopes, linted: { root: dir, gate: 'passed' } });
          console.log('MANIFEST:' + built.form.get('manifest'));
        } finally { if (bundleDir) rmSync(bundleDir, { recursive: true, force: true }); }
      `,
    });
    const manifests = result.stdout.split('\n').filter((line) => line.startsWith('MANIFEST:'));
    return {
      status: result.status,
      stderr: result.stderr,
      manifests: manifests.map((line) => JSON.parse(line.slice('MANIFEST:'.length)) as Record<string, unknown>),
    };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// One push per row: the peer calls (#1706) are always sent, the issuer scopes (#3134) only when declared.
it.each([
  [undefined, undefined],
  [[], undefined],
  [['acme/crm'], ['read:users', 'users:provision']],
])('push sends an explicit calls declaration for %j, and issuer scopes %j only when declared', (calls, issuerScopes) => {
  const result = pushed({ ...(calls === undefined ? {} : { calls }), ...(issuerScopes ? { issuerScopes } : {}) });
  expect(result.status, result.stderr).toBe(0);
  expect(result.manifests).toHaveLength(1);
  expect(result.manifests[0]).toMatchObject({ calls: calls ?? [] });
  expect(result.manifests[0]!.issuerScopes).toEqual(issuerScopes);
});

it('push refuses a sign-in scope among the declared issuer scopes, before upload (#3134)', () => {
  const refused = pushed({ issuerScopes: ['read:users', 'openid'] });
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('substrat.issuerScopes');
  expect(refused.manifests).toEqual([]);
});
