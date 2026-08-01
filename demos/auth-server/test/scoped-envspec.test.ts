import { describe, it, expect } from 'vitest';
import { resolveScopedEnvSpec, type EnvVarSpec } from '@substrat-run/contracts';

/**
 * The shared merge behind a hosted vertical's per-scope config read (#398): the deployment
 * env overlaid with the config DELIVERED to one instance, precedence delivered > env >
 * default. auth-server's `effectiveCfg` is a caller; these lock the contract itself.
 */
const spec: EnvVarSpec[] = [
  { key: 'SUPABASE_URL', description: 'db url', required: true, secret: false, default: 'https://default.supabase.co' },
  { key: 'PUBLIC_ORIGIN', description: 'origin', required: false, secret: false },
  { key: 'ADMIN_EMAIL', description: 'first admin', required: true, secret: false },
  { key: 'SUPABASE_JWT_SECRET', description: 'verify secret', required: false, secret: true },
];

describe('resolveScopedEnvSpec — delivered > env > default', () => {
  it('a delivered value overrides the env binding (the per-install override the #374 case needed)', () => {
    const { values } = resolveScopedEnvSpec(
      spec,
      { SUPABASE_URL: 'https://env.supabase.co' },
      { SUPABASE_URL: 'https://tenant.supabase.co' },
    );
    expect(values.SUPABASE_URL).toBe('https://tenant.supabase.co');
  });

  it('falls back to env when nothing was delivered, and to the default when neither is set', () => {
    const { values } = resolveScopedEnvSpec(spec, { PUBLIC_ORIGIN: 'https://env.origin' }, {});
    expect(values.PUBLIC_ORIGIN).toBe('https://env.origin'); // env, no delivered
    expect(values.SUPABASE_URL).toBe('https://default.supabase.co'); // neither → default
  });

  it('treats an empty delivered value as no override (keeps env/default), like resolveEnvSpec', () => {
    const { values } = resolveScopedEnvSpec(spec, { SUPABASE_URL: 'https://env.supabase.co' }, { SUPABASE_URL: '' });
    expect(values.SUPABASE_URL).toBe('https://env.supabase.co');
  });

  it('ignores a delivered key the manifest does not declare — the spec stays the allow-list', () => {
    const { values } = resolveScopedEnvSpec(spec, {}, { NOT_DECLARED: 'leak' } as Record<string, string>);
    expect(values).not.toHaveProperty('NOT_DECLARED');
  });

  it('overlays a secret key exactly like any other declared key', () => {
    const { values } = resolveScopedEnvSpec(spec, {}, { SUPABASE_JWT_SECRET: 'delivered-secret' });
    expect(values.SUPABASE_JWT_SECRET).toBe('delivered-secret');
  });

  it('recomputes missingRequired over the overlaid values: delivered can satisfy a required key env missed', () => {
    const missing = resolveScopedEnvSpec(spec, {}, {}).missingRequired;
    expect(missing).toContain('ADMIN_EMAIL'); // required, no env, no delivered, no default
    expect(missing).not.toContain('SUPABASE_URL'); // required but has a default

    const satisfied = resolveScopedEnvSpec(spec, {}, { ADMIN_EMAIL: 'root@acme.test' }).missingRequired;
    expect(satisfied).not.toContain('ADMIN_EMAIL');
  });
});
