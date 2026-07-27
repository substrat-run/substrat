import { describe, it, expect } from 'vitest';
import { deploymentRefFor, stableDeploymentRefFor, nextMigrationTag } from '../src/deploy.js';

/**
 * The dispatch script name must stay Cloudflare-safe (`[a-z0-9_-]`). A builder-owned
 * vertical's slug is `<tenant>/<name>` (builder-plane.md), so the `/` — and any other
 * stray char — has to flatten to `-`, while a bare platform slug is left as-is.
 */
describe('deploymentRefFor', () => {
  const V = '01KY713CDRSSD1G0N5411NAYXP';

  it('leaves a bare platform slug unchanged (backward-compatible)', () => {
    expect(deploymentRefFor('callout', V)).toBe(`callout-${V.toLowerCase()}`);
  });

  it('flattens a `<tenant>/<name>` slug to a script-safe ref', () => {
    expect(deploymentRefFor('acme/callout', V)).toBe(`acme-callout-${V.toLowerCase()}`);
  });

  it('is script-name-safe for any slug (only [a-z0-9_-] survives)', () => {
    expect(deploymentRefFor('Acme Inc/My.App', V)).toMatch(/^[a-z0-9_-]+$/);
  });
});

/**
 * The ONE stable serving script per vertical (#286): the name data lives under, so
 * it must be deterministic from the slug alone and can never collide with an
 * archive ref (those always end in `-<26-char ULID>`).
 */
describe('stableDeploymentRefFor', () => {
  it('is the sanitized slug, with no version component', () => {
    expect(stableDeploymentRefFor('callout')).toBe('callout');
    expect(stableDeploymentRefFor('acme/callout')).toBe('acme-callout');
    expect(stableDeploymentRefFor('Acme Inc/My.App')).toMatch(/^[a-z0-9_-]+$/);
  });

  it('never equals an archive ref for the same slug', () => {
    const v = '01KY713CDRSSD1G0N5411NAYXP';
    expect(stableDeploymentRefFor('callout')).not.toBe(deploymentRefFor('callout', v));
  });
});

describe('nextMigrationTag', () => {
  it('bumps vN → vN+1', () => {
    expect(nextMigrationTag('v1')).toBe('v2');
    expect(nextMigrationTag('v9')).toBe('v10');
  });

  it('treats an unrecognized tag as v1 (bumps to v2) rather than throwing', () => {
    expect(nextMigrationTag('weird')).toBe('v2');
  });
});
