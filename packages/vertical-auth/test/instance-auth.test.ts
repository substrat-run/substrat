import { describe, expect, it } from 'vitest';
import type { EnvVarSpec } from '@substrat-run/contracts';
import {
  AUTH_CONFIG_KEY,
  AuthConfigError,
  authorizationServersOf,
  instanceAuthFor,
  parseAuthChoice,
  selectAuthProvider,
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

/**
 * `authorizationServersOf` names the issuer this instance's configuration selected —
 * the `authorization_servers` an MCP endpoint publishes (RFC 9728).
 *
 * It restates `selectAuthProvider`'s precedence, so these cases exist to stop the two
 * from drifting: for every configuration that yields a provider, discovery must name an
 * issuer, and it must be the one that provider verifies against.
 */
describe('authorizationServersOf', () => {
  const settingsOf = (o: Record<string, string | undefined> = {}) => ({ AUTH_PROVIDER: undefined, OIDC_ISSUER: undefined, ...o });

  it('prefers a delivered choice over the deployment default, as provider selection does', () => {
    const opts = {
      identity: { mode: 'oidc' as const, issuer: 'https://delivered.example', clientId: 'c' },
      settings: settingsOf({ AUTH_PROVIDER: 'oidc', OIDC_ISSUER: 'https://deployment.example' }),
    };
    expect(authorizationServersOf(opts)).toEqual(['https://delivered.example']);
    // The provider agrees, which is the point of asserting both here.
    expect(() => selectAuthProvider({ ...opts, sessionSecret: 's' })).not.toThrow();
  });

  it('falls back to the deployment default', () => {
    expect(
      authorizationServersOf({ identity: null, settings: settingsOf({ AUTH_PROVIDER: 'oidc', OIDC_ISSUER: 'https://fixed.example' }) }),
    ).toEqual(['https://fixed.example']);
  });

  /**
   * DESCRIBES rather than refuses. `selectAuthProvider` throws here because a request
   * cannot proceed without a provider; metadata is a description, and an instance with
   * no login truthfully has no authorization server to name.
   */
  it('answers empty — never throws — where provider selection refuses', () => {
    const unconfigured = { identity: null, settings: settingsOf() };
    expect(authorizationServersOf(unconfigured)).toEqual([]);
    expect(() => selectAuthProvider({ ...unconfigured, sessionSecret: 's' })).toThrow(AuthConfigError);

    const halfConfigured = { identity: { mode: 'oidc' as const, clientId: 'c' }, settings: settingsOf() };
    expect(authorizationServersOf(halfConfigured)).toEqual([]);
    expect(() => selectAuthProvider({ ...halfConfigured, sessionSecret: 's' })).toThrow(AuthConfigError);
  });
});
