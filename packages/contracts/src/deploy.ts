import { z } from 'zod';
import { moduleId, permissionKey, verticalSlug } from './ids.js';
import { envVarSpec, capability, type ModuleManifest } from './manifest.js';
import { roleDefinition, type RoleDefinition } from './permission.js';
import { declaredSurface } from './routing.js';

// The deploy manifest is the JSON part a `substrat push` sends alongside the
// module files (self-serve-deploy.md). It lives here — not in the transport
// package — because BOTH ends must speak the same shape: the CLI builds and
// validates it before upload, the control plane re-parses it at the trust
// boundary and runs the §4 sandbox contract against the result. One schema,
// two parses, no drift.

/**
 * The runtime baseline a `runtimeNeeds` vertical builds against — the platform picks the
 * compatibility date, the builder never does. Advancing it is a platform release concern
 * (re-push under the new baseline), exactly like a kernel upgrade.
 */
export const RUNTIME_BASELINE = '2025-01-01';

/**
 * One of the vertical's OWN stores: a durable state class the code exports, reached in the
 * worker through `binding`. This is the substrate-vocabulary side of what the wire manifest
 * calls `doClasses` + a `durable_object_namespace` binding — the §4 sandbox contract already
 * guarantees a vertical binds nothing BUT its own stores, so own-stores is the entire
 * vocabulary; there is nothing else a builder could legitimately say.
 */
export const storeNeed = z.object({
  /** How the worker reaches it: `env.<binding>`. SCREAMING_SNAKE, like an env key. */
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** The exported class implementing the store. */
  class: z.string().min(1),
});
export type StoreNeed = z.infer<typeof storeNeed>;

/**
 * A **per-tenant relational store** the platform provisions and hands to the vertical —
 * one independent SQL database *per tenant* (D1 on Cloudflare, a separate `.sqlite` file
 * on the pure adapter), reached in the worker through `binding` (#301). This is the third
 * distinct store shape, and the vocabulary keeps them apart on purpose:
 *
 * - `storeNeed` (own DO)          — the vertical's own durable class, one DO **per scope**.
 * - a static shared `d1` binding  — ONE database shared across every tenant (a build-time id).
 * - `tenantStoreNeed` (this)      — one relational DB **per tenant**, PLATFORM-minted.
 *
 * The load-bearing difference from a static `d1` binding: the builder supplies **no
 * database id**. The platform mints it per tenant in the tenant lifecycle and injects it,
 * which is what closes the ownership gap a bundle-chosen id left open (self-serve-deploy.md
 * §4, `control-plane-api/src/deploy.ts`). Because there is no id to declare, a per-tenant
 * store is a `runtimeNeeds` NEED, never a `declaredBinding` — nothing about it is bound
 * statically on the shared serving script.
 */
export const tenantStoreNeed = z.object({
  /** How the worker reaches this tenant's store: `host.tenantStore(tenantId, <binding>)`. */
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** The store shape. Only `relational` today; a literal so widening it is an explicit, additive change. */
  kind: z.literal('relational').default('relational'),
});
export type TenantStoreNeed = z.infer<typeof tenantStoreNeed>;

/**
 * A platform-minted per-tenant store, as handed to the vertical at provision (K-31) and
 * resolvable again at request time. `ref` is **opaque to the vertical**: a D1 `database_id`
 * on Cloudflare, a per-tenant `.sqlite` path token on the pure adapter. The vertical opens
 * it through the host (`openTenantStore`) and never parses it — that indirection is what
 * lets one vertical run unchanged against D1 in production and separate SQLite files locally.
 */
export const tenantStoreHandle = z.object({
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: z.literal('relational'),
  ref: z.string().min(1),
});
export type TenantStoreHandle = z.infer<typeof tenantStoreHandle>;

/**
 * The env name a tenant's store is bound under on the Cloudflare serving script (#301,
 * PR-2): `<BINDING>__<TENANTID>`. One convention, shared by its two ends — the control
 * plane derives it when attaching the D1 binding to the serving script, and the vertical
 * worker derives it to look the binding up (`env[tenantStoreBindingName(handle.binding,
 * tenantId)]` narrows to a `D1Database`). It lives in contracts precisely so neither side
 * hardcodes the other's half. A tenant id is a ULID (uppercase alphanumeric) and the
 * declared binding is SCREAMING_SNAKE, so the result is always a valid binding name; the
 * double underscore keeps it out of the single-underscore namespace a builder would use.
 * On the pure adapter there is no binding to name — the handle's `ref` is the whole reach.
 */
