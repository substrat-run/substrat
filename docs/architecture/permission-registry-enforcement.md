---
status: built
layer: kernel
description: The permission registry, derived from TypeScript. Logged as D-47.
---

# Permission registry — enforced, and derived from TypeScript

**Status:** **built** (D-41). Completes [D-39](../master-plan.md#12-decision-log) (the registry
ships in the deploy manifest) by closing the seams D-39 left as convention, and by removing the
checked-in machine-only artifact D-39 introduced. Touches [self-serve-deploy.md](self-serve-deploy.md)
§4 (admission), the CLI (`packages/cli`), the manifest schema (`packages/contracts`), the control
plane (`packages/control-plane-api`), and the checkpoint tool (`tools/permission-diff.mts`). No
change to the runtime permission model ([scope-local-permissions.md](scope-local-permissions.md)
is untouched).

**As built — two refinements to the proposal below:**

1. **The push import tolerates a node-ful entry** rather than *requiring* every entry be node-free
   (§3.1). `push` bundles the `permissions` entry with esbuild leaving all packages **external**,
   writing the temp module *inside* the vertical dir so Node resolves those externals (including a
   native addon a node-ful entry pulls) from the vertical's own `node_modules`. Real verticals
   still author a node-free `provision.ts`; the three seed-based demos keep their node-ful
   `seed.ts` entry and push handles them unchanged — so no vertical extraction was needed. The CLI
   gains an `esbuild` dependency.
2. **Backward-compat for stored manifests.** Making `registry` required (§3.3) would break
   re-parsing manifests persisted *before* it existed, so contracts also exports a lenient
   `storedDeployManifest` (registry optional) used only for reads of historical data (the registry
   read-back and the #286 in-place redeploy). New pushes are still parsed strictly.

The checked-in `permissions.json` fallback (§5) was **not** needed: `buildPermissionRegistry` was
proven to reproduce all seven previously-committed `permissions.json` byte-for-byte, so the digest
is unchanged and the files were deleted.

---

## 1. What D-39 fixed, and what it left as convention

D-39 made the declared permission surface a first-class, per-version manifest artifact: the
platform now holds the registry it commits to, with `digests.permission` a content hash of it.
That layering is sound and stays. The **mechanism** it shipped left three things as "works if
you follow the pattern," plus one artifact that shouldn't exist:

1. **Discovery is a magic re-export.** `tools/permission-diff.mts` reads `MODULES` / `ROLES`
   / `ENTITY_GRANTS` from each vertical's `src/seed.ts` **by name**. Those objects actually
   live in `provision.ts` (the node-free file the worker imports); `seed.ts` re-exports them
   *solely so the tool can find them* — with a comment in every vertical reminding the author
   not to forget. TypeScript enforces none of this: wrong name, wrong file, or a vertical
   outside `demos/`/`apps/` simply disappears from the checkpoint with **no error**.

2. **Absence is silent.** `readRegistry` returns `undefined` when the surface is missing
   (`packages/cli/src/push.ts`), and `push` then hashes the *empty* surface and ships. "This
   vertical declares no permissions" and "someone forgot to generate it" are indistinguishable
   — and the second fails in the wrong direction (deploys, unreviewed).

3. **`registry` is optional on the wire.** `deployManifest.registry` is `.optional()`
   (`packages/contracts/src/deploy.ts`), so the control-plane trust-boundary parse accepts a
   push with no declared surface at all.

4. **The surface is snapshotted to a checked-in `permissions.json`.** D-39 materialised the
   machine-readable twin as a committed file that `push` reads. But the surface is *already*
   TypeScript (module manifests + `ROLES`); a checked-in **machine-only** JSON is derived state
   in git — duplicating what the code says, consumed by nothing a human reads, and one more
   thing that can be stale. `PERMISSIONS.md` (human-readable) earns its place in the repo as
   the review artifact; the JSON twin does not.

None of these is a model bug. They are the gap between *the content can't drift* (true, and
enforced by `--check`) and *a vertical can't skip the mechanism, and the wire form isn't a
second copy in git* (both false today).

