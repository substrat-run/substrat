import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliConfig } from '../src/config.js';

/**
 * `substrat login` with no TTY — an agent, piped stdin, some Windows terminals. readline
 * closed on EOF without answering its question, so the login awaited a prompt that could
 * never settle, Node exited 0 with nothing saved, and the next command failed with "no
 * control-plane URL". Run through the BUILT CLI with stdin a closed pipe: the patched
 * `spawn` plays the browser (it completes the loopback callback from the URL it was handed)
 * and the patched `fetch` plays the control plane (token exchange + whoami).
 */

const cli = new URL('../dist/cli.js', import.meta.url).href;
const tenantA = { id: 'ten_a', slug: 'tenant-a', name: 'Tenant A' };
const tenantB = { id: 'ten_b', slug: 'tenant-b', name: 'Tenant B' };

let home: string;
beforeEach(() => {
  // A home path with a space and a non-ASCII letter, as real Windows profiles have.
  home = mkdtempSync(join(tmpdir(), 'home dir å-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  opened: { cmd: string; args: string[] }[];
  fetched: string[];
  config: CliConfig | null;
}

function login(args: string[], tenants: (typeof tenantA)[], existing?: CliConfig): Run {
  if (existing) {
    mkdirSync(join(home, '.substrat'), { recursive: true });
    writeFileSync(join(home, '.substrat', 'config.json'), JSON.stringify(existing));
  }
  const result = spawnSync(process.execPath, ['--input-type=module'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, SUBSTRAT_CP_URL: '', SUBSTRAT_TENANT: '' },
    input: `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import http from 'node:http';
      process.argv = [process.execPath, ${JSON.stringify(cli)}, 'login', ...${JSON.stringify(args)}];
      // The script itself arrives on stdin; once read, the CLI sees a closed, non-TTY stdin.
      cp.spawn = (cmd, argv) => {
        console.log('OPENED ' + JSON.stringify({ cmd, args: argv }));
        const auth = new URL(argv[argv.length - 1]);
        const back = 'http://127.0.0.1:' + auth.searchParams.get('port') + '/callback?code=c0de&state=' + encodeURIComponent(auth.searchParams.get('state'));
        http.get(back, (res) => res.resume());
        return { on() { return this; }, unref() {} };
      };
      syncBuiltinESMExports();
      globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url ?? String(input);
        console.log('FETCHED ' + url);
        if (url.endsWith('/auth/cli/token')) return Response.json({ token: 'session-token' });
        if (url.endsWith('/auth/whoami')) return Response.json({ user: { id: 'u1', email: 'builder@example.com' }, tenants: ${JSON.stringify(tenants)} });
        return new Response('unexpected', { status: 404 });
      };
      await import(${JSON.stringify(cli)});
    `,
  });
  const lines = (prefix: string) =>
    result.stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith(prefix))
      .map((l) => l.slice(prefix.length));
  const configPath = join(home, '.substrat', 'config.json');
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    opened: lines('OPENED ').map((l) => JSON.parse(l) as { cmd: string; args: string[] }),
    fetched: lines('FETCHED '),
    config: existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')) as CliConfig) : null,
  };
}

const out = (r: Run) => r.stdout + r.stderr;

