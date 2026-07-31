import { z } from 'zod';
import { moduleId, permissionKey } from './ids.js';
import { eventType } from './events.js';

// The manifest is what makes a module self-describing — to agents now, to
// strangers buying it later (§5.6 of the plan, §7.1 of the design doc).

export const semverVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/);

export const permissionDeclaration = z.object({
  key: permissionKey,
  description: z.string().min(1), // fuel for the human-readable permission diff (§4.3)
});
export type PermissionDeclaration = z.infer<typeof permissionDeclaration>;

export const eventTypeRef = z.object({
  type: eventType,
  schemaVersion: z.number().int().positive(),
});
export type EventTypeRef = z.infer<typeof eventTypeRef>;

export const manifestGuard = z.object({
  before: z.string().min(1), // operation name, e.g. 'bike-shop/close-repair'
  predicate: z.string().min(1), // named predicate, e.g. 'protocol/all-signed'
  config: z.record(z.string(), z.unknown()).default({}), // predicate-owned shape
});
export type ManifestGuard = z.infer<typeof manifestGuard>;

// A RECURRING-WORK declaration (#383): "invoke this operation on every live scope
// of mine, on this cadence." The platform sweep enumerates the vertical's live
// scopes and fires the operation under a SYSTEM actor (`{ system: <moduleId> }`),
// never a human — the attribution laundering an out-of-band cron-as-a-person would
// cause is exactly what this exists to end.
//
// `permissions` names the keys the operation checks. They are projected as grants
// to the module's system principal at scope provisioning, so `ctx.check` resolves
// for the schedule the same way it does for anyone else (it stays the single gate),
// AND they land in the reviewable permission diff — widening what a schedule may do
// cannot merge silently. A schedule can do exactly what it declares here, no more.
export const scheduleSpec = z.object({
  operation: z.string().min(1), // 'contract/advance-starts' — a registered module/verb op id
  // How often. Coarse-bounded by the sweep interval (~2 min alarm / ~15 min cron):
  // a schedule can never fire more often than the sweep runs; `everyMinutes` is the floor.
  cadence: z.object({ everyMinutes: z.number().int().positive() }),
  input: z.record(z.string(), z.unknown()).optional(), // static input each run; the op re-parses it
  permissions: z.array(permissionKey).default([]), // what the op checks → system grant + review surface
});
export type ScheduleSpec = z.infer<typeof scheduleSpec>;

// A single declared environment variable — the config a deployment must provide,
// self-describing so a host/console can render a settings form (placeholder +
// description) and validate the required keys before deploy. `secret: true` marks a
// value that is write-only in the UI and delivered as a secret, never echoed back.
export const envVarSpec = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/), // ADMIN_PASSWORD
  label: z.string().optional(), // "Admin password" — falls back to the key
  description: z.string().min(1), // shown under the field
  placeholder: z.string().optional(), // "at least 8 characters"
  required: z.boolean().default(false),
  secret: z.boolean().default(false), // masked + write-only + delivered as a secret
  default: z.string().optional(), // non-secret default, prefilled
  group: z.string().optional(), // "Bootstrap" · "Email" — form sectioning
});
export type EnvVarSpec = z.infer<typeof envVarSpec>;

/**
 * A named capability a vertical **provides** or **requires** (e.g. `oidc-issuer`), wired
 * tenant-side through the connection store (marketplace-publish.md §4). Lowercase kebab.
 * Identity is per-tenant, so one provider (an auth-server) serves all a tenant's requiring
 * verticals — the connection binds them, nothing is bundled into a consumer's manifest.
 */
export const capability = z.string().regex(/^[a-z][a-z0-9-]*$/);
export type Capability = z.infer<typeof capability>;

/** The runtime resolution of an `envSpec` against a raw environment. */
export interface ResolvedEnv {
  /** Each declared key → its value (from `raw`, else the spec's `default`). */
  values: Record<string, string | undefined>;
  /** Declared `required` keys that resolved to nothing — a deploy misconfiguration. */
  missingRequired: string[];
}

/**
 * Resolve a declared `envSpec` against a raw environment (a Worker `env`, `process.env`, …).
 * Reads ONLY the declared keys, so the manifest is the single source of what an app consumes
 * (a key it doesn't declare, it doesn't read); applies each spec `default`; and reports absent
 * `required` keys. Never throws — the caller decides whether a missing required key is fatal
 * (a hosted vertical may have a per-scope fallback), and the config form is where a bad deploy
 * is blocked. Non-string raw values (e.g. a binding) are ignored — the spec covers string config.
 */
export function resolveEnvSpec(spec: EnvVarSpec[], raw: Record<string, unknown>): ResolvedEnv {
  const values: Record<string, string | undefined> = {};
  const missingRequired: string[] = [];
  for (const s of spec) {
    const rawVal = raw[s.key];
    const v = typeof rawVal === 'string' && rawVal !== '' ? rawVal : s.default;
    values[s.key] = v;
    if (s.required && (v === undefined || v === '')) missingRequired.push(s.key);
  }
  return { values, missingRequired };
}

