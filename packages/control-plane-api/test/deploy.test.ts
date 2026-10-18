import { describe, it, expect } from 'vitest';
import { errorCodeOf, RESERVED_STORE_OPERATIONS, scopeStoreObjectName } from '@substrat-run/contracts';
import type { DeclaredBinding, DeployManifest, StoreDriverRegistration } from '@substrat-run/contracts';
import {
  assertSandboxContract,
  deploymentRefFor,
  scopeStoreScriptName,
  scopeStoreUploadPlan,
  stableDeploymentRefFor,
  nextMigrationTag,
  verticalUploadBindings,
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
  it('names existing slug shapes exactly as before the store name space was reserved (L20)', () => {
    const expected: Record<string, string> = {
      ticket0: 'ticket0',
      callout: 'callout',
      'acme/crm': 'acme-crm',
      'acme-co/field-service': 'acme-co-field-service',
      't-0wv2mwk4j5/crm': 't-0wv2mwk4j5-crm',
      'substrat/docs-bot': 'substrat-docs-bot',
      '9lives/app2': '9lives-app2',
    };
    for (const [slug, ref] of Object.entries(expected)) expect(stableDeploymentRefFor(slug), slug).toBe(ref);
  });

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

  it('admits a scope store whose driver is registered, and refuses it against a registry without that driver', () => {
    const declaring = { ...manifest([]), scopeStores: [{ binding: 'GRAPH', driver: 'graph' as const }] };
    expect(() => assertSandboxContract(declaring)).not.toThrow();
    let thrown: unknown;
    try {
      assertSandboxContract(declaring, []);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, 'an unregistered scope store was admitted').toBeInstanceOf(Error);
    expect(errorCodeOf(thrown)).toBe('forbidden');
    expect((thrown as Error).message).toMatch(/not registered/);
    expect((thrown as Error).message).toMatch(/^deploy refused: /);
  });

  // #2224: the control plane holds an own DO binding to the same one-name-one-store rule push
  // does, so a manifest that did not come through push is refused the same way.
  it('refuses an own DO binding that takes a per-tenant or scope store’s name', () => {
    const own = { type: 'durable_object_namespace', name: 'DB', class_name: 'ScopeDO' } as const;
    const refused = (m: DeployManifest, message: RegExp) => {
      let thrown: unknown;
      try {
        assertSandboxContract(m);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, 'the contract admitted a name taken twice').toBeInstanceOf(Error);
      expect(errorCodeOf(thrown)).toBe('forbidden');
      expect((thrown as Error).message).toMatch(message);
    };
    refused(
      { ...manifest([own]), tenantStores: [{ binding: 'DB', kind: 'relational' }] },
      /binding 'DB' is declared as an own store and as a per-tenant store/,
    );
    refused(
      { ...manifest([{ ...own, name: 'GRAPH' }]), scopeStores: [{ binding: 'GRAPH', driver: 'graph' }] },
      /binding 'GRAPH' is declared as an own store and as a scope store/,
    );
    // An own DO binding also lands under its own name, so it must not take a store's runtime name.
    const tenant = '01JABCDEFGHJKMNPQRSTVWXYZ0';
    refused(
      { ...manifest([{ ...own, name: `DB__${tenant}` }]), tenantStores: [{ binding: 'DB', kind: 'relational' }] },
      new RegExp(`binding 'DB__${tenant}' is the runtime name of per-tenant store 'DB'`),
    );
    refused(
      { ...manifest([{ ...own, name: `ATTACHMENTS__${tenant}` }]), blobStores: [{ binding: 'ATTACHMENTS', kind: 'blob' }] },
      new RegExp(`binding 'ATTACHMENTS__${tenant}' is the runtime name of per-tenant store 'ATTACHMENTS'`),
    );
    // The twin: an own DO binding of another name is admitted beside the per-tenant store.
    ok([{ ...own, name: 'SCOPE' }]);
    expect(() =>
      assertSandboxContract({ ...manifest([{ ...own, name: 'SCOPE' }]), tenantStores: [{ binding: 'DB', kind: 'relational' }] }),
    ).not.toThrow();
  });
});

