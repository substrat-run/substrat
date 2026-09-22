import { z } from 'zod';
import { permissionKey, scopeId, tenantId, verticalSlug } from './ids.js';

/**
 * Peers (#1706): another vertical of the SAME tenant, calling this one's operations through the
 * platform — with no token, no pasted API key, no hostname and no outbound allowlist entry.
 *
 * The shape of the whole mechanism, so the pieces below read in place:
 *
 * - **The target declares who may call it** — `peers` in its module manifest (`peerSpec`): the
 *   calling vertical's slug, the operations it may invoke, and the keys it holds while doing so.
 *   The keys are seated at provisioning as `vertical:<slug>` tuples, exactly as a schedule's are
 *   as `system:<module>` ones, and are rendered in the vertical's PERMISSIONS.md — so widening
 *   what another app may do is a reviewed permission diff, like any other widening.
 * - **The platform says who is calling**, at a hop the caller cannot forge; the caller holds no
 *   credential that names it. On the pure host that hop is the local broker, in-process.
 * - **The caller is an actor of its own** on the spine: `{ vertical, scope }` (`verticalActor`).
 * - **Revocation is the next call.** A tenant's kill switch per (scope, peer) tombstones the
 *   peer's grants and blocks the seat (#1666's design, generalised), and a caller that is no
 *   longer a live primary instance in the tenant is refused by the platform before any door.
 */

/**
 * WHO is calling: the calling vertical's registry slug, and the instance (scope) that called.
 * The platform supplies it — never the request — and the target's door records it whole.
 */
export const verticalCaller = z.object({ vertical: verticalSlug, scope: scopeId });
export type VerticalCaller = z.infer<typeof verticalCaller>;

/** The most operations one peer entry may allow, and the most keys it may hold. */
export const PEER_OPERATIONS_MAX = 64;
export const PEER_PERMISSIONS_MAX = 32;

const noDuplicates = <T>(items: readonly T[]): boolean => new Set(items).size === items.length;

/**
 * One declared peer — "vertical X, in this tenant, may invoke these operations holding these
 * keys" — as a module manifest's `peers` entry.
 *
 * - `operations` is the door's allowlist, refused BEFORE the handler (not a K-35 denial: no key
 *   was checked). It may be EMPTY: a receive-only peer, which holds keys (e.g. the read permission
 *   an exported event is gated by, #1705) and may call nothing.
 * - `permissions` is what `vertical:<slug>` holds on the scope while any of those operations runs,
 *   and it may NOT be empty: a peer entry that grants nothing declares nothing, and the right to
 *   receive is itself a key.
 *
 * Operation names are not checked against the module's own operations here: a vertical may allow
 * an engine operation it composes, and the host's registry is what knows every name. An unknown
 * name admits nothing (the door answers `not_found`, as for any caller), and `lint:permissions`
 * reports it.
 */
export const peerSpec = z.object({
  vertical: verticalSlug,
  operations: z
    .array(z.string().min(1))
    .max(PEER_OPERATIONS_MAX)
    .refine(noDuplicates, { message: 'a peer lists each operation at most once' }),
  permissions: z
    .array(permissionKey)
    .min(1, {
      message:
        'a peer holds at least one key — an entry that grants nothing declares nothing (a receive-only ' +
        'peer names the key its deliveries are gated by)',
    })
    .max(PEER_PERMISSIONS_MAX)
    .refine(noDuplicates, { message: 'a peer lists each permission at most once' }),
});
export type PeerSpec = z.infer<typeof peerSpec>;

/** One instance of a vertical, as the directory resolves it for a tenant. */
export const verticalInstance = z.object({ tenantId, scopeId, vertical: verticalSlug });
export type VerticalInstance = z.infer<typeof verticalInstance>;

/**
 * "The instance of vertical Y in tenant T" (#1706), as the directory answers it — the same answer
 * everywhere it is asked (the control plane's directory, the pure host, the local broker), because
 * all of them apply `resolveVerticalInstanceFrom` from the kernel.
 *
 * Only a PRIMARY (neither a fork nor a preview) and ACTIVE scope of that tenant is a candidate:
 * - `resolved` — exactly one.
 * - `not-installed` — none. The tenant has not installed Y, or only a preview/fork of it, or its
 *   instance is suspended or archived. One answer, deliberately: which of those it is belongs to
 *   the tenant's console, not to another app's error message.
 * - `ambiguous` — more than one. Refused rather than guessed: a tenant may run two instances of
 *   one vertical, and picking one would route one app's data into the other. A binding that names
 *   the instance is what settles it (the auth-server pick's shape), not a tie-break rule.
 */
export const verticalResolution = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('resolved'), instance: verticalInstance }),
  z.object({ outcome: z.literal('not-installed'), tenantId, vertical: verticalSlug }),
  z.object({
    outcome: z.literal('ambiguous'),
    tenantId,
    vertical: verticalSlug,
    count: z.number().int().min(2),
  }),
]);
export type VerticalResolution = z.infer<typeof verticalResolution>;

/**
 * The per-(scope, peer) kill switch (#1706) — a tenant turning one calling vertical off on one
 * scope, and back on, WITHOUT a push. `HostAdmin.revokeFromPeer` / `restoreToPeer`, the mirror of
 * the schedule switch (#1666): OFF tombstones every grant `vertical:<slug>` holds on the scope and
 * makes an OFF marker live, so neither a check nor a provisioning seat can give the peer anything
 * back until `restoreToPeer`. `reason` lands in the admin log beside the actor.
 */
export const peerSwitch = z.object({
  vertical: verticalSlug,
  node: z.object({ tenantId, scopeId }),
  reason: z.string().trim().min(1).max(500),
});
export type PeerSwitch = z.infer<typeof peerSwitch>;

/**
 * What the far end of the peer switch did in the scope's own storage — `held: false` when the
 * scope holds neither a grant nor a marker for that peer (nothing was written). The same shape
 * as the schedule switch's outcome, because it is the same statement underneath.
 */
export const peerSwitchOutcome = z.object({
  held: z.boolean(),
  changed: z.boolean(),
  permissions: z.array(permissionKey),
});
export type PeerSwitchOutcome = z.infer<typeof peerSwitchOutcome>;

/** What `revokeFromPeer` / `restoreToPeer` answer: the position the switch is now in. */
export const peerSwitchResult = z.object({
  operationId: z.string().min(1),
  vertical: verticalSlug,
  calls: z.enum(['on', 'off']),
  changed: z.boolean(),
  /** The grants this call tombstoned (off) or restored (on), by permission key. */
  permissions: z.array(permissionKey),
});
export type PeerSwitchResult = z.infer<typeof peerSwitchResult>;

/**
 * One key of `ScopeHost.peerCovers`: does `vertical:<slug>` hold it at the scope node RIGHT NOW —
 * the checker's own answer, so a peer switched off holds nothing.
 */
export const peerCoverage = z.object({ permission: permissionKey, held: z.boolean() });
export type PeerCoverage = z.infer<typeof peerCoverage>;
