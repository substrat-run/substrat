import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { AUTH_SERVER_ENV, AUTH_SERVER_PROVIDES } from '../src/manifest.js';

/**
 * `substrat push` reads the env-spec off the permissions entry's `envSpec` export (#1206),
 * so `src/manifest.ts` is the single declaration: the DO + dev server read
 * `AUTH_SERVER_ENV`, and the push uploads the same object. What this guards is the wiring —
 * the entry actually re-exporting the manifest's spec — and that nobody reintroduces a
 * `package.json` copy for an old CLI to read instead.
 */
describe('envSpec is declared once (#1206)', () => {
  it('the permissions entry re-exports AUTH_SERVER_ENV as envSpec — what push uploads', async () => {
    const { envSpec } = await import('../src/permissions.js');
    expect(envSpec).toBe(AUTH_SERVER_ENV);
  });

  it('package.json carries no substrat.envSpec copy', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      substrat?: { envSpec?: unknown[] };
    };
    expect(pkg.substrat?.envSpec).toBeUndefined();
  });

  it('package.json substrat.provides matches AUTH_SERVER_PROVIDES (#427)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      substrat?: { provides?: string[] };
    };
    expect(pkg.substrat?.provides ?? []).toEqual(AUTH_SERVER_PROVIDES);
  });
});