describe('scope store upload plan (#2210)', () => {
  // A release is pinned by sha256 (D-63); the label here only names which test pin it is.
  const pinOf = (release: string) => ({ sha256: (release === '1.0.0' ? 'a' : 'b').repeat(64), sourceCommit: 'c'.repeat(40), schema: 0 });
  const driver = (release: string): StoreDriverRegistration => ({
    driver: 'graph',
    releases: [pinOf(release)],
    className: 'Store',
    operations: ['read'],
    platformOperations: [...RESERVED_STORE_OPERATIONS],
  });
  const stores = [
    { binding: 'GRAPH' as const, driver: 'graph' as const },
    { binding: 'BLOBS' as const, driver: 'graph' as const },
  ];

  // L1 (RFC scope-stores §10.7): with a driver registered, neither upload a vertical's push or
  // serve sends carries a SUBSTRAT_STORE_* binding. This is the function both uploads in api.ts
  // build their binding list with, so a store binding injected into it fails here.
  it('a vertical upload carries no store binding, with a driver registered', () => {
    const own: DeclaredBinding[] = [{ type: 'kv_namespace', name: 'CACHE', id: 'kv-1' }];
    const ledger = [{ type: 'd1', name: 'SUBSTRAT_TENANT_DB_01ABC', id: 'd1-1' }];
    for (const platformBindings of [ledger, []]) {
      const bindings = verticalUploadBindings({
        vertical: 'acme/crm',
        manifest: { bindings: own, scopeStores: stores },
        platformBindings,
        drivers: [driver('1.0.0')],
      });
      expect(bindings.map((b) => b.name).filter((name) => name.startsWith('SUBSTRAT_STORE_'))).toEqual([]);
      // The twin: the vertical's own bindings and the platform's ledger bindings are still there.
      expect(bindings).toEqual([...own, ...platformBindings]);
    }
    expect(scopeStoreUploadPlan({ vertical: 'acme/crm', stores, drivers: [driver('1.0.0')] }).bindings).toEqual([]);
  });

  it('an upload admits the registered driver, and refuses the same declaration when the registry is empty', () => {
    expect(
      verticalUploadBindings({ vertical: 'acme/crm', manifest: { bindings: [], scopeStores: stores }, platformBindings: [] }).map((b) => b.name),
    ).toEqual([]);
    expect(() =>
      verticalUploadBindings({ vertical: 'acme/crm', manifest: { bindings: [], scopeStores: stores }, platformBindings: [], drivers: [] }),
    ).toThrow(/not registered/);
    expect(verticalUploadBindings({ vertical: 'acme/crm', manifest: { bindings: [], scopeStores: [] }, platformBindings: [] })).toEqual([]);
  });

  it('plans one script per driver and vertical, and a new release keeps the name', () => {
    const first = scopeStoreUploadPlan({ vertical: 'acme/crm', stores, drivers: [driver('1.0.0')] });
    const next = scopeStoreUploadPlan({ vertical: 'acme/crm', stores, drivers: [driver('2.0.0')] });
    expect(first.scripts).toEqual([
      {
        driver: 'graph',
        releases: [pinOf('1.0.0')],
        vertical: 'acme/crm',
        className: 'Store',
        scriptName: scopeStoreScriptName('acme/crm', 'graph'),
      },
    ]);
    expect(next.scripts[0]?.scriptName).toBe(first.scripts[0]?.scriptName);
    // The name carries no release: a new pin uploads into the same script.
    expect(first.scripts[0]?.scriptName).not.toContain(pinOf('1.0.0').sha256.slice(0, 8));
    expect(scopeStoreObjectName('01TENANT', 'acme/crm', '01SCOPE', 'GRAPH')).toBe('01TENANT/acme/crm/01SCOPE/GRAPH');
  });

  it('refuses a driver that is not registered when the registry passed in is empty', () => {
    expect(() =>
      scopeStoreUploadPlan({ vertical: 'acme/crm', stores: [{ binding: 'GRAPH', driver: 'graph' }], drivers: [] }),
    ).toThrow(/not registered/);
    expect(scopeStoreUploadPlan({ vertical: 'acme/crm', stores: [{ binding: 'GRAPH', driver: 'graph' }] }).scripts[0]?.driver).toBe('graph');
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
