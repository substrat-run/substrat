import { z } from 'zod';
import { moduleId, permissionKey } from './ids.js';
import { envVarSpec, capability } from './manifest.js';
import { roleDefinition } from './permission.js';
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
 * What a vertical needs from the runtime, in substrate vocabulary (package.json
 * `substrat.runtimeNeeds`). A vertical authored with this section never writes deploy
 * config for a specific substrate — the CLI derives that at push time (D-38: builders
 * keep the substrate vocabulary; the Cloudflare mapping lives behind the platform).
 * Datastores beyond own stores (e.g. a relational database) are deliberately absent:
 * those are platform-PROVISIONED, never bundle-declared (self-serve-deploy.md §4).
 */
export const runtimeNeeds = z.object({
  /** The worker entry module, relative to the vertical root (e.g. `src/worker.ts`). */
  entry: z.string().min(1),
  /** Needs Node built-ins at runtime (crypto/streams shims — e.g. Better Auth). */
  needsNodeCompat: z.boolean().default(false),
  /** Command to run before bundling (SPA build, asset generation). Runs in the vertical root. */
  build: z.string().min(1).optional(),
  stores: z.array(storeNeed).default([]),
});
export type RuntimeNeeds = z.infer<typeof runtimeNeeds>;

/** A binding the uploaded worker declares, as far as the sandbox contract check needs it. */
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
  /** The vertical's declared env-spec (from its package.json `substrat.envSpec`), stored on
   *  the registry so a host/console renders a config form for it. Optional + validated here. */
  envSpec: z.array(envVarSpec).optional(),
  /** Registry-driven install (marketplace-publish.md §3), from package.json `substrat.*` —
   *  carried so the dashboard installs without a hardcoded catalog entry. Validated here. */
  ownerGrants: z.array(permissionKey).optional(),
  entitlements: z.array(z.string()).optional(),
  provides: z.array(capability).optional(),
  requires: z.array(capability).optional(),
  /** The surfaces the vertical serves (package.json `substrat.surfaces`, K-26 multi-surface) —
   *  labels only, carried to the registry for the hostname-binding picker. Metadata, not code. */
  surfaces: z.array(declaredSurface).optional(),
  /** The vertical's declared permission surface (D-39): keys+descriptions, role templates,
   *  entity-grant shapes — the machine-readable PERMISSIONS.md. Optional + additive (D-28);
   *  `digests.permission` is its content hash. Absent ⇒ the vertical ships no registry here
   *  and the permission digest is over the empty surface. */
  registry: permissionRegistry.optional(),
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