## 2. Principle

> The declared permission surface is a **required**, **compile-checked** part of a deployable
> vertical, **derived from the same TypeScript the host registers** — never authored as JSON,
> never discovered from a second copy that exists to be found, never absent-by-default, and
> never snapshotted to a machine-only file in git.

This is D-39's own rationale (`state that can drift from enforcement is worse than no state`)
applied one level up: a mechanism a vertical can silently opt out of is, for those verticals,
no mechanism — and a generated machine file in git is exactly the drift-prone derived state
the rest of the design refuses.

## 3. The design

### 3.1 One typed source — `definePermissions()`

The surface stays in TypeScript, declared **once**, with a typed helper whose return type *is*
the shape the tool and the wire consume — so a missing field or a mistyped role is a **compile
error**, not a silently-skipped vertical:

```ts
// provision.ts — the single declaration, beside MODULES/ROLES it already owns
export const permissions = definePermissions({
  modules: MODULES,          // the array buildHost registers (source of keys + descriptions)
  roles: ROLES,              // the role templates provisioning stamps per tenant
  entityGrants: ENTITY_GRANTS,
});
```

`definePermissions()` is a **pure-data** identity helper in `contracts`: it returns a plain
object (no side effects, no worker/DO globals touched at import), so its built module is
freely importable in a Node context. The `seed.ts` re-export block — and its "don't forget to
re-export these" comment — is **deleted from every vertical**. That is the one copy of the
permission truth that was pure indirection; the code↔`_substrat_roles` copy is a
template↔instance relationship and stays (see §4).

### 3.2 The wire form is derived at push, not stored in git

`substrat push` obtains the registry by importing the vertical's built `permissions` export
(plain data, node-importable — *not* the worker entry, which references bindings), assembles it
into the deploy manifest, and computes `digests.permission` from it. **No `permissions.json` in
the repo.**

- The **producer/consumer runtimes align**: the entry is pure data built to `dist` like any
  other module, so `push` reads it without a TS loader and without executing the worker.
- The **control plane never imports it** — it re-parses the wire manifest at the trust
  boundary, exactly as today. "Don't run untrusted code to learn its surface" is preserved.
- `PERMISSIONS.md` **stays checked in** as the human review artifact. `pnpm lint:permissions`
  regenerates it from the same `permissions` entry, and CI `--check` fails on drift — so what a
  reviewer approves and what `push` ships are the same source by construction.

### 3.3 Required, not optional — absence ≠ empty

- **Control plane (authoritative).** `deployManifest.registry` becomes **required**. A push
  with no declared surface is refused at the trust boundary, message naming the remedy. This is
  the gate that matters — the CLI is the builder's and can be bypassed.
- **CLI (early, friendly).** `push` refuses before upload when the `permissions` entry is
  absent or unresolvable, rather than defaulting to empty.
- **Honest-empty stays expressible, only explicitly.** A vertical that genuinely exposes
  nothing declares `definePermissions({ modules, roles: [], entityGrants: [] })` over modules
  that declare no keys — a *stated, reviewed* fact. The vacuity plug in `permission-diff.mts`
  (a registered module declaring zero permissions is already exit-2) keeps that honest.

### 3.4 One generator, still execution-free at the control plane

`permission-diff.mts` continues to emit `PERMISSIONS.md` from the typed entry (discovered via a
declared `package.json substrat.permissions` pointer, **not** a `seed.ts` scan). The only
things that leave: the `permissions.json` output and the `seed.ts`-by-name discovery. The tool
now imports the node-free `permissions` entry rather than `seed.ts` and its
`better-sqlite3`/`node:fs` baggage.

## 4. Layering, restated (unchanged from D-39, now enforced end-to-end)

