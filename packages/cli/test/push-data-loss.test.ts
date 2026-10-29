import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterSqliteBuilt, built, kernelBuilt, pushRun, vertical, type ModuleSpec } from './push-harness.js';

/**
 * #2321 — `substrat push` replays a vertical's authored migrations against a populated in-memory
 * scope through its OWN kernel's data-loss fence, and refuses before upload. Driven through the
 * real `push()` (./push-harness.ts), whose stubbed `fetch` prints `MANIFEST` only when it uploads,
 * and through `substrat push --check`, which must refuse the same tree.
 */
const INIT = { version: '0001', sql: 'CREATE TABLE ticket (id TEXT PRIMARY KEY, title TEXT);' };
const DROP = { version: '0002', sql: 'DROP TABLE ticket;' };
const helpdesk = (migrations: NonNullable<ModuleSpec['migrations']>) => [{ id: 'helpdesk', migrations }];
const uploaded = (stdout: string) => stdout.split('\n').some((l) => l.startsWith('MANIFEST '));
const dataLoss = (stdout: string) => {
  const line = stdout.split('\n').find((l) => l.startsWith('DATALOSS '));
  return line ? JSON.parse(line.slice('DATALOSS '.length)) : undefined;
};

describe.runIf(built && kernelBuilt)('push refuses a migration that would lose data, before upload', () => {
  it('an undeclared destructive migration is refused, and nothing is uploaded', () => {
    const r = pushRun(vertical(helpdesk([INIT, DROP]), undefined, { kernel: true }));
    expect(r.status).not.toBe(0);
    expect(uploaded(r.stdout)).toBe(false);
    expect(r.stderr).toMatch(/data-loss check: REFUSED — migration helpdesk@0002 would lose data this scope holds/);
    expect(r.stderr).toContain("discards: { 'ticket': '<why this data may go>' }");
  });

  it('the same migration, declared, is pushed — with its declaration printed', () => {
    const r = pushRun(vertical(helpdesk([INIT, { ...DROP, discards: { ticket: 'replaced by cases' } }]), undefined, { kernel: true }));
    expect(r.status).toBe(0);
    expect(uploaded(r.stdout)).toBe(true);
    expect(r.stdout).toContain('declared  helpdesk@0002 discards ticket: replaced by cases');
    expect(dataLoss(r.stdout)).toEqual({ status: 'passed', authored: 2 });
  });

  it('an additive migration is pushed', () => {
    const r = pushRun(vertical(helpdesk([INIT, { version: '0002', sql: 'ALTER TABLE ticket ADD COLUMN priority TEXT;' }]), undefined, { kernel: true }));
    expect(r.status).toBe(0);
    expect(uploaded(r.stdout)).toBe(true);
    expect(r.stdout).toContain('data-loss check: PASSED (2 authored migration(s) replayed against a populated scope)');
    // node:sqlite's experimental notice is swallowed for that one import: it is noise in a push log.
    expect(r.stderr).not.toContain('ExperimentalWarning');
  });

  it('a vertical with no kernel to replay through is pushed with a loud SKIPPED — and refused when the check is required', () => {
    const dir = vertical(helpdesk([INIT, DROP]));
    const r = pushRun(dir);
    expect(r.status).toBe(0);
    expect(uploaded(r.stdout)).toBe(true);
    expect(r.stderr).toContain('⚠ data-loss check: SKIPPED (no @substrat-run/kernel resolves from the vertical)');
    const strict = pushRun(dir, { requireDataLossCheck: true });
    expect(strict.status).not.toBe(0);
    expect(uploaded(strict.stdout)).toBe(false);
    expect(strict.stderr).toMatch(/--require-data-loss-check \(or SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=1\) refuses/);
  });

  it.runIf(adapterSqliteBuilt)("builds the spine from the vertical's own adapter-sqlite, so an authored read of it replays", () => {
    const reads = { version: '0002', sql: 'INSERT INTO ticket (id, title) SELECT id, type FROM _substrat_outbox;' };
    const without = pushRun(vertical(helpdesk([INIT, reads]), undefined, { kernel: true }));
    expect(without.status).toBe(0);
    expect(dataLoss(without.stdout)).toMatchObject({ status: 'incomplete', key: 'helpdesk@0002', notReplayed: 1, authored: 2 });
    expect(without.stderr).toContain('add @substrat-run/adapter-sqlite as a devDependency');
    const withSpine = pushRun(vertical(helpdesk([INIT, reads]), undefined, { kernel: true, adapterSqlite: true }));
    expect(withSpine.status).toBe(0);
    expect(dataLoss(withSpine.stdout)).toEqual({ status: 'passed', authored: 2 });
  });
});

