import { describe, it, expect } from 'vitest';
import type { DeclaredBinding, DeployManifest } from '@substrat-run/contracts';
import {
  assertSandboxContract,
  deploymentRefFor,
  stableDeploymentRefFor,
  nextMigrationTag,
} from '../src/deploy.js';

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

/**
 * §4 sandbox contract: a positive allowlist. Own resources pass; anything the list doesn't
 * name is refused by omission, with a message that names the binding and its type.
 */
describe('assertSandboxContract', () => {
  const manifest = (bindings: DeclaredBinding[], doClasses: string[] = ['ScopeDO']): DeployManifest => ({
    version: '1.0.0',
    entry: 'worker.js',
    compatibilityDate: '2025-01-01',
    compatibilityFlags: [],
    doClasses,
    bindings,
    digests: { manifest: 'm', permission: 'p', migration: 'g' },
  });
  const ok = (bindings: DeclaredBinding[], doClasses?: string[]) =>
    expect(() => assertSandboxContract(manifest(bindings, doClasses))).not.toThrow();
  const refused = (bindings: DeclaredBinding[], doClasses?: string[]) =>
    () => assertSandboxContract(manifest(bindings, doClasses));

  it('admits a vertical binding its OWN DO class', () => {
    ok([{ type: 'durable_object_namespace', name: 'SCOPE', class_name: 'ScopeDO' }]);
  });

  it('admits own data stores: d1, kv, queue, r2, analytics, and inert config', () => {
    ok([
      { type: 'd1', name: 'AUTH_DB', id: 'db-123' },
      { type: 'kv_namespace', name: 'CACHE' },
      { type: 'queue', name: 'JOBS' },
      { type: 'r2_bucket', name: 'FILES' },
      { type: 'analytics_engine', name: 'METRICS' },
      { type: 'secret_text', name: 'API_KEY' },
      { type: 'plain_text', name: 'REGION' },
    ]);
  });

  it("refuses the CONTROL_PLANE binding by name, whatever type it claims", () => {
    expect(refused([{ type: 'durable_object_namespace', name: 'CONTROL_PLANE', class_name: 'ScopeDO' }])).toThrow(
      /CONTROL_PLANE/,
    );
    // even masquerading as an admissible inert type
    expect(refused([{ type: 'plain_text', name: 'CONTROL_PLANE' }])).toThrow(/CONTROL_PLANE/);
  });

  it('refuses a service binding — a vertical reaches the platform via the router (K-27)', () => {
    expect(refused([{ type: 'service', name: 'CP' }])).toThrow(/router \(K-27\)/);
  });

  it("refuses the platform's dispatch namespace", () => {
    expect(refused([{ type: 'dispatch_namespace', name: 'VERTICALS' }])).toThrow(/Workers-for-Platforms/);
  });

  it('refuses an unrecognized binding type by omission (allowlist, not denylist)', () => {
    expect(refused([{ type: 'hyperdrive', name: 'PG' }])).toThrow(/not an admissible own-resource binding type/);
  });

  it('refuses a cross-script DO binding', () => {
    expect(
      refused([{ type: 'durable_object_namespace', name: 'X', class_name: 'ScopeDO', script_name: 'substrat-control-plane' }]),
    ).toThrow(/cross-script/);
  });

  it("refuses a DO binding to a class the bundle didn't declare", () => {
    expect(refused([{ type: 'durable_object_namespace', name: 'X', class_name: 'OtherDO' }])).toThrow(
      /not one of the vertical's own classes/,
    );
  });

  it('names the offending binding and its type in the refusal', () => {
    expect(refused([{ type: 'ai', name: 'LLM' }])).toThrow(/binding 'LLM' \(type 'ai'\)/);
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