export function tenantStoreBindingName(binding: string, tenantId: string): string {
  return `${binding}__${tenantId}`;
}

/**
 * A **per-tenant blob store** the platform provisions and hands to the vertical (#473) —
 * an object store for attachment bytes (an R2 bucket on Cloudflare, a directory on the
 * pure adapter), reached in the worker through `binding`. The fourth store shape, same
 * ownership story as `tenantStoreNeed`: the builder supplies **no bucket id** — the
 * platform mints one per tenant in the tenant lifecycle and injects it, so a blob store
 * is a `runtimeNeeds` NEED, never a `declaredBinding`. (A hand-authored static
 * `r2_bucket` binding remains admissible under §4 as an own store — this exists so
 * attachment bytes don't have to ride one: per-tenant minting closes the shared-bucket
 * ownership gap, and per-SCOPE isolation inside the store is platform-derived key
 * prefixes constructed only in kernel/adapter code, never in module or route code.)
 */
export const blobStoreNeed = z.object({
  /** How the worker reaches this tenant's store: `env[blobStoreBindingName(binding, tenantId)]`. */
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** The store shape. Only `blob` today; a literal so widening it is an explicit, additive change. */
  kind: z.literal('blob').default('blob'),
});
export type BlobStoreNeed = z.infer<typeof blobStoreNeed>;

/**
 * A platform-minted per-tenant blob store, as handed over at provision (K-31). `ref` is
 * **opaque to the vertical**: an R2 bucket name on Cloudflare, a per-tenant directory
 * token on the pure adapter. The vertical never parses it — request-time reach is the
 * injected binding (Cloudflare) or the host's own resolution (pure adapter).
 */
export const blobStoreHandle = z.object({
  binding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  kind: z.literal('blob'),
  ref: z.string().min(1),
});
export type BlobStoreHandle = z.infer<typeof blobStoreHandle>;

/**
 * The env name a tenant's blob store is bound under on the Cloudflare serving script
 * (#473): `<BINDING>__<TENANTID>` — the same convention, and for the same reason, as
 * {@link tenantStoreBindingName}; the value narrows to an `R2Bucket` instead of a
 * `D1Database`. On the pure adapter there is no binding to name.
 */
export function blobStoreBindingName(binding: string, tenantId: string): string {
  return `${binding}__${tenantId}`;
}

/**
 * What a vertical needs from the runtime, in substrate vocabulary (package.json
 * `substrat.runtimeNeeds`). A vertical authored with this section never writes deploy
 * config for a specific substrate — the CLI derives that at push time (D-38: builders
 * keep the substrate vocabulary; the Cloudflare mapping lives behind the platform).
 * A single shared relational database is still not bundle-declarable here; a PER-TENANT
 * relational store is, via `tenantStores` — the platform provisions it (self-serve-deploy.md
 * §4), so the vertical declares the NEED and never a database id.
 */
export const runtimeNeeds = z.object({
  /** The worker entry module, relative to the vertical root (e.g. `src/worker.ts`). */
  entry: z.string().min(1),
  /** Needs Node built-ins at runtime (crypto/streams shims — e.g. Better Auth). */
  needsNodeCompat: z.boolean().default(false),
  /** Command to run before bundling (SPA build, asset generation). Runs in the vertical root. */
  build: z.string().min(1).optional(),
  stores: z.array(storeNeed).default([]),
  /** Per-tenant relational stores the platform provisions and hands over (#301). NOT bound
   *  statically — the CLI does not emit a wrangler binding for these, precisely because there
   *  is one database per tenant, minted in the tenant lifecycle rather than at deploy. */
  tenantStores: z.array(tenantStoreNeed).default([]),
  /** Per-tenant blob stores for attachment bytes (#473). Same non-binding rule as
   *  `tenantStores`: one bucket per tenant, minted in the tenant lifecycle. */
  blobStores: z.array(blobStoreNeed).default([]),
});
export type RuntimeNeeds = z.infer<typeof runtimeNeeds>;

