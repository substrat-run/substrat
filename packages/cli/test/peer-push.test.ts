import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeWrangler } from './fake-wrangler.js';

it.each([undefined, [], ['acme/crm']])('push sends an explicit calls declaration for %j', (calls) => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-push-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'board', type: 'module', substrat: { permissions: 'permissions.mjs', ...(calls === undefined ? {} : { calls }) } }));
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
            calls: readVerticalMeta(dir).calls, linted: { root: dir, gate: 'passed' } });
          console.log('MANIFEST:' + built.form.get('manifest'));
        } finally { if (bundleDir) rmSync(bundleDir, { recursive: true, force: true }); }
      `,
    });
    expect(result.status, result.stderr).toBe(0);
    const manifests = result.stdout.split('\n').filter((line) => line.startsWith('MANIFEST:'));
    expect(manifests).toHaveLength(1);
    expect(JSON.parse(manifests[0]!.slice('MANIFEST:'.length))).toMatchObject({ calls: calls ?? [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
