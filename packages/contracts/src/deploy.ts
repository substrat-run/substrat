import { z } from 'zod';
import { permissionKey } from './ids.js';
import { envVarSpec, capability } from './manifest.js';
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
  /** Computed by the builder's toolchain; what the promotion checkpoint compares. */
  digests: z.object({
    manifest: z.string().min(1),
    permission: z.string().min(1),
    migration: z.string().min(1),
  }),
});
export type DeployManifest = z.infer<typeof deployManifest>;
