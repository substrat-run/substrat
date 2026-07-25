import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { envVarSpec } from '@substrat-run/contracts';
import { AUTH_SERVER_ENV } from '../src/manifest.js';

/**
 * `substrat push` carries the env-spec from `package.json` `substrat.envSpec` (it reads JSON,
 * not TS), while the DO + dev server read `AUTH_SERVER_ENV` from `src/manifest.ts`. This guard
 * fails the build if the two ever drift, so the dashboard's config form and what the issuer
 * actually reads can never disagree.
 */
describe('envSpec is declared once', () => {
  it('package.json substrat.envSpec matches AUTH_SERVER_ENV', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      substrat?: { envSpec?: unknown[] };
    };
    const declared = envVarSpec.array().parse(pkg.substrat?.envSpec ?? []);
    expect(declared).toEqual(AUTH_SERVER_ENV);
  });
});
