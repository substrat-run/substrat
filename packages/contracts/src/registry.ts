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
  /**
   * The DECLARED provisioner intent (#455, the request half of #412's capability): the
   * target verticals this manager provisions tenants OF, carried on push from the
   * manifest's `provisions`. Declaration is a request, never a grant — it feeds the
   * console's review surface (declared-but-ungranted renders as *requested*, the same
   * shape as a publish request) and, once granted, bounds `provision-tenant` to the
   * declared targets (#412 invariant 4). Rides the install_spec bag: refreshed on every
   * re-push, exactly because it grants nothing by itself.
   */
  provisions: z.array(verticalSlug).optional(),
  /**
   * The DECLARED email-sender intent (#303, the request half of the `emailSender` capability):
   * this vertical wants to send transactional mail (reset/verification/invites), carried on push
   * from the manifest's `sendsEmail`. Declaration is a request, never a grant — it feeds the
   * console's review surface (declared-but-ungranted renders as *requested*, the same shape as
   * a publish request or a provisioner request). Rides the install_spec bag: refreshed on every
   * re-push, exactly because it grants nothing by itself.
   */
  sendsEmail: z.boolean().optional(),
  /**
   * Holds the EMAIL-SENDER capability (#303) — this vertical's scopes may POST to the control
   * plane's `/internal/email/send` relay and have transactional mail sent on their behalf. A
   * directory-backed staff grant, not deployment config: flipped by `setVerticalEmailSender`,
   * audited, and read by the relay handler on every send. Like `tenantProvisioner`, never set at
   * registration and NEVER touched by a re-push refresh — pushing new code must not be able to
   * grant (or silently keep) outbound authority. The platform holds the actual Email Sending
   * credential; the grant only says "the relay will send for this vertical".
   */
  emailSender: z.boolean().default(false),
  /**
   * Holds the TENANT-PROVISIONER capability (#412, platform-intents.md) — this vertical's
   * scopes may enqueue `provision-tenant` / `set-entitlements` intents that the platform
   * executes (a manager console whose job is to add customer tenants). A directory-backed
   * staff grant, not deployment config: flipped by `setVerticalTenantProvisioner`, audited,
   * and read by the drain's `admitManager` at execution time. Like `installsBlocked`,
   * never set at registration and NEVER touched by a re-push refresh — pushing new code
   * must not be able to grant (or silently keep) platform authority. The grant's *scope*
   * is the declared `provisions` above: the flag says "may act as a manager", the
   * declaration says "of what".
   */
  tenantProvisioner: z.boolean().default(false),
  /**
   * The vertical's ONE stable serving script (#286). A Durable Object namespace
   * belongs to its script, so this unchanged name is what makes a promote carry every
   * scope's data forward: promote re-uploads the new version's bundle onto it in
   * place. `null` = nothing served in-place yet (legacy per-version dispatch).
   */
  servingRef: z.string().min(1).nullish(),
  /**
   * The version whose bundle the serving script currently runs. Normally the prod
   * channel's version; TRAILS it when a promote moved the channel but the serve
   * upload failed — visible state, retried by promoting again.
   */
  servingVersionId: z.string().min(1).nullish(),
  createdAt: instant,
});
export type Vertical = z.infer<typeof vertical>;

/**
 * What the serving script currently declares (#286) — the base the NEXT in-place
 * upload diffs against. Directory-recorded at each successful serve, so no deploy
 * ever queries Cloudflare to guess live state: `doClasses` yields the DO-class
 * migration DELTA (re-declaring a live class is an upload error), `migrationTag`
 * the `old_tag` it rides under.
 */
export const verticalServingState = z.object({
  ref: z.string().min(1),
  versionId: z.string().min(1),
  doClasses: z.array(z.string().min(1)),
  migrationTag: z.string().min(1),
});
export type VerticalServingState = z.infer<typeof verticalServingState>;

export const registerVerticalInput = vertical
  .pick({ slug: true, name: true, source: true, envSpec: true, entitlements: true, ownerGrants: true, provides: true, requires: true, provisions: true, sendsEmail: true, surfaces: true, listed: true })
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
/**
 * Where ONE pushed version's code came from — self-reported by the CLI at push time.
 * `git` is a push from CI (the generated deploy workflow runs `substrat push` inside
 * GitHub Actions, so the CLI detects the runner and attaches the repo/commit/ref it
 * built from); `cli` is a person's terminal. Informational labeling, never authority:
 * both transports are the same authenticated push, and nothing gates on this — it
 * exists so the dashboard can answer "where did this code come from".
 */
