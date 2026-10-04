/**
 * A declared env var cannot name the platform's injected namespace (#1331): a vertical
 * whose settings form could set a `SUBSTRAT_` value would be speaking for the platform.
 */
import { describe, expect, it } from 'vitest';
import { envVarSpec, PLATFORM_BINDING_PREFIX } from '../src/index.js';

describe('envVarSpec keys', () => {
  it('refuses a key in the platform namespace', () => {
    for (const key of ['SUBSTRAT_FIELD_COVERAGE', 'SUBSTRAT_VERSION_ID', `${PLATFORM_BINDING_PREFIX}ANYTHING`]) {
      const parsed = envVarSpec.safeParse({ key, description: 'x' });
      expect(parsed.success, key).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).toContain('platform');
    }
  });

  it('accepts an ordinary key, and one that merely contains the word', () => {
    for (const key of ['ADMIN_PASSWORD', 'MY_SUBSTRAT_TOKEN', 'SUBSTRATE']) {
      expect(envVarSpec.safeParse({ key, description: 'x' }).success, key).toBe(true);
    }
  });
});
