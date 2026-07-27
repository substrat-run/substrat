import type { DeclaredBinding, DeployManifest } from '@substrat-run/contracts';

/**
 * The deploy seam (self-serve-deploy.md). A `substrat push` uploads a *built* worker
 * bundle; this layer forwards it to the platform's runtime (a Workers-for-Platforms
 * dispatch namespace) and records a **pending** version. The push is not a deploy —
 * admission still gates serving.
 *
 * Two rules live here, and they are the reason an untrusted bundle can be accepted at
 * all:
 *
 * 1. **The platform holds the Cloudflare credential, never the builder** (D-34). The
 *    upload itself is `DeployVerticalFn`, injected by the host (the Worker holds the
 *    WfP-scoped token) so this package stays host-agnostic and unit-testable.
 * 2. **The sandbox contract** (self-serve-deploy.md §4): a vertical gets its OWN DO
 *    classes only — never the platform's `CONTROL_PLANE` binding, cross-script reach,
 *    or a service binding to a platform worker. `assertSandboxContract` refuses an
 *    upload that declares more, *before* it reaches the namespace. That structural
 *    refusal — not inspecting minified code — is the primary defence.
 */

// The manifest schema itself lives in @substrat-run/contracts (deploy.ts there) so the
// CLI validates the exact shape this server parses — re-exported here so hosts keep
// importing it from the transport package.
export { deployManifest } from '@substrat-run/contracts';
export type { DeclaredBinding, DeployManifest } from '@substrat-run/contracts';

/** A built vertical, ready to upload. `modules` are the bundled ESM parts. */
export interface VerticalBundle {
  entry: string;
  compatibilityDate: string;
  /** Runtime compat flags (e.g. `nodejs_compat`). Without these a script that imports
   *  `node:*` cannot start, and the upload is rejected — so they must travel. */
  compatibilityFlags: string[];
  modules: { name: string; content: Uint8Array; contentType: string }[];
  /** DO classes to migrate as SQLite (`new_sqlite_classes`). */
  doClasses: string[];
  bindings: DeclaredBinding[];
}

/**
 * How an upload treats an ALREADY-EXISTING script of the same name (#286). Absent ⇒
 * the script is new: full DO-class migrations (`new_tag: v1`), no binding inheritance.
 * Present ⇒ an in-place update of the stable serving script: existing secret bindings
 * are kept (`keep_bindings` — a hand-put secret survives every deploy), and DO-class
 * migrations are sent only as the DELTA against what the script already declares,
 * under a bumped tag — re-declaring a live class as new is an upload error.
 */
export interface InPlaceUpload {
  /** DO classes the serving script already has (directory-recorded, not CF-queried). */
  priorDoClasses: string[];
  /** The serving script's current migration tag (`v1`, `v2`, …). */
  priorMigrationTag: string;
}

/**
 * Upload a built bundle to the platform runtime under `deploymentRef`. Injected by the
 * host so the transport package never imports a Cloudflare SDK and tests use a fake.
 */
export type DeployVerticalFn = (
  deploymentRef: string,
  bundle: VerticalBundle,
  inPlace?: InPlaceUpload,
) => Promise<void>;

/**
 * Download the module contents of a script already in the namespace — what promote and
 * backout re-upload from (the archive script is the platform's bundle store; nothing
 * else retains the built bytes). Host-injected like `DeployVerticalFn`.
 */
export type FetchVerticalModulesFn = (
  deploymentRef: string,
) => Promise<VerticalBundle['modules']>;

/**
 * The §4 sandbox contract. Throws (mapped to a 4xx by errors.ts via "deploy refused")
 * if the declared bindings would give the vertical reach into platform infrastructure.
 *
 * What it REFUSES is the platform's own infrastructure: the `CONTROL_PLANE` directory,
 * a service binding to a platform worker, and any DO binding that is not one of the
 * vertical's own classes (cross-script, or a class it didn't declare). Everything a
 * vertical legitimately owns falls through and is allowed — its own `ScopeDO`, and its
 * own data stores like a `d1` binding for a Better-Auth `AUTH_DB` (self-serve-deploy.md
 * §4: "no `AUTH_DB` it did not create", i.e. its OWN store is fine).
 *
 * Open question (§4, model B): a `d1` binding names a `database_id`, and this check does
 * not yet prove the vertical *owns* that id rather than pointing at another tenant's DB.
 * Under model B that gap is closed by human admission — a person trusts the builder's
 * declared bindings before the version can serve — not by this structural check. When
 * self-serve opens wider, per-vertical store PROVISIONING (the platform mints the D1 and
 * injects the id) replaces a bundle-chosen id; that is a deploy-pipeline change, not here.
 */
export function assertSandboxContract(m: DeployManifest): void {
  const own = new Set(m.doClasses);
  for (const b of m.bindings) {
    if (b.name === 'CONTROL_PLANE') {
      throw new Error(
        `deploy refused: binding 'CONTROL_PLANE' is the platform's directory, not a vertical's`,
      );
    }
    if (b.type === 'service') {
      throw new Error(
        `deploy refused: service binding '${b.name}' — a vertical reaches the platform through the router (K-27), never a binding`,
      );
    }
    if (b.type === 'durable_object_namespace') {
      if (b.script_name) {
        throw new Error(
          `deploy refused: cross-script DO binding '${b.name}' (script '${b.script_name}') — a vertical may bind only its OWN DO classes`,
        );
      }
      if (b.class_name && !own.has(b.class_name)) {
        throw new Error(
          `deploy refused: DO binding '${b.name}' → '${b.class_name}', not one of the vertical's own classes [${m.doClasses.join(', ') || 'none'}]`,
        );
      }
    }
  }
}

/**
 * The dispatch script name a version deploys under, and what the router will dispatch
 * on (orchestration.md §5.3). Keyed on the version's ULID rather than the `@version`
 * label the RFC sketched, because **it is a Cloudflare Worker script name** — no `@`
 * or `.`, only `[a-z0-9_-]`. A lowercased ULID is valid by construction and unique per
 * version; the human-readable label lives on the version record's `version` field.
 *
 * A builder-owned vertical's slug is `<tenant>/<name>` (builder-plane.md) — the `/` is
 * not script-name-safe, so it (and any other stray char) is flattened to `-`. A bare
 * platform slug is unaffected (`callout-<id>`), so this is backward-compatible.
 */
export function deploymentRefFor(slug: string, versionId: string): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe}-${versionId.toLowerCase()}`;
}

/**
 * The vertical's ONE stable serving script (#286, supersedes orchestration.md §5.3's
 * one-script-per-version for serving). Data lives here: a Durable Object namespace
 * belongs to its script, so re-uploading new code under this unchanged name is what
 * makes a version update carry the scopes' data forward instead of stranding it in
 * the outgoing version's script. Per-version scripts (`deploymentRefFor`) remain the
 * push archive — admission review, readiness probes, and the bundle store that
 * promote and backout re-upload from.
 *
 * Cannot collide with an archive ref: archive refs always end in `-<26-char ULID>`,
 * and a slug is registered unique before either name is minted. Jurisdictional
 * serving scripts (K-30, `<slug>-eu`) hang off this same name when eu/us open.
 */
export function stableDeploymentRefFor(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Serving-script migration tags are `v1`, `v2`, … — bumped only when a version adds
 *  NEW DO classes to an existing serving script (`old_tag`/`new_tag` upload metadata). */
export function nextMigrationTag(current: string): string {
  const n = /^v(\d+)$/.exec(current);
  return `v${(n ? Number(n[1]) : 1) + 1}`;
}
