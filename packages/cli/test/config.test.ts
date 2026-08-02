import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAuth } from '../src/config.js';

/**
 * Auth-precedence transparency (#387): SUBSTRAT_SERVICE_TOKEN outranks a stored browser
 * session, and used to do so SILENTLY — a leftover env var (even a copy-paste
 * placeholder) turned a fresh `substrat login` into inexplicable 401s. The precedence
 * itself must not change (CI relies on the env var winning); what changes is that the
 * CLI says which credential is in use and flags an obvious placeholder.
 */
describe('resolveAuth (#387 shadowed-auth warnings)', () => {
  let home: string;
  let warned: string[];
  const ENV_KEYS = ['SUBSTRAT_SERVICE_TOKEN', 'SUBSTRAT_CP_URL', 'SUBSTRAT_TENANT', 'HOME'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    home = mkdtempSync(join(tmpdir(), 'cli-auth-'));
    process.env.HOME = home; // os.homedir() reads $HOME on posix — the config lives under it
    delete process.env.SUBSTRAT_SERVICE_TOKEN;
    delete process.env.SUBSTRAT_CP_URL;
    delete process.env.SUBSTRAT_TENANT;
    warned = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      warned.push(args.join(' '));
    });
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  const storeConfig = (cfg: Record<string, string>) => {
    mkdirSync(join(home, '.substrat'), { recursive: true });
    writeFileSync(join(home, '.substrat', 'config.json'), JSON.stringify(cfg));
  };

  it('says when SUBSTRAT_SERVICE_TOKEN shadows a stored login session — precedence unchanged', () => {
    storeConfig({ controlPlaneUrl: 'https://cp/api', bearerToken: 'sess-123' });
    process.env.SUBSTRAT_SERVICE_TOKEN = 'svc-abcdef';
    const auth = resolveAuth({});
    // The env token still wins (CI behavior), but no longer silently.
    expect(auth.kind).toBe('service');
    expect(auth.header['x-service-token']).toBe('svc-abcdef');
    expect(warned.join('\n')).toMatch(/SUBSTRAT_SERVICE_TOKEN.*session is ignored/s);
  });

  it('flags an obvious copy-paste placeholder token', () => {
    storeConfig({ controlPlaneUrl: 'https://cp/api' });
    process.env.SUBSTRAT_SERVICE_TOKEN = 'sk_live_…';
    const auth = resolveAuth({});
    expect(auth.kind).toBe('service');
    expect(warned.join('\n')).toMatch(/looks like a placeholder/);
  });

  it('stays quiet for an explicit --token and for a plain env token with no stored session', () => {
    storeConfig({ controlPlaneUrl: 'https://cp/api', bearerToken: 'sess-123' });
    resolveAuth({ token: 'svc-explicit' }); // typed intent — no nagging
    expect(warned).toEqual([]);

    storeConfig({ controlPlaneUrl: 'https://cp/api' }); // CI shape: env token, no session
    process.env.SUBSTRAT_SERVICE_TOKEN = 'svc-ci';
    resolveAuth({});
    expect(warned).toEqual([]);
  });

  it('sends the workspace header with a service token too (#417)', () => {
    storeConfig({ controlPlaneUrl: 'https://cp/api' });
    process.env.SUBSTRAT_SERVICE_TOKEN = 'svc-ci';
    const auth = resolveAuth({ tenant: 'acme-co' });
    expect(auth.header['x-substrat-tenant']).toBe('acme-co');
    expect(auth.as).toContain('acme-co');
  });
});