export const versionOrigin = z.object({
  source: z.enum(['git', 'cli']),
  /** `owner/repo`, when pushed from GitHub Actions. */
  gitRepo: z.string().min(1).optional(),
  gitCommit: z.string().min(1).optional(),
  /** The branch/tag the workflow ran for (`GITHUB_REF_NAME`). */
  gitRef: z.string().min(1).optional(),
  /**
   * The push-time layer-rule gate (#955): what `substrat push`'s boundary-lint run found
   * before this version was uploaded. `passed` = every rule held; `skipped` = pushed with
   * `--skip-lint`; `none` = no module code was found, so nothing was checked. ABSENT = the
   * push carried no receipt at all — a pre-receipt CLI, or a caller that skipped the CLI
   * entirely — which reads as ungated, deliberately: the platform never lints the uploaded
   * bundle (it receives built output, not source), so the CLI's own check is the only one
   * there is, and a version that cannot show a receipt was not checked by it. Self-reported
   * like the rest of this object — a label the dashboard shows and a hook an admit policy
   * can gate on, never proof.
   */
  gate: z.enum(['passed', 'skipped', 'none']).optional(),
});
export type VersionOrigin = z.infer<typeof versionOrigin>;

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
  /** Null/absent = pushed before origin tracking (or by an old CLI). */
  origin: versionOrigin.nullish(),
  /**
   * The version's DECLARED outbound surface (#303, D-46), lifted from its stored manifest
   * so the admit checkpoint can show it without shipping N whole manifests. `[]` = no
   * direct third-party egress; null/absent = pushed by a pre-#303 CLI, so the egress
   * worker meters but does not enforce it.
   */
  outbound: z.array(z.string()).nullish(),
  createdAt: instant,
});
export type VerticalVersion = z.infer<typeof verticalVersion>;

export const publishVersionInput = verticalVersion
  .pick({
    id: true,
    verticalSlug: true,
    version: true,
    manifestDigest: true,
    permissionDigest: true,
    migrationDigest: true,
    deploymentRef: true,
    origin: true,
  })
  .extend({
    /**
     * The full pushed DeployManifest, as JSON (#286). Not part of the version record
     * the registry serves back (a list of versions should not carry N whole manifests);
     * stored so promote/backout can rebuild the serving upload's metadata — the archive
     * script keeps the module bytes, this keeps their shape. Optional: a pre-#286
     * publisher omits it, and such a version can be archived but never served in place.
     */
    manifestJson: z.string().nullish(),
  });
export type PublishVersionInput = z.infer<typeof publishVersionInput>;

/**
 * Where a version is promoted to (#31 step 2).
 *
 * A vertical has exactly ONE channel — `prod`, the serving pointer: the version an
 * install runs. The old `dev`/`staging` pointers were write-only (nothing ever served
 * or read them), so they were retired (#509): a non-prod environment is a *scope with
 * data* — a preview (`substrat preview create`), not a second pointer at the same code.
 * `prod` stays the wire name so `--promote prod`, generated CI, and existing history
 * rows keep working unchanged; the enum is what keeps it from becoming stringly-typed.
 */
export const channelName = z.enum(['prod']);
export type ChannelName = z.infer<typeof channelName>;

export const verticalChannel = z.object({
  verticalSlug,
  channel: channelName,
  versionId: z.string().min(1),
  updatedAt: instant,
  /**
   * What the stable serving script (#286) is ACTUALLY running for this vertical — only
   * meaningful for `prod`, which serves in place. A prod promote moves `versionId`
   * (the pointer, audited) BEFORE the in-place serve; `servingVersionId` advances only
   * after a serve succeeds. So `servingVersionId !== versionId` on prod is the honest
   * signal that a serve failed (or is mid-flight): the channel was promoted but the
   * scopes still run the previous code (#321). Null for a vertical with no serving
   * script yet.
   */
  servingVersionId: z.string().min(1).nullish(),
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
