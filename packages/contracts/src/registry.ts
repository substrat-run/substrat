import { z } from 'zod';
import { instant, permissionKey, tenantId, verticalSlug } from './ids.js';
import { envVarSpec, capability } from './manifest.js';
import { declaredSurface } from './routing.js';

/**
 * The vertical + version registry (#31 step 1; D-33's milestone one).
 *
 * Today a scope carries a nullable `vertical` STRING — a label nothing validates and
 * nothing can be pinned to. That is enough to say "this scope runs Callout" and not
 * enough to say *which Callout*, which is what dev/staging/prod and preview
 * deployments are: the same vertical at different versions.
 *
 * The registry makes a version a real record with digests, so promotion can compare
 * two of them, and an admission status, so **push is not live**.
 */

/** Where a vertical came from. `builtin` is one we ship; the others are a customer's. */
export const verticalSource = z.enum(['builtin', 'git', 'cli']);
export type VerticalSource = z.infer<typeof verticalSource>;

export const vertical = z.object({
  slug: verticalSlug, // stable, human-readable; `<tenantSlug>/<name>` for a builder, bare for platform
  name: z.string().min(1),
  source: verticalSource,
  /**
   * The tenant that OWNS this vertical (builder-plane.md). `null` = platform-owned —
   * a first-party vertical (Callout, the dashboard). A builder-pushed vertical is owned
   * by the pushing tenant, and its slug is prefixed `<tenant>/<name>`. Ownership is the
   * gate for who may push new versions of it + manage its non-prod channels (Phase 2).
   */
  ownerTenant: tenantId.nullable(),
  /**
   * The vertical's declared environment (its `moduleManifest.envSpec`), carried on the
   * registry so a host/console can render a config form for ANY registered vertical —
   * a bundled builtin or a pushed builder vertical — without loading its code. Optional
   * and additive (D-28): a vertical that declares no config omits it. This is what makes
   * "opt into a settings form by declaring `envSpec` in your manifest" flow automatically.
   */
  envSpec: z.array(envVarSpec).optional(),
  /**
   * Registry-driven install (marketplace-publish.md §3) — carried on push from the manifest,
   * so the dashboard installs a vertical without a hardcoded catalog entry. `entitlements` +
   * `ownerGrants` are what an install grants (scope-provisioning verticals); `provides` /
   * `requires` are the capabilities the connection store wires (§4). All additive (D-28);
   * stored as one `install_spec` json column adapter-side.
   */
  entitlements: z.array(z.string()).optional(),
  ownerGrants: z.array(permissionKey).optional(),
  provides: z.array(capability).optional(),
  requires: z.array(capability).optional(),
  /**
   * The surfaces the vertical declares it serves (K-26 multi-surface; labels only —
   * nothing platform-side branches on them). Rides the same install_spec bag as the
   * fields above: a hostname-binding picker for the dashboard, and a push-time warning
   * when a bound surface vanishes from a new version's declaration. Optional and
   * additive (D-28); free-text surfaces stay valid for a vertical that declares none.
   */
  surfaces: z.array(declaredSurface).optional(),
  /**
   * Published to the PUBLIC marketplace (marketplace-publish.md §2/§5). `false` = private to
   * its `ownerTenant`. First-party verticals are seeded `true`; a builder vertical flips it via
   * the staff-reviewed publish action (a later phase). Its own column adapter-side — set on
   * insert, NEVER touched by a re-push refresh of a `git`/`cli` vertical, so re-pushing a
   * published vertical can't silently unpublish it (publish is a distinct action from push).
   * For a BUILTIN vertical it IS refreshed on re-registration: there `listed` is seed
   * metadata (derived from the catalog's `connected` flag), and the re-seed each boot must
   * be able to list a row first registered before it was listable.
   */
  listed: z.boolean().default(false),
  /**
   * A builder's pending PUBLISH REQUEST (marketplace-publish.md §5) — when the owner asked for
   * the vertical to be listed, awaiting staff review. `null` = no request (or already
   * resolved). Set by `requestPublish`; cleared when staff `setVerticalListed`.
   */
  publishRequestedAt: instant.nullish(),
  /**
   * New installs BLOCKED — the staff kill-switch for a vertical that should take no
   * more instances (deprecated, misbehaving, or being retired). Orthogonal to
   * `listed` (visibility): a blocked vertical is hidden from the install catalog AND
   * the control plane refuses to provision an instance of it, for everyone including
   * its owner. Existing scopes keep running untouched — this gates provisioning, not
   * serving. Never set at registration; flipped by staff (`setVerticalInstallsBlocked`).
   */
  installsBlocked: z.boolean().default(false),
  createdAt: instant,
});
export type Vertical = z.infer<typeof vertical>;

export const registerVerticalInput = vertical
  .pick({ slug: true, name: true, source: true, envSpec: true, entitlements: true, ownerGrants: true, provides: true, requires: true, surfaces: true, listed: true })
  .extend({
  // Optional on input — a staff/platform push omits it (⇒ platform-owned).
  ownerTenant: tenantId.nullable().default(null),
});
// `z.input`, not `z.infer`: `ownerTenant` is optional for a caller (the default fills
// it), so an existing platform-owned registration keeps passing `{slug, name, source}`.
export type RegisterVerticalInput = z.input<typeof registerVerticalInput>;

