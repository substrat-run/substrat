import { moduleManifest, permissionKey, type EnvVarSpec } from '@substrat-run/contracts';

/**
 * Manyfold's ORDINARY declared environment — the deployment-default half of its auth
 * config (the structured per-scope `substrat:auth` choice always wins over these; see
 * worker.ts `authProviderFor`). OIDC-only (oidc-only-demos.md): the vertical runs no
 * built-in credential store. Read exclusively through `instanceAuthFor`'s settings pass
 * (delivered > env > default, #398), never via bare `env.X` — reading `env` directly is
 * how a per-install issuer saved in the dashboard silently never arrived (#374/#972).
 * Harness secrets (ROUTER_SECRET, PLATFORM_SECRET) are deliberately NOT declared.
 *
 * The single declaration (#1206): `src/provision.ts` re-exports this as `envSpec`, which
 * is what `substrat push` uploads — package.json carries no copy.
 */
export const MANYFOLD_ENV: EnvVarSpec[] = [
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
    description:
      "The issuer URL bearer tokens are verified against when the provider is 'oidc'. Covers Supabase, Auth0, AuthHero, Keycloak, …",
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
// Manyfold's declarative surface: the permission keys and the manifest
// metadata (events, entitlement). Everything a reader needs to grasp the
// SHAPE of the vertical, with nothing executable — the editorial state
// machine lives in module.ts, the migration journal in migrations.ts.
//
// MF_PERM and the manifest's `permissions` list are the same keys expressed
// twice; keep them side by side so "add a permission" is a single-file edit.
// ============================================================================

export const MF_PERM = {
  read: permissionKey.parse('content:read'),
  author: permissionKey.parse('content:author'),
  review: permissionKey.parse('content:review'),
  publish: permissionKey.parse('content:publish'),
  admin: permissionKey.parse('content:admin'),
  // Provision a new SITE (a new scope) for this tenant — a privileged, infrastructure-shaped
  // action distinct from content admin, so it is its own key even though only `admin` holds it
  // today (multi-scope-manyfold.md M3 / platform-intents.md).
  manageSites: permissionKey.parse('content:manage-sites'),
};

export const manyfoldManifest = moduleManifest.parse({
  id: '@substrat-run/demo-manyfold',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'content:read', description: 'Read entries, revisions, and content models' },
    { key: 'content:author', description: 'Create and edit drafts, submit for review, restore revisions' },
    { key: 'content:review', description: 'Approve or reject entries in review' },
    { key: 'content:publish', description: 'Publish, unpublish, and archive entries' },
    { key: 'content:admin', description: 'Manage members, roles, and content models' },
    { key: 'content:manage-sites', description: 'Create new sites (provision a new scope for the tenant)' },
  ],
  events: {
    emits: [
      { type: 'content.submitted', schemaVersion: 1 },
      { type: 'content.approved', schemaVersion: 1 },
      { type: 'content.rejected', schemaVersion: 1 },
      { type: 'content.published', schemaVersion: 1 },
      { type: 'content.unpublished', schemaVersion: 1 },
      { type: 'content.archived', schemaVersion: 1 },
    ],
    // The public-delivery projection is maintained transactionally in the publish
    // ops (a read model must be consistent with the freeze). `content.published` is
    // the fat event a webhook CONNECTOR would consume to purge a CDN / rebuild a
    // site (cms-content.md §6.1) — that consumer is host code, the documented next step.
    consumes: [],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [],
  entitlementKey: 'manyfold',
  envSpec: MANYFOLD_ENV,
});