describe('substrat login without a TTY', () => {
  it('with no --cp, uses the public plane, says so, and saves the session', () => {
    const r = login(['--fresh'], [tenantA]);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toContain('control-plane URL: https://console.substrat.net/api');
    expect(r.fetched).toContain('https://console.substrat.net/api/auth/cli/token');
    expect(r.config).toMatchObject({ controlPlaneUrl: 'https://console.substrat.net/api', bearerToken: 'session-token', defaultTenant: 'tenant-a' });

    // The browser got the whole authorize URL: state and challenge intact, as one argument.
    expect(r.opened).toHaveLength(1);
    const auth = r.opened[0]!.args.filter((a) => a.includes('/auth/cli'));
    expect(auth).toHaveLength(1);
    const sent = new URL(auth[0]!);
    expect(sent.origin + sent.pathname).toBe('https://console.substrat.net/api/auth/cli');
    expect(sent.searchParams.get('state')).toMatch(/^[\w-]{16,}$/);
    expect(sent.searchParams.get('challenge')).toMatch(/^[\w-]{43}$/); // base64url SHA-256
    expect(sent.searchParams.get('fresh')).toBe('1');
    expect(r.opened[0]!.cmd).not.toMatch(/^cmd(\.exe)?$/i);
  });

  it('with no --cp, keeps the stored control-plane URL', () => {
    const r = login([], [tenantA], { controlPlaneUrl: 'https://cp.example/api' });
    expect(r.status, out(r)).toBe(0);
    expect(r.fetched).toContain('https://cp.example/api/auth/cli/token');
    expect(r.config).toMatchObject({ controlPlaneUrl: 'https://cp.example/api', bearerToken: 'session-token' });
  });

  it('one workspace: stores it as the default', () => {
    const r = login(['--cp', 'https://cp.example/api'], [tenantA]);
    expect(r.status, out(r)).toBe(0);
    expect(r.config).toMatchObject({ controlPlaneUrl: 'https://cp.example/api', bearerToken: 'session-token', defaultTenant: 'tenant-a' });
  });

  it('several workspaces, no --workspace: saves the session, asks nothing, prints how to choose', () => {
    const r = login(['--cp', 'https://cp.example/api'], [tenantA, tenantB]);
    expect(r.status, out(r)).toBe(0);
    expect(r.config).toMatchObject({ bearerToken: 'session-token' });
    expect(r.config).not.toHaveProperty('defaultTenant');
    expect(r.stdout).not.toContain('default workspace [');
    expect(r.stdout).toContain('substrat login --workspace <slug>');
    expect(r.stdout).toContain('SUBSTRAT_TENANT');
  });

  it("several workspaces, no --workspace: keeps an earlier default only when it is this account's", () => {
    const own = login(['--cp', 'https://cp.example/api'], [tenantA, tenantB], { defaultTenant: 'tenant-b' });
    expect(own.status, out(own)).toBe(0);
    expect(own.config).toMatchObject({ bearerToken: 'session-token', defaultTenant: 'tenant-b' });

    rmSync(join(home, '.substrat'), { recursive: true, force: true });
    const foreign = login(['--cp', 'https://cp.example/api'], [tenantA, tenantB], { defaultTenant: 'other-co' });
    expect(foreign.status, out(foreign)).toBe(0);
    expect(foreign.config).toMatchObject({ bearerToken: 'session-token' });
    expect(foreign.config).not.toHaveProperty('defaultTenant');
  });

  it('--workspace <slug> stores that default without asking', () => {
    const r = login(['--cp', 'https://cp.example/api', '--workspace', 'tenant-b'], [tenantA, tenantB]);
    expect(r.status, out(r)).toBe(0);
    expect(r.config).toMatchObject({ bearerToken: 'session-token', defaultTenant: 'tenant-b' });
    expect(r.stdout).not.toContain('default workspace [');
  });

  it('--workspace <id> stores the slug', () => {
    const r = login(['--cp', 'https://cp.example/api', '--workspace', 'ten_b'], [tenantA, tenantB]);
    expect(r.status, out(r)).toBe(0);
    expect(r.config).toMatchObject({ defaultTenant: 'tenant-b' });
  });

  it('an unknown --workspace still saves the session, lists the valid slugs, and exits non-zero', () => {
    const r = login(['--cp', 'https://cp.example/api', '--workspace', 'nope'], [tenantA, tenantB]);
    expect(r.status, out(r)).not.toBe(0);
    expect(r.config).toMatchObject({ controlPlaneUrl: 'https://cp.example/api', bearerToken: 'session-token' });
    expect(r.config).not.toHaveProperty('defaultTenant');
    expect(r.stderr).toMatch(/error: 'nope' is not one of your workspaces/);
    expect(r.stderr).toContain('tenant-a, tenant-b');
  });
});
