import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { envVarSpec } from '@substrat-run/contracts';
import { MERIDIAN_ENV } from '../src/manifest.js';

/**
 * `substrat push` carries the env-spec from `package.json` `substrat.envSpec` (it reads JSON,
 * not TS), while the worker reads `MERIDIAN_ENV` from `src/manifest.ts` through
 * `resolveScopedEnvSpec`. This guard fails the build if the two ever drift, so the dashboard's
 * Env-tab form and what the worker actually reads can never disagree.
 */
describe('envSpec is declared once', () => {
  it('package.json substrat.envSpec matches MERIDIAN_ENV', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      substrat?: { envSpec?: unknown[] };
    };
    const declared = envVarSpec.array().parse(pkg.substrat?.envSpec ?? []);
    expect(declared).toEqual(MERIDIAN_ENV);
  });

  it('package.json substrat.requires matches the manifest requires (#427)', async () => {
    const { meridianManifest } = await import('../src/manifest.js');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      substrat?: { requires?: string[] };
    };
    expect(pkg.substrat?.requires ?? []).toEqual(meridianManifest.requires ?? []);
  });
});