/**
 * The §4 sandbox allowlist: the binding types a hosted vertical may declare, because each
 * is one of its OWN resources and carries no reach into platform infrastructure. This is a
 * POSITIVE allowlist — anything not named here is refused (self-serve-deploy.md §4), the
 * inverse of the original allow-by-omission denylist. It lives in `contracts` so both ends
 * speak one list: the CLI can predict admission, the control plane enforces it, and "what
 * passes" is a written set rather than an emergent property of what the check forgot to ban.
 *
 * Notable exclusions and why they are refused, not merely absent:
 * - `service` — a hosted vertical is ONE serving script (the DO is the app); it reaches the
 *   platform through the router (K-27), never a service binding. No own sibling to bind.
 * - `dispatch_namespace` — the platform's Workers-for-Platforms fabric, never a vertical's.
 * - anything managed/egress-shaped (`ai`, `browser`, `vectorize`, `hyperdrive`, `send_email`,
 *   `mtls_certificate`) — the outside world is a connector concern, and outbound policy is an
 *   open question (§6 / #303); least-privilege means these are refused until decided.
 *
 * Caveat on `d1`: admissible as an own relational store (e.g. a Better-Auth `AUTH_DB`), but
 * the check does not yet PROVE the declared `database_id` is the vertical's own rather than
 * another tenant's — trusted under model-B human admission; platform provisioning closes that
 * gap (#301). A `durable_object_namespace` is admissible only for the vertical's OWN classes
 * (no `script_name`, `class_name` ∈ declared `doClasses`) — the control plane checks that.
 */
export const ADMISSIBLE_BINDING_TYPES = [
  'durable_object_namespace', // the vertical's own ScopeDO / state classes (own class only)
  'd1', // an own relational store (id ownership deferred to #301)
  'kv_namespace', // an own KV namespace
  'queue', // an own queue (producer binding)
  'r2_bucket', // an own R2 bucket
  'analytics_engine', // an own Analytics Engine dataset
  'secret_text', // an own secret (survives deploys via keep_bindings, #286)
  'plain_text', // an own inline config value (inert, no authority)
] as const;
export type AdmissibleBindingType = (typeof ADMISSIBLE_BINDING_TYPES)[number];

/** A binding the uploaded worker declares, as far as the sandbox contract check needs it.
 *  `type` stays a free string here — the §4 allowlist (`ADMISSIBLE_BINDING_TYPES`) is enforced
 *  by the control plane, not the schema, so a refused type produces a *named* rejection that
 *  points at the doc rather than a generic Zod parse error the builder can't act on. */
export const declaredBinding = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  class_name: z.string().optional(),
  script_name: z.string().optional(),
  /** For a `d1` binding: the database id — a vertical's OWN store (self-serve-deploy.md §4). */
  id: z.string().optional(),
});
export type DeclaredBinding = z.infer<typeof declaredBinding>;

/**
 * One row of the permission registry: a declared key, its description, and the module(s)
 * that declare it (§1 of PERMISSIONS.md, made machine-readable). `declaredBy` lets a
 * console group keys by owning engine without re-deriving from module code.
 */
export const permissionRegistryEntry = z.object({
  key: permissionKey,
  description: z.string().min(1),
  declaredBy: z.array(moduleId).min(1),
});
export type PermissionRegistryEntry = z.infer<typeof permissionRegistryEntry>;

/** An entity-narrowed grant SHAPE — which keys a per-entity grant carries (§4 of
 *  PERMISSIONS.md). The grants themselves are per-principal, runtime, scope-local; only
 *  their declared shapes are a code fact and belong in the manifest. */
export const entityGrantShape = z.object({
  entityType: z.string().min(1),
  permissions: z.array(permissionKey),
});
export type EntityGrantShape = z.infer<typeof entityGrantShape>;

/**
 * The vertical's declared permission surface, shipped in the deploy manifest (D-39) — the
 * machine-readable twin of PERMISSIONS.md. Assembled at push from the SAME `MODULES` +
 * `ROLES` + `ENTITY_GRANTS` the host registers (via the checked-in `permissions.json` that
 * `tools/permission-diff.mts` emits and CI keeps fresh), so it cannot drift from what is
 * enforced. `digests.permission` is its content hash: the platform now holds the registry
 * it already committed to, not only the hash. Immutable per version; consumed by admission
 * (a real permission diff between versions) and any tenant-facing permissions view.
 *
 * Deliberately NOT the runtime grant table: minted capability grants are scope-local tuples
 * (control-plane.md §4.5), reachable only through the admin-query RPC, never mirrored here.
 */