| Layer | Home | Mutability |
|---|---|---|
| **Declared** surface (keys, descriptions, role templates, grant shapes) | TypeScript `definePermissions()` → derived into the version manifest `registry` (**required**) | immutable per version |
| **Operator** state (a tenant's live roles) | directory `_substrat_roles` via `listRoles` | runtime-mutable (correctly a table) |
| **Minted** grants | scope-local tuples, audited admin-query RPC only | runtime, never mirrored |

The code `ROLES` constant and the per-tenant `_substrat_roles` rows are a **template↔instance**
relationship, not duplication: provisioning stamps the template into each tenant, and the
runtime checker reads the tenant's rows. That copy stays. (Open, out of scope here: editing a
role template does **not** retro-update already-provisioned tenants — a propagation question
for the console, not for this proposal.)

## 5. Rejected alternatives

- **Keep the checked-in `permissions.json` (D-39 as shipped).** The robust fallback, and not
  wrong: a committed file needs no build or import and is consistent with the checked-in
  `PERMISSIONS.md`. Rejected as the *primary* because it is a machine-only generated artifact in
  git — derived state duplicating the TS, which this design otherwise refuses. **Retained as the
  fallback** if the "entry must be built/importable at push" dependency (§3.2) proves fragile in
  practice: re-emit `permissions.json` from the entry and have `push` read the file. The digest
  and review properties are identical either way; only *where the wire form comes from* differs.
- **Leave discovery on `seed.ts`, just add the throw.** Fixes absence but keeps the magic
  re-export and the "vertical outside `demos/`/`apps/` vanishes" failure. Half the smell.
- **Author `permissions.json` by hand as the source of truth.** Loses types and the
  keys→roles referential check the tool does today; inverts the current (correct) direction
  where the surface flows *from* typed code.
- **A runtime self-describe endpoint instead of a manifest field.** Already rejected in D-39
  and still right: admission needs the surface *before* the version serves, and must not run
  untrusted code to learn it. (A read-only `/registry` on a *running, already-admitted* version
  already exists for tenant-facing views — that is a consumer, not the source.)
- **A mutable "current permissions" table in the control plane.** D-39's rejection stands: a
  second source of truth for a code-declared fact drifts by design.

## 6. Rollout

Additive and staged; each step is independently shippable behind the two checkpoints.

1. Add `definePermissions()` to `contracts`; migrate each vertical's `provision.ts` to it and
   delete the `seed.ts` re-exports. Point `permission-diff.mts` at the declared entry and drop
   the `seed.ts` scan. `PERMISSIONS.md` output stays **byte-identical**, so `--check` proves the
   migration is inert.
2. Switch `push` to derive the registry from the built `permissions` entry; stop reading (and
   emitting) `permissions.json`; delete the committed files. Digest is unchanged (same content),
   provable by comparing a push before/after.
3. Make `deployManifest.registry` required and `push` refuse an absent surface. Ship the CLI +
   control plane together (one friendly check, one gate).

Step 2 is the reversible one: if deriving-from-build is fragile, stop at step 1's artifact and
keep reading the file (the §5 fallback) — steps 1 and 3 stand on their own.

## 7. Decision-log entry — landed as D-47 (awaiting ratification)

> Filed as [`docs/decisions/D-047-…`](../decisions/). The draft below numbered itself **41**, which
> master-plan D-41 (the scope-local entitlements projection, #304) already held; the Phase-2 log
> split found the collision and assigned the next free number.

> **41 · Permission registry is a required, TypeScript-derived manifest field** — completes
> D-39 and retires its checked-in machine artifact. The surface is declared once via a typed
> `definePermissions()` (compile-checked), discovered from a declared entry rather than a
> by-name `seed.ts` re-export, and the wire registry is *derived at push* from the built entry
> — no `permissions.json` in git. `deployManifest.registry` becomes required; a missing surface
> is a hard error at both the CLI and the trust boundary; honest-empty stays expressible only
> explicitly. `PERMISSIONS.md` remains the checked-in human review artifact. Rejected:
> hand-authored JSON, `seed.ts` discovery, a self-describe endpoint, a mutable CP table;
> the checked-in JSON is retained only as a fallback if push-time derivation proves fragile.
> *Why:* D-39 made the content drift-proof but left the mechanism opt-out-able by convention and
> introduced a machine-only generated file in git — both are the derived-state-that-drifts this
> design refuses everywhere else.
