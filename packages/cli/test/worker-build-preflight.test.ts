import { expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A Wrangler dry-run stub that performs the configured build and counts uploads. */
function pushWithGeneratedFile(generated: string, forgedReceipt = false): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), 'worker-build-preflight-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/board', type: 'module', substrat: { permissions: 'permissions.mjs' } }));
    writeFileSync(join(dir, 'permissions.mjs'), 'export const permissions = { modules: [], roles: [], entityGrants: [] };');
    writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({ main: 'worker.js', compatibility_date: '2026-07-01', build: { command: 'node generate.mjs' } }));
    writeFileSync(join(dir, 'worker.js'), `import './generated.js'; export default { fetch: () => new Response('ok') };`);
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      encoding: 'utf8',
      input: `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { writeFileSync, rmSync } from 'node:fs';
        import { join } from 'node:path';
        const dir = ${JSON.stringify(dir)};
        let builds = 0;
        let uploads = 0;
        let out;
        cp.execFileSync = (file, args) => {
          if (file !== 'npx' || !args.includes('--dry-run')) throw new Error('unexpected subprocess');
          builds++;
          writeFileSync(join(dir, 'generated.js'), ${JSON.stringify(generated)});
          out = args[args.indexOf('--outdir') + 1];
          writeFileSync(join(out, 'worker.js'), 'export default {};');
          return Buffer.from('');
        };
        syncBuiltinESMExports();
        globalThis.fetch = async () => {
          uploads++;
          return Response.json({ id: 'v', admission: 'accepted', deploymentRef: 'r', verticalSlug: 'board' });
        };
        const { push } = await import(${JSON.stringify(new URL('../dist/push.js', import.meta.url).href)});
        try {
          await push({ dir, slug: 'board', version: '1.0.0', controlPlaneUrl: 'https://cp.example/api', authHeader: {},
            linted: { root: dir, gate: 'passed' },
            ...(${JSON.stringify(forgedReceipt)} ? { preparedWorker: { root: dir, cfg: { main: 'worker.js', compatibility_date: '2026-07-01' }, out: dir } } : {}) });
          console.log('RESULT:passed');
        } catch (error) {
          console.log('RESULT:' + error.message);
        } finally {
          console.log('BUILDS:' + builds + ' UPLOADS:' + uploads);
          if (out) rmSync(out, { recursive: true, force: true });
        }
      `,
    });
    return { status: result.status ?? -1, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it('checks a generated import after the build command, running it once', () => {
  const result = pushWithGeneratedFile('export const ready = true;');
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain('RESULT:passed');
  expect(result.output).toContain('BUILDS:1 UPLOADS:1');
});

it('refuses a builtin in a generated import before upload', () => {
  const result = pushWithGeneratedFile(`import 'node:crypto'; export const ready = true;`);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain('RESULT:Worker');
  expect(result.output).toContain('node:crypto');
  expect(result.output).toContain('BUILDS:1 UPLOADS:0');
});

it('does not accept a caller-forged build receipt in place of the import check', () => {
  const result = pushWithGeneratedFile(`import 'node:crypto';`, true);
  expect(result.output).toContain('node:crypto');
  expect(result.output).toContain('BUILDS:1 UPLOADS:0');
});

function commandWithBuiltin(flags: string[], command: 'push' | 'preview'): { status: number; output: string; networkCalled: boolean; builds: number } {
  const dir = mkdtempSync(join(tmpdir(), 'worker-command-preflight-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/board', type: 'module', substrat: { slug: 'board', permissions: 'permissions.mjs' } }));
    writeFileSync(join(dir, 'permissions.mjs'), 'export const permissions = { modules: [], roles: [], entityGrants: [] };');
    writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({ main: 'worker.js', compatibility_date: '2026-07-01', compatibility_flags: flags }));
    writeFileSync(join(dir, 'worker.js'), `import 'node:crypto'; export default { fetch: () => new Response('ok') };`);
    const marker = join(dir, 'network-called');
    const builds = join(dir, 'build-count');
    const cli = new URL('../dist/cli.js', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      encoding: 'utf8',
      input: `
        import cp from 'node:child_process';
        import { syncBuiltinESMExports } from 'node:module';
        import { writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        process.argv = [process.execPath, ${JSON.stringify(cli)}, ${command === 'push' ? "'push'," : "'preview', 'create',"} ${JSON.stringify(dir)}, '--tag', 'pr-1', '--cp', 'https://cp.invalid', '--token', 'test-token'];
        let buildCount = 0;
        cp.execFileSync = (file, args) => {
          if (file !== 'npx' || !args.includes('--dry-run')) throw new Error('unexpected subprocess');
          writeFileSync(${JSON.stringify(builds)}, String(++buildCount));
          writeFileSync(join(args[args.indexOf('--outdir') + 1], 'worker.js'), 'export default {};');
          return Buffer.from('');
        };
        syncBuiltinESMExports();
        globalThis.fetch = async () => {
          writeFileSync(${JSON.stringify(marker)}, 'called');
          return Response.json({ entries: [], nextCursor: null });
        };
        await import(${JSON.stringify(cli)});
      `,
    });
    return { status: result.status ?? -1, output: result.stdout + result.stderr, networkCalled: existsSync(marker), builds: existsSync(builds) ? Number(readFileSync(builds, 'utf8')) : 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it.each(['push', 'preview'] as const)('the %s command refuses a builtin before auth or a registry request', (command) => {
  const result = commandWithBuiltin([], command);
  expect(result.status).not.toBe(0);
  expect(result.output).toContain('node:crypto');
  expect(result.networkCalled).toBe(false);
  expect(result.builds).toBe(1);
});

it('allows the same command path when nodejs_compat is declared and builds once', () => {
  const result = commandWithBuiltin(['nodejs_compat'], 'push');
  expect(result.networkCalled, result.output).toBe(true);
  expect(result.builds).toBe(1);
});
