import { describe, expect, it } from 'vitest';
import type { EnvVarSpec } from '@substrat-run/contracts';
import {
  AUTH_CONFIG_KEY,
  AuthConfigError,
  instanceAuthFor,
  parseAuthChoice,
} from '../src/instance-auth.js';

/** The auth half of a vertical's declared env — the shape all four demos share. */
const ENV_SPEC: EnvVarSpec[] = [
  { key: 'AUTH_PROVIDER', label: 'Auth provider', description: 'Which auth the app runs', default: 'oidc', required: false, secret: false },
  { key: 'OIDC_ISSUER', label: 'OIDC issuer', description: 'The issuer bearer tokens are verified against', required: false, secret: false },
  { key: 'OIDC_AUDIENCE', label: 'OIDC audience', description: 'Expected `aud` claim', required: false, secret: false },
];

/** A stand-in for the tenant's identity DO: one delivered map, one session secret. */
const directoryOf = (config: Record<string, string>) => ({
  authWiring: async () => ({ config, sessionSecret: 'a-session-secret' }),
});

const call = (config: Record<string, string>, env: Record<string, unknown> = {}) =>
  instanceAuthFor({ directory: directoryOf(config), scopeId: 'scope-1', envSpec: ENV_SPEC, env });

describe('instanceAuthFor', () => {
  it('resolves declared settings delivered > binding > manifest default', async () => {
    // The bug this replaces (#374/#972): a spec `default` rides as a worker binding shared
    // by every install of one serving script, so reading `env` alone hands every tenant the
    // same issuer no matter what any of them saved.
    const { settings } = await call(
      { OIDC_ISSUER: 'https://saved-per-install.example' },
      { OIDC_ISSUER: 'https://the-shared-binding.example', OIDC_AUDIENCE: 'https://api.example' },
    );
    expect(settings.OIDC_ISSUER).toBe('https://saved-per-install.example');
    expect(settings.OIDC_AUDIENCE).toBe('https://api.example'); // the binding, nothing delivered
    expect(settings.AUTH_PROVIDER).toBe('oidc'); // the manifest default, nothing overriding
  });

  it('builds the relying-party provider from a delivered substrat:auth', async () => {
    const instance = await call({
      [AUTH_CONFIG_KEY]: JSON.stringify({
        mode: 'oidc',
        issuer: 'https://issuer.example',
        clientId: 'client-1',
        clientSecret: 'shh',
      }),
    });
    expect(instance.identity?.issuer).toBe('https://issuer.example');
    expect(instance.sessionSecret).toBe('a-session-secret');
    const provider = instance.provider();
    expect(typeof provider.resolve).toBe('function');
    expect(typeof provider.handle).toBe('function');
  });

  it('refuses a half-delivered choice with a 503, not a crash', async () => {
    const instance = await call({
      [AUTH_CONFIG_KEY]: JSON.stringify({ mode: 'oidc', issuer: 'https://issuer.example' }),
    });
    expect(() => instance.provider()).toThrowError(
      expect.objectContaining({ status: 503, name: 'AuthConfigError' }),
    );
  });

  it('falls back to the deployment default when nothing is delivered', async () => {
    const instance = await call({}, { AUTH_PROVIDER: 'oidc', OIDC_ISSUER: 'https://fixed.example' });
    expect(instance.identity).toBeNull();
    expect(typeof instance.provider().resolve).toBe('function');
  });

  it('fails closed on AUTH_PROVIDER=oidc with no issuer — an operator mistake, so 500', async () => {
    // This check existed only in meridian's copy. It is the shared default now.
    const instance = await call({}, { AUTH_PROVIDER: 'oidc' });
    try {
      instance.provider();
      expect.unreachable('an unset issuer must not yield a provider');
    } catch (err) {
      expect(err).toBeInstanceOf(AuthConfigError);
      expect((err as AuthConfigError).status).toBe(500);
    }
  });

  it('is unconfigured — 503 — when there is neither a choice nor a deployment issuer', async () => {
    const instance = await call({}, { AUTH_PROVIDER: 'none' });
    expect(() => instance.provider()).toThrowError(expect.objectContaining({ status: 503 }));
  });

  it('reading settings never fails because auth is unconfigured', async () => {
    // A route that only wants a declared setting must not 503 because nobody has picked an
    // identity provider yet — which is why `provider` is a function and not a field.
    const instance = await call({ OIDC_AUDIENCE: 'https://api.example' }, { AUTH_PROVIDER: 'none' });
    expect(instance.settings.OIDC_AUDIENCE).toBe('https://api.example');
  });
});

describe('parseAuthChoice', () => {
  it('reads anything unusable as "nothing delivered" rather than throwing', () => {
    // Lenient on purpose: a bad delivery falls back to the deployment default instead of
    // locking an instance out of its own login.
    expect(parseAuthChoice(undefined)).toBeNull();
    expect(parseAuthChoice('{not json')).toBeNull();
    expect(parseAuthChoice(JSON.stringify({ mode: 'builtin' }))).toBeNull();
    expect(parseAuthChoice(JSON.stringify({ mode: 'oidc', issuer: 'not-a-url' }))).toBeNull();
  });
});