export const permissionRegistry = z.object({
  permissions: z.array(permissionRegistryEntry),
  roles: z.array(roleDefinition),
  entityGrants: z.array(entityGrantShape).default([]),
});
export type PermissionRegistry = z.infer<typeof permissionRegistry>;

/**
 * A vertical's declared permission surface, as the **single typed source** — the input the
 * permission checkpoint (`tools/permission-diff.mts`) and `substrat push` both read to derive
 * the {@link permissionRegistry}. It is not the registry itself: keys carry no `declaredBy` yet
 * (that is derived from `modules`), because this is what an author *writes*, once.
 *
 * `modules` is structural on purpose — a `ModuleRegistration[]` (kernel) is assignable, but
 * `contracts` may not depend on the kernel, so it asks only for the `manifest` it reads.
 */
export interface PermissionsInput {
  /** The modules the host registers — the source of every permission key + description. */
  modules: readonly { manifest: ModuleManifest }[];
  /** The role templates provisioning stamps into each tenant. */
  roles: readonly RoleDefinition[];
  /** Entity-narrowed grant shapes — keys reachable outside the role table (default none). */
  entityGrants?: readonly EntityGrantShape[];
}

/**
 * Declare a vertical's permission surface, once, in TypeScript. An identity helper: it pins the
 * shape so a missing or mistyped field is a **compile error**, not a silently-skipped vertical,
 * and returns a plain, side-effect-free object safe to import in any Node context to read the
 * surface without running the vertical. A vertical exports the result and points at it from
 * `package.json` `substrat.permissions`; the checkpoint discovers it there rather than from a
 * by-name `seed.ts` re-export.
 */
export function definePermissions(input: PermissionsInput): PermissionsInput {
  return input;
}

/**
 * Derive the machine-readable {@link permissionRegistry} from a vertical's declared surface —
 * the keys+descriptions each module declares (with `declaredBy`), the role templates, and the
 * entity-grant shapes. `substrat push` calls this on the imported `permissions` entry to build
 * what it ships in the manifest; the permission checkpoint uses the same function, so the
 * derived surface is one code path with no room to disagree.
 *
 * Deterministic: every array is sorted (keys, roles, grants, and the members within each), so
 * the output — and therefore `digests.permission` — is a pure function of content, independent
 * of declaration order.
 */
export function buildPermissionRegistry(input: PermissionsInput): PermissionRegistry {
  const cmp = (a: string, b: string) => a.localeCompare(b);
  const sortKeys = <T extends string>(keys: readonly T[]): T[] => [...keys].sort(cmp);

  const declaredBy = new Map<PermissionRegistryEntry['key'], { description: string; modules: Set<PermissionRegistryEntry['declaredBy'][number]> }>();
  for (const m of input.modules) {
    for (const p of m.manifest.permissions) {
      const seen = declaredBy.get(p.key);
      if (seen) seen.modules.add(m.manifest.id);
      else declaredBy.set(p.key, { description: p.description, modules: new Set([m.manifest.id]) });
    }
  }

  const roles = [...input.roles]
    .sort((a, b) => cmp(a.key, b.key))
    .map((r) => {
      if (!r.source) throw new Error(`buildPermissionRegistry: role '${r.key}' has no source`);
      return { key: r.key, permissions: sortKeys(r.permissions), source: r.source };
    });

  const permissions = [...declaredBy.entries()]
    .map(([key, v]) => ({ key, description: v.description, declaredBy: [...v.modules].sort(cmp) }))
    .sort((a, b) => cmp(a.key, b.key));

  const entityGrants = [...(input.entityGrants ?? [])]
    .sort((a, b) => cmp(a.entityType, b.entityType))
    .map((g) => ({ entityType: g.entityType, permissions: sortKeys(g.permissions) }));

  return { permissions, roles, entityGrants };
}