/**
 * Whether a version may be bound to a scope.
 *
 * `pending` is what a push produces. The admission gates — boundary-lint, the
 * migration diff and the permission diff — decide the rest, and binding a scope is a
 * separate, reviewable step. That separation is the whole point: it is what stops a
 * push being a deploy, and it puts the two human checkpoints where the blast radius
 * is (promotion) rather than where the typing is (merge).
 */
export const admissionStatus = z.enum(['pending', 'admitted', 'rejected']);
export type AdmissionStatus = z.infer<typeof admissionStatus>;

/**
 * The `admissionNote` a PRIVATE vertical's version carries when it lands admitted
 * straight from a push (builder-plane.md §4-revised). A private vertical's blast
 * radius is its own tenant — the sandbox contract, not a staff read of an opaque
 * digest, is what protects the platform — so its versions self-admit. The note is
 * the distinction that matters at the ONE remaining staff seam: publish. Listing a
 * vertical exposes it to every tenant, so `setVerticalListed` refuses while prod
 * points at a version whose admission is only this note, and a staff `admitVersion`
 * clears it (the human vouch, recorded).
 */
export const AUTO_ADMISSION_NOTE = 'auto-admitted: private vertical';

/**
 * One published version of a vertical.
 *
 * The three digests are what make promotion answerable. "Has the permission surface
 * changed between the version in prod and the one I am promoting?" is a string
 * comparison here, where today it is a person remembering to look — and per §4 of the
 * plan, a checkpoint that can be skipped is not a checkpoint.
 */
export const verticalVersion = z.object({
  id: z.string().min(1), // ULID
  verticalSlug,
  version: z.string().min(1), // the builder's label — semver, a git sha, whatever they push
  manifestDigest: z.string().min(1),
  permissionDigest: z.string().min(1),
  migrationDigest: z.string().min(1),
  /** How to reach the deployment that serves it. Null until something is deployed. */
  deploymentRef: z.string().min(1).nullable(),
  admission: admissionStatus,
  /** Why it was rejected, when it was. Null otherwise. */
  admissionNote: z.string().nullable(),
  createdAt: instant,
});
export type VerticalVersion = z.infer<typeof verticalVersion>;

export const publishVersionInput = verticalVersion.pick({
  id: true,
  verticalSlug: true,
  version: true,
  manifestDigest: true,
  permissionDigest: true,
  migrationDigest: true,
  deploymentRef: true,
});
export type PublishVersionInput = z.infer<typeof publishVersionInput>;

/**
 * Where a version is promoted to (#31 step 2).
 *
 * A channel is a named pointer per vertical. Promotion moves it. Dev, staging and
 * prod are therefore the same vertical at different versions, which is the sentence
 * the registry existed to make sayable.
 */
export const channelName = z.enum(['dev', 'staging', 'prod']);
export type ChannelName = z.infer<typeof channelName>;

export const verticalChannel = z.object({
  verticalSlug,
  channel: channelName,
  versionId: z.string().min(1),
  updatedAt: instant,
});
export type VerticalChannel = z.infer<typeof verticalChannel>;

/**
 * One promotion, kept forever (append-only). The channel row is a pointer — it
 * remembers only where it points now. History is what makes rollback a *choice
 * among moments* rather than an archaeology dig through the admin log: each entry
 * names what went live, what it replaced, who moved the pointer and exactly when.
 *
 * `at` doubles as the data-recovery anchor: it is the instant to hand to the DO
 * storage PITR API (`getBookmarkForTime`, preview-and-snapshots.md §7) when a
 * rollback needs the database as it was *before* this go-live — which is why the
 * moment is recorded here, at promotion, and not reconstructed later.
 */
export const channelHistoryEntry = z.object({
  id: z.string().min(1), // ULID — orders the timeline
  verticalSlug,
  channel: channelName,
  versionId: z.string().min(1),
  /** What the channel pointed at before this promotion. Null on the first one. */
  fromVersionId: z.string().min(1).nullable(),
  actor: z.string().min(1),
  at: instant,
});
export type ChannelHistoryEntry = z.infer<typeof channelHistoryEntry>;

/**
 * What a promoter must acknowledge, per §4's two human checkpoints.
 *
 * Today the migration and permission diffs are a MERGE-time convention: CI renders
 * them and a human is expected to read them, but nothing connects that reading to
 * the moment the change reaches anyone. Promotion is that moment — the blast radius
 * is here, not at the merge.
 *
 * So promotion refuses when a digest differs and the corresponding flag is unset,
 * naming both digests in the error. The flag is one deliberate act rather than a
 * gate that can be passed by not noticing, and the acknowledgement lands in the
 * admin log — which turns "someone reviewed it" from a claim into evidence.
 */
export const promotionAcknowledgement = z.object({
  permissionChange: z.boolean().optional(),
  migrationChange: z.boolean().optional(),
});
export type PromotionAcknowledgement = z.infer<typeof promotionAcknowledgement>;
