import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { MERIDIAN_ENV } from '../src/manifest.js';

/**
 * `substrat push` reads the env-spec off the permissions entry's `envSpec` export (#1206),
 * so `src/manifest.ts` is the single declaration: the worker reads `MERIDIAN_ENV` through
 * `resolveScopedEnvSpec`, and the push uploads the same object. What this guards is the
 * wiring — the entry actually re-exporting the manifest's spec — and that nobody
 * reintroduces a `package.json` copy for an old CLI to read instead.
 */
describe('envSpec is declared once (#1206)', () => {
  it('the permissions entry re-exports MERIDIAN_ENV as envSpec — what push uploads', async () => {
    const { envSpec } = await import('../src/provision.js');
    expect(envSpec).toBe(MERIDIAN_ENV);
  });

  it('package.json carries no substrat.envSpec copy', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      substrat?: { envSpec?: unknown[] };
    };
    expect(pkg.substrat?.envSpec).toBeUndefined();
  });

  it('package.json substrat.requires matches the manifest requires (#427)', async () => {
    const { meridianManifest } = await import('../src/manifest.js');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      substrat?: { requires?: string[] };
    };
    expect(pkg.substrat?.requires ?? []).toEqual(meridianManifest.requires ?? []);
  });
});
