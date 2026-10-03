import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { ulid } from '@substrat-run/kernel';
import { PLATFORM_FEATURES_HEADER, PLATFORM_FEATURE_SCOPE_SWEEPER, platformActorId } from '@substrat-run/contracts';
import {
  createControlPlaneApi,
  CLI_LATEST_VERSION_HEADER,
  CLI_MIN_VERSION_HEADER,
  DEV_ACTOR_HEADER,
  UNSAFE_devPlatformActorAuth,
} from '../src/index.js';

/**
 * The CLI version advisory (#971). `packages/cli/src/version.ts` reads two headers off
 * every control-plane response to nudge a builder whose CLI has fallen behind; before
 * this, no server set them. The contract is small and the absence half matters as much
 * as the presence half: a deployment that configures nothing must emit nothing.
 */
describe('CLI version advisory headers', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());
  const auth = { [DEV_ACTOR_HEADER]: staff };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-cli-advisory-'));
    host = new SqliteScopeHost({ dir });
  });

  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('spells the headers the way the CLI reads them', () => {
    // The CLI keeps its own constants (it does not depend on this package); this pins the
    // two spellings together so a rename on either side is a red test, not a silent no-op.
    expect(CLI_MIN_VERSION_HEADER).toBe('x-substrat-cli-min-version');
    expect(CLI_LATEST_VERSION_HEADER).toBe('x-substrat-cli-latest-version');
  });

  it('emits both headers on every response when configured — including a 401', async () => {
    const app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      cliAdvisory: { minVersion: '0.20.0', latestVersion: '0.27.3' },
    });

    const ok = await app.request('/tenants', { headers: auth });
    expect(ok.status).toBe(200);
    expect(ok.headers.get(CLI_MIN_VERSION_HEADER)).toBe('0.20.0');
    expect(ok.headers.get(CLI_LATEST_VERSION_HEADER)).toBe('0.27.3');

    // A CLI too old to authenticate is exactly the one that needs to hear it.
    const refused = await app.request('/tenants');
    expect(refused.status).toBe(401);
    expect(refused.headers.get(CLI_MIN_VERSION_HEADER)).toBe('0.20.0');
    expect(refused.headers.get(CLI_LATEST_VERSION_HEADER)).toBe('0.27.3');

    // And on a route that does not exist — the middleware wraps the whole surface.
    const missing = await app.request('/no-such-route', { headers: auth });
    expect(missing.status).toBe(404);
    expect(missing.headers.get(CLI_LATEST_VERSION_HEADER)).toBe('0.27.3');
  });

  it('emits only the half that is configured', async () => {
    const app = createControlPlaneApi({
      host,
      authenticate: UNSAFE_devPlatformActorAuth(),
      cliAdvisory: { latestVersion: '0.27.3' },
    });
    const res = await app.request('/tenants', { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.has(CLI_MIN_VERSION_HEADER)).toBe(false);
    expect(res.headers.get(CLI_LATEST_VERSION_HEADER)).toBe('0.27.3');
  });

  it('emits nothing when unconfigured — the pre-#971 shape, byte for byte', async () => {
    for (const cliAdvisory of [undefined, {}]) {
      const app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth(), cliAdvisory });
      const res = await app.request('/tenants', { headers: auth });
      expect(res.status).toBe(200);
      expect(res.headers.has(CLI_MIN_VERSION_HEADER)).toBe(false);
      expect(res.headers.has(CLI_LATEST_VERSION_HEADER)).toBe(false);
    }
  });
});

/**
 * #1902: the capability half of the same handshake. A CLI leaves a vertical's sweeper out
 * only when the plane says it supplies one, so the plane must say it on every answer the CLI
 * might read first — a refusal and a miss included — and unconfigured, since it is a fact
 * about this code.
 */
describe('the platform features header (#1902)', () => {
  let dir: string;
  let host: SqliteScopeHost;
  const staff = platformActorId.parse(ulid());

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-features-'));
    host = new SqliteScopeHost({ dir });
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the scope sweeper on a success, a 401 and a 404, with nothing configured', async () => {
    const app = createControlPlaneApi({ host, authenticate: UNSAFE_devPlatformActorAuth() });
    const answers = [
      await app.request('/tenants', { headers: { [DEV_ACTOR_HEADER]: staff } }),
      await app.request('/verticals/nope/versions?limit=1'),
      await app.request('/no-such-route', { headers: { [DEV_ACTOR_HEADER]: staff } }),
    ];
    expect(answers.map((r) => r.status)).toEqual([200, 401, 404]);
    for (const r of answers) expect(r.headers.get(PLATFORM_FEATURES_HEADER)).toBe(PLATFORM_FEATURE_SCOPE_SWEEPER);
  });
});
