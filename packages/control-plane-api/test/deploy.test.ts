import { describe, it, expect } from 'vitest';
import { errorCodeOf } from '@substrat-run/contracts';
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
  // A refusal is judged on TWO things, and neither stands in for the other. The CODE is what
  // the control plane reads to answer 403 now that `errors.ts` no longer holds a
  // `/deploy refused:/` row (#113 phase 5) — a bare `Error` with the right sentence falls to
  // the generic 500. The MESSAGE pattern says WHICH refusal fired: every branch shares the one
  // throw site, so the code alone cannot tell one guard from another, and a case that matched
  // only the code would pass whichever guard happened to catch its input.
  const expectRefusal = (bindings: DeclaredBinding[], message: RegExp, doClasses?: string[]) => {
    let thrown: unknown;
    try {
      assertSandboxContract(manifest(bindings, doClasses));
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'the contract admitted a binding it should have refused').toBeInstanceOf(Error);
    expect(errorCodeOf(thrown)).toBe('forbidden');
    expect((thrown as Error).message).toMatch(message);
    expect((thrown as Error).message).toMatch(/^deploy refused: /);
  };

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
    expectRefusal(
      [{ type: 'durable_object_namespace', name: 'CONTROL_PLANE', class_name: 'ScopeDO' }],
      /'CONTROL_PLANE' is the platform's directory/,
    );
    // even masquerading as an admissible inert type
    expectRefusal([{ type: 'plain_text', name: 'CONTROL_PLANE' }], /'CONTROL_PLANE' is the platform's directory/);
  });

  it("refuses the SUBSTRAT_ binding namespace by name — an injected stamp cannot be forged (#1242)", () => {
    // Matched on the guard's own reason, not the name: every refusal echoes the
    // binding's name, so /SUBSTRAT_/ would pass even if this rule did not exist.
    expectRefusal([{ type: 'plain_text', name: 'SUBSTRAT_VERSION_ID' }], /binding namespace is the platform's/);
    // The whole prefix, not one name: the namespace stays the platform's as it grows.
    expectRefusal([{ type: 'secret_text', name: 'SUBSTRAT_FUTURE_THING' }], /binding namespace is the platform's/);
  });

  it('refuses a service binding — a vertical reaches the platform via the router (K-27)', () => {
    expectRefusal([{ type: 'service', name: 'CP' }], /router \(K-27\)/);
  });

  it("refuses the platform's dispatch namespace", () => {
    expectRefusal([{ type: 'dispatch_namespace', name: 'VERTICALS' }], /Workers-for-Platforms/);
  });

  it('refuses an unrecognized binding type by omission (allowlist, not denylist)', () => {
    expectRefusal([{ type: 'hyperdrive', name: 'PG' }], /not an admissible own-resource binding type/);
  });

  it('refuses a cross-script DO binding', () => {
    expectRefusal(
      [{ type: 'durable_object_namespace', name: 'X', class_name: 'ScopeDO', script_name: 'substrat-control-plane' }],
      /cross-script/,
    );
  });

  it("refuses a DO binding to a class the bundle didn't declare", () => {
    expectRefusal(
      [{ type: 'durable_object_namespace', name: 'X', class_name: 'OtherDO' }],
      /not one of the vertical's own classes/,
    );
  });

  it('names the offending binding and its type in the refusal', () => {
    expectRefusal([{ type: 'ai', name: 'LLM' }], /binding 'LLM' \(type 'ai'\)/);
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