/** The JSON part a `substrat push` sends alongside the module files. */
export const deployManifest = z.object({
  version: z.string().min(1),
  /** Display name for a first-time register; defaults to the slug. */
  name: z.string().min(1).optional(),
  /** Filename of the main module among the uploaded parts. */
  entry: z.string().min(1),
  compatibilityDate: z.string().min(1),
  compatibilityFlags: z.array(z.string().min(1)).default([]),
  doClasses: z.array(z.string().min(1)).default([]),
  bindings: z.array(declaredBinding).default([]),
  /** Per-tenant relational stores the platform provisions per tenant (#301) — carried so
   *  admission surfaces them and the tenant lifecycle knows what to mint. NOT `bindings`:
   *  there is no static binding for a per-tenant store, so it never rides the sandbox
   *  allowlist; the platform mints one database per tenant and injects the id. */
  tenantStores: z.array(tenantStoreNeed).default([]),
  /** Per-tenant blob stores (#473) — same carry-for-provisioning rule as `tenantStores`:
   *  never a static binding; the platform mints one bucket per tenant and injects it. */
  blobStores: z.array(blobStoreNeed).default([]),
  /** The vertical's declared env-spec (from its package.json `substrat.envSpec`), stored on
   *  the registry so a host/console renders a config form for it. Optional + validated here. */
  envSpec: z.array(envVarSpec).optional(),
  /** Registry-driven install (marketplace-publish.md §3), from package.json `substrat.*` —
   *  carried so the dashboard installs without a hardcoded catalog entry. Validated here. */
  ownerGrants: z.array(permissionKey).optional(),
  entitlements: z.array(z.string()).optional(),
  provides: z.array(capability).optional(),
  requires: z.array(capability).optional(),
  /** DECLARED provisioner intent (#455): the target verticals this manager provisions
   *  tenants of (package.json `substrat.provisions`). A request, never a grant — the
   *  tenant-provisioner capability stays a staff-flipped registry flag; this feeds the
   *  console's requested/granted review surface and bounds `provision-tenant` targets. */
  provisions: z.array(verticalSlug).optional(),
  /** DECLARED email-sender intent (#303): this vertical wants to send transactional mail
   *  (password-reset, verification, invites) — package.json `substrat.sendsEmail`. Outbound
   *  is a platform concern (deploy.ts §4 keeps `send_email` OUT of the sandbox allowlist and
   *  WfP dispatch scripts cannot bind it anyway), so a vertical NEVER sends directly: it POSTs
   *  to the control plane's `/internal/email/send` relay, which sends on its behalf ONLY when
   *  the staff-flipped `emailSender` grant is set. A request, never a grant — refreshed on
   *  every re-push, feeds the console's requested/granted review surface. */
  sendsEmail: z.boolean().optional(),
  /** The surfaces the vertical serves (package.json `substrat.surfaces`, K-26 multi-surface) —
   *  labels only, carried to the registry for the hostname-binding picker. Metadata, not code. */
  surfaces: z.array(declaredSurface).optional(),
  /** The vertical's declared permission surface (D-39/D-41): keys+descriptions, role templates,
   *  entity-grant shapes — the machine-readable twin of PERMISSIONS.md, derived at push from the
   *  vertical's `definePermissions(...)` entry. REQUIRED: a deployable vertical must declare its
   *  surface (an explicit empty registry for one that genuinely exposes nothing), so absence is a
   *  parse error at the trust boundary rather than a silent empty surface. `digests.permission` is
   *  its content hash. */
  registry: permissionRegistry,
  /** Computed by the builder's toolchain; what the promotion checkpoint compares. */
  digests: z.object({
    manifest: z.string().min(1),
    /** Content hash of `registry` (D-39) — the promotion checkpoint's "permissions changed"
     *  signal. A pure function of the declared surface, so it moves iff a key, description,
     *  role, or grant shape moves. */
    permission: z.string().min(1),
    migration: z.string().min(1),
  }),
});
export type DeployManifest = z.infer<typeof deployManifest>;

/**
 * The same manifest for **reading persisted history**, where `registry` may be absent — a
 * version pushed before it was carried (D-39) or before it was required (D-41). The push trust
 * boundary always parses with the strict {@link deployManifest} (registry required), so a NEW
 * push cannot omit it; only re-reads of already-stored manifests use this lenient form, so an
 * old version stays readable and re-deployable in place (#286) instead of failing to parse.
 */
export const storedDeployManifest = deployManifest.extend({
  registry: permissionRegistry.optional(),
});
export type StoredDeployManifest = z.infer<typeof storedDeployManifest>;