export const moduleManifest = z.object({
  id: moduleId, // '@substrat-run/engine-workorder'
  version: semverVersion,
  kernelContract: z.string().min(1), // semver range of the kernel API it targets
  permissions: z.array(permissionDeclaration),
  events: z.object({
    emits: z.array(eventTypeRef),
    consumes: z.array(eventTypeRef), // star topology: consumes types, never siblings (D-19)
  }),
  migrations: z.object({
    journalDir: z.string().min(1), // Drizzle journal location within the package
    compatibleFrom: z.string().min(1), // skew window: oldest schema this code tolerates
  }),
  attachmentTargets: z.array(
    z.object({
      entityType: z.string().min(1),
      readPermission: permissionKey, // attachment access checks the owning entity's key
    }),
  ),
  // Declared entity parent edges, e.g. workorder → facility. Permission flows
  // along these in the tuple evaluator's fixed algebra (design doc §4.2 rule 3,
  // depth-capped) — how entity-narrowed grants resolve.
  entityRelations: z
    .array(
      z.object({
        entityType: z.string().min(1), // 'workorder'
        parentType: z.string().min(1), // 'facility'
      }),
    )
    .optional(),
  // MANIFEST-DECLARED OPERATION GUARDS (engine-protocol.md §6, kernel-design
  // open question 11, milestone C). A guard is an UNCONDITIONAL pre-condition
  // on a registered OPERATION: the kernel resolves `predicate` (a named
  // predicate contributed by some registered module) and runs it inside the
  // operation's own transaction, before the handler. A throw blocks the
  // operation and rolls back — fail closed.
  //
  // Keyed on operations, never on engine transitions: the kernel sees
  // operations, and must not learn engine internals (star topology). Policy
  // that is CONDITIONAL on vertical data (e.g. "only montage orders need an
  // self-inspection") stays vertical-composed glue inside the operation — see
  // demos/callout. Guards live here so that adding or DROPPING a compliance gate
  // lands in the reviewable manifest diff.
  //
  // Optional: every pre-milestone-C manifest still parses unchanged (D-28,
  // additive-only surface).
  guards: z.array(manifestGuard).optional(),
  // RECURRING WORK (#383). A vertical declares operations the platform invokes on
  // every live scope of it, on a cadence, under a system actor — the seam a domain
  // rule triggered by the passage of time (a contract that activates on its
  // start_date) had no way to reach. One phase of `runPlatformSweep`; see scheduleSpec.
  //
  // Optional: additive-only surface (D-28) — every pre-#383 manifest still parses.
  schedules: z.array(scheduleSpec).optional(),
  // OPERATION WITHDRAWAL (K-17, the complement that makes guards enforceable).
  // Operation names whose DEFAULT BINDING this module suppresses in the host it
  // registers into: the name stops resolving — an invoke fails 'unknown
  // operation', exactly as if it had never been registered. Order-independent
  // (withdraw before or after the owning module registers) and opt-in.
  //
  // Withdrawal removes the BINDING, not the capability: the engine's in-scope
  // function (e.g. `closeWorkOrder`) stays composable, which is how a vertical
  // re-offers the same transition behind its own guarded operation. A module may
  // not withdraw its own operations.
  //
  // Optional: additive-only surface (D-28).
  withdraws: z.array(z.string().min(1)).optional(),
  entitlementKey: z.string().regex(/^[a-z0-9-]+$/), // the SKU flag that gates loading (D-20)
  // DECLARED ENVIRONMENT. Optional, additive-only (D-28): the config a deployment
  // must provide, self-describing so a host/console can render a settings form and
  // validate required keys. Coherent for a STANDALONE-deployed app (its own worker
  // script owns its own secrets); a hosted dispatch vertical (one script serving many
  // tenants' scopes) delivers per-tenant config through the connection store instead,
  // never per-app worker secrets.
  envSpec: z.array(envVarSpec).optional(),
  // MARKETPLACE / registry-driven install (marketplace-publish.md). All additive (D-28),
  // carried on push so the dashboard installs a vertical without a hardcoded catalog entry.
  //
  // `ownerGrants` — the permissions a fresh install's OWNER is granted on day one. The role
  // TABLE stays vertical-owned + runtime-customizable (three-layer rule); only this day-one
  // grant is declared. Scope-provisioning verticals only; a pure capability provider omits it.
  ownerGrants: z.array(permissionKey).optional(),
  // The full entitlement set an install grants (the vertical's own + any it composes). Absent
  // ⇒ derive from `entitlementKey`.
  entitlements: z.array(z.string().regex(/^[a-z0-9-]+$/)).optional(),
  // Capabilities this vertical PROVIDES (auth-server → `oidc-issuer`) and REQUIRES (an app that
  // delegates auth → `oidc-issuer`). A consumer binds a provider tenant-side via the connection
  // store (§4) — no `kind` flag, no bundling.
  provides: z.array(capability).optional(),
  requires: z.array(capability).optional(),
  api: z.string().optional(), // path to emitted OAS for the HTTP surface, if any (D-22)
  searchables: z
    .array(
      z.object({
        entityType: z.string().min(1),
        fields: z.array(z.string().min(1)).min(1),
      }),
    )
    .optional(),
  // UI contributions, composed into the vertical's app at BUILD time by the
  // shell (design doc §7.4, K-15). Component values are module-relative import
  // paths. All contributions are permission-keyed; the shell renders them
  // permission-aware from the proof-path checker.
  ui: z
    .object({
      routes: z
        .array(z.object({ path: z.string().min(1), screen: z.string().min(1), permission: permissionKey }))
        .optional(),
      nav: z
        .array(
          z.object({
            label: z.string().min(1), // i18n key
            icon: z.string().optional(),
            to: z.string().min(1),
            permission: permissionKey,
          }),
        )
        .optional(),
      // the EntityRef → view registry: cross-engine rendering without imports
      entityViews: z
        .array(z.object({ entityType: z.string().min(1), view: z.string().min(1) }))
        .optional(),
      widgets: z
        .array(z.object({ slot: z.string().min(1), component: z.string().min(1), permission: permissionKey }))
        .optional(),
      settingsPanels: z
        .array(z.object({ label: z.string().min(1), component: z.string().min(1), permission: permissionKey }))
        .optional(),
    })
    .optional(),
});
export type ModuleManifest = z.infer<typeof moduleManifest>;