describe.runIf(built && kernelBuilt)('push --check refuses the same tree', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const check = (dir: string, env: NodeJS.ProcessEnv = {}) => {
    const home = mkdtempSync(join(tmpdir(), 'substrat-cli-home-'));
    const r = spawnSync(process.execPath, [cli, 'push', dir, '--check', '--skip-lint'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, SUBSTRAT_CP_URL: '', ...env },
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  it('an undeclared destructive migration fails --check; the declared one passes', () => {
    const refused = check(vertical(helpdesk([INIT, DROP]), undefined, { kernel: true }));
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/data-loss check: REFUSED/);
    const passed = check(vertical(helpdesk([INIT, { ...DROP, discards: { ticket: 'replaced' } }]), undefined, { kernel: true }));
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain('data-loss check: PASSED');
  });

  it('SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=1 turns a skipped check into a failure of --check', () => {
    const dir = vertical(helpdesk([INIT]));
    expect(check(dir).status).toBe(0);
    const strict = check(dir, { SUBSTRAT_REQUIRE_DATA_LOSS_CHECK: '1' });
    expect(strict.status).not.toBe(0);
    expect(strict.stderr).toContain('data-loss check: SKIPPED');
  });
});

/**
 * The commands themselves, not `push()`: `substrat push` and `substrat preview create` each read
 * the switch off their own argv, and a command that forgot to pass it would push permissively
 * while the other refused. The platform fixture refuses an unchecked build only when the
 * serialized source request requires the check; command callers must forward that policy.
 */
describe.runIf(built)('the commands pass the strict switch to the push', () => {
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const command = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    // The vertical's own (fake) wrangler builds it: `vertical()` installs one.
    const scratch = mkdtempSync(join(tmpdir(), 'substrat-cli-cmd-'));
    const r = spawnSync(process.execPath, ['--input-type=module'], {
      input: `
        process.argv = [process.execPath, ${JSON.stringify(cli)}, ...${JSON.stringify(args)}, '--skip-lint'];
        globalThis.fetch = async (url, init) => {
          if (String(url).endsWith('/deploy')) {
            const source = JSON.parse(init.body);
            if (source.requireDataLossCheck) return Response.json({ detail: '--require-data-loss-check (or SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=1) refuses a push it could not fully check' }, { status: 422 });
            return Response.json({ id: 'v', admission: 'admitted', deploymentRef: 'r', verticalSlug: 'helpdesk', dataLoss: { status: 'skipped', why: 'fixture has no kernel' } });
          }
          return Response.json({ tag: 'pr-1', scopeId: 's', versionId: 'v', url: 'https://preview.example.test' });
        };
        await import(${JSON.stringify(new URL('../dist/cli.js', import.meta.url).href)});
      `,
      env: {
        ...process.env,
        HOME: scratch,
        USERPROFILE: scratch,
        GITHUB_ACTIONS: '',
        SUBSTRAT_CP_URL: 'http://127.0.0.1:9',
        SUBSTRAT_SERVICE_TOKEN: 'svc_test',
        SUBSTRAT_REQUIRE_DATA_LOSS_CHECK: '',
        ...env,
      },
      encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  // No kernel to replay through: SKIPPED, which the switch turns into a refusal.
  const unchecked = () => vertical(helpdesk([INIT]));
  const REFUSED = /--require-data-loss-check \(or SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=1\) refuses a push it could not fully check/;

  for (const [name, args] of [
    ['push', (dir: string) => ['push', dir, '--version', '1.0.0']],
    ['preview create', (dir: string) => ['preview', 'create', dir, '--tag', 'pr-1', '--version', '1.0.0-pr-1.1']],
  ] as const) {
    it(`${name}: --require-data-loss-check refuses an unchecked push; without it the push goes on`, () => {
      const strict = command([...args(unchecked()), '--require-data-loss-check']);
      expect(strict.status).not.toBe(0);
      expect(strict.out).toMatch(REFUSED);
      expect(strict.out).not.toContain('uploading');
      const permissive = command(args(unchecked()));
      expect(permissive.out).toContain('data-loss check: SKIPPED');
      expect(permissive.out).toContain('submitting source');
      expect(permissive.out).not.toMatch(REFUSED);
    });

    it(`${name}: SUBSTRAT_REQUIRE_DATA_LOSS_CHECK=true does the same`, () => {
      const strict = command(args(unchecked()), { SUBSTRAT_REQUIRE_DATA_LOSS_CHECK: 'true' });
      expect(strict.status).not.toBe(0);
      expect(strict.out).toMatch(REFUSED);
    });
  }
});
