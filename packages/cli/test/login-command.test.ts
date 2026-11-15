import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliConfig } from '../src/config.js';
import { LOGIN_HOW_TO_SET, loginWorkspace } from '../src/login.js';

/**
 * `substrat login` with no TTY — an agent, piped stdin, some Windows terminals. readline
 * closed on EOF without answering its question, so the login awaited a prompt that could
 * never settle, Node exited 0 with nothing saved, and the next command failed with "no
 * control-plane URL". Run through the BUILT CLI with stdin a closed pipe: the patched
 * `spawn` plays the browser (it completes the loopback callback from the URL it was handed)
 * and the patched `fetch` plays the control plane (token exchange + whoami).
 *
 * A run starts the whole CLI in a fresh Node, seconds on a CI runner, so only what needs a
 * process is run that way: that nothing waits on a prompt nobody can answer, and the exit
 * code. Which default workspace a login stores is `loginWorkspace`'s, tested in-process below.
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
  it('with no --cp and several workspaces, asks nothing: uses the public plane, says so, and saves the session', () => {
    const r = login(['--fresh'], [tenantA, tenantB]);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toContain('control-plane URL: https://console.substrat.net/api');
    expect(r.fetched).toContain('https://console.substrat.net/api/auth/cli/token');
    expect(r.config).toMatchObject({ controlPlaneUrl: 'https://console.substrat.net/api', bearerToken: 'session-token' });
    expect(r.config).not.toHaveProperty('defaultTenant');
    expect(r.stdout).not.toContain('default workspace [');
    expect(r.stdout).toContain('substrat login --workspace <slug>');

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

  it('an unknown --workspace keeps the stored control-plane URL, still saves the session, lists the valid slugs, and exits non-zero', () => {
    const r = login(['--workspace', 'nope'], [tenantA, tenantB], { controlPlaneUrl: 'https://cp.example/api' });
    expect(r.status, out(r)).not.toBe(0);
    expect(r.fetched).toContain('https://cp.example/api/auth/cli/token');
    expect(r.config).toMatchObject({ controlPlaneUrl: 'https://cp.example/api', bearerToken: 'session-token' });
    expect(r.config).not.toHaveProperty('defaultTenant');
    expect(r.stderr).toMatch(/error: 'nope' is not one of your workspaces/);
    expect(r.stderr).toContain('tenant-a, tenant-b');
  });
});

describe('the default workspace a login stores', () => {
  const choose = async (tenants: (typeof tenantA)[], opts: { wanted?: string; storedDefault?: string } = {}) => {
    const lines: string[] = [];
    const result = await loginWorkspace({ wanted: opts.wanted, tenants, signedIn: true, storedDefault: opts.storedDefault, pick: undefined, log: (line) => lines.push(line) });
    return { ...result, lines };
  };

  it.each([
    ['one workspace: stores it', [tenantA], {}, 'tenant-a'],
    ['no workspaces: clears an earlier default', [], { storedDefault: 'tenant-a' }, undefined],
    ['several, none chosen: sets none', [tenantA, tenantB], {}, undefined],
    ["several, none chosen: keeps this account's earlier default", [tenantA, tenantB], { storedDefault: 'tenant-b' }, 'tenant-b'],
    ["several, none chosen: clears another account's earlier default", [tenantA, tenantB], { storedDefault: 'other-co' }, undefined],
    ['--workspace <slug> stores it', [tenantA, tenantB], { wanted: 'tenant-b' }, 'tenant-b'],
    ['--workspace <id> stores the slug', [tenantA, tenantB], { wanted: 'ten_b' }, 'tenant-b'],
  ] as const)('%s', async (_, tenants, opts, expected) => {
    const r = await choose([...tenants], opts);
    expect(r.defaultTenant).toBe(expected);
    expect(r.refused).toBeUndefined();
  });

  it('several, none chosen, prints the list and how to choose', async () => {
    const r = await choose([tenantA, tenantB]);
    expect(r.lines).toEqual(['  you belong to several workspaces:', '    1. Tenant A  [tenant-a]', '    2. Tenant B  [tenant-b]', '  no default workspace set (none chosen).', LOGIN_HOW_TO_SET]);
  });

  it('an unknown --workspace is refused, naming the valid slugs, and keeps the earlier default', async () => {
    const r = await choose([tenantA, tenantB], { wanted: 'nope', storedDefault: 'tenant-a' });
    expect(r.defaultTenant).toBe('tenant-a');
    expect(r.refused).toBe("'nope' is not one of your workspaces (yours: tenant-a, tenant-b) — signed in, default workspace stays 'tenant-a'");
  });
});
