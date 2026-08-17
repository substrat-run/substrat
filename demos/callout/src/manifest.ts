import { manifestEntities, moduleManifest, permissionKey, type EnvVarSpec } from '@substrat-run/contracts';
import { calloutEntities } from './entities.js';

/**
 * Callout's ORDINARY declared environment — the deployment-default half of its auth
 * config (the structured per-scope `substrat:auth` choice always wins over these; see
 * worker.ts `authProviderFor`). OIDC-only (oidc-only-demos.md): the vertical runs no
 * built-in credential store. Read exclusively through `resolveScopedEnvSpec`
 * (delivered > env > default, #398), never via bare `env.X`. Harness secrets
 * (ROUTER_SECRET, PLATFORM_SECRET, ALLOW_DEV_HEADER) are deliberately NOT declared.
 *
 * MIRRORED in `package.json` `substrat.envSpec` (what `substrat push` carries — it reads
 * JSON, not TS); keep the two in sync.
 */
export const CALLOUT_ENV: EnvVarSpec[] = [
  {
    key: 'AUTH_PROVIDER',
    label: 'Auth provider',
    description:
      "OIDC-only: the vertical runs no built-in credential store. When no per-scope `substrat:auth` choice is delivered, 'oidc' verifies bearer tokens against OIDC_ISSUER (standalone deploys); anything else leaves the instance without a configured issuer.",
    placeholder: 'oidc',
    default: 'oidc',
    required: false,
    secret: false,
    group: 'Auth',
  },
  {
    key: 'OIDC_ISSUER',
    label: 'OIDC issuer',
    description: "The issuer URL bearer tokens are verified against when the provider is 'oidc'. Covers Supabase, Auth0, AuthHero, Keycloak, …",
    placeholder: 'https://auth.example.com',
    required: false,
    secret: false,
    group: 'Auth',
  },
  {
    key: 'OIDC_AUDIENCE',
    label: 'OIDC audience',
    description: 'Expected `aud` claim of verified bearer tokens (optional; issuer-dependent).',
    placeholder: 'https://api.example.com',
    required: false,
    secret: false,
    group: 'Auth',
  },
];

// ============================================================================
// The Callout vertical's declarative surface (spec/testrun.md §5.1): the
// permission keys, manifest metadata, event wiring, entity relations and
// entitlement. Everything a reader needs to understand the SHAPE of the
// vertical, with nothing executable to wade through — operations live in
// module.ts, the migration journal in migrations.ts.
//
// SC_PERM and the manifest's `permissions` list are the same keys expressed
// twice; keep them side by side so "add a permission" is a single-file edit.
// ============================================================================

export const SC_PERM = {
  customerManage: permissionKey.parse('customer:manage'),
  facilityManage: permissionKey.parse('facility:manage'),
};

export const calloutManifest = moduleManifest.parse({
  id: '@substrat-run/demo-callout',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'customer:manage', description: 'Manage customers and the price list' },
    { key: 'facility:manage', description: 'Manage facilities' },
  ],
  // protocol:* permissions and protocol.* events moved to
  // @substrat-run/engine-protocol at milestone B (engine-protocol.md §2).
  events: { emits: [], consumes: [] },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  // Entity names checked against `calloutEntities` (#697), and
  // `entityRelations` DERIVED from the entities' `parent` declarations rather
  // than written a second time.
  ...manifestEntities(calloutEntities, {
    attachmentTargets: [
      { entityType: 'customer', readPermission: 'customer:manage' },
      { entityType: 'facility', readPermission: 'facility:manage' },
    ],
    // The protocol engine is entity-agnostic; THIS vertical hangs protocols off
    // work orders, so it declares the permission-walk edge. Both names belong to
    // engines, so neither is checkable here.
    foreignChildren: [{ entityType: 'protocol', parentType: 'workorder' }],
  }),
  entitlementKey: 'callout',
  envSpec: CALLOUT_ENV,
  // This app can DELEGATE sign-in to an OIDC issuer (manifest `requires`, #427): at
  // install the dashboard offers the tenant's `oidc-issuer` providers to bind — issuer
  // from the provider's hostname, client minted by dynamic registration, delivered as
  // `substrat:auth`. Mirrored in `package.json` `substrat.requires`.
  requires: ['oidc-issuer'],
});
