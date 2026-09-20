/**
 * engine-invites' event contract (#696) — what a VERTICAL imports so that
 * consuming this engine by event is checked rather than guessed.
 *
 * TYPES ONLY. The runtime contract is still the fat payload and **the
 * consumer's own Zod parse** (kernel `EventContract`,
 * `packages/kernel/src/scope-host.ts`); `emitInvitesEvent` forwards to
 * `ctx.emit` unchanged — one extra call in the stack, and no change in what is
 * emitted.
 *
 * VERTICAL-FACING ONLY. A sibling engine consuming one of these must NOT import
 * it — R1 (star topology) forbids the import, and the defensive parse is what
 * lets an engine ride out #128's dual-emit window. The same holds for the
 * connector executor behind `member.add-requested`: it is host code outside this
 * scope, and it parses.
 *
 * **Identifiers never appear.** Every payload here is `piiClass: 'none'` and
 * that is a claim about the fields, not a default: the invited identifier is
 * hashed before it touches storage and is on no event, which is what keeps this
 * surface non-enumerable. A field added here must keep that true.
 *
 * **No completion group.** A group says two events report ONE fact by different
 * routes, so handling a subset strands the entity. `invites.accepted` and
 * `member.add-requested` come closest — they are emitted together by the same
 * call — but they report two different facts to two different readers: the
 * invitation is settled, and a membership must now be written by an executor
 * outside this scope (K-22 §4.2). A vertical reading only the first is not
 * making the mistake #696 was filed for.
 *
 * Additive, like every other engine surface: a new event type may appear, an
 * existing payload field does not change shape without a `schemaVersion` bump.
 */
import type { DomainEventInput } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

/**
 * An invitation was recorded.
 *
 * Notably absent: who it was sent to. The identifier is hashed before storage
 * and never leaves the engine, so this event names an organisation and a role
 * and nobody at all.
 */
export interface InvitesSentPayload {
  invitationId: string;
  orgId: string;
  roleKey: string;
  /** ISO 8601. An invitation past this reads `expired` without the row being touched. */
  expiresAt: string;
}

/**
 * An invitation was accepted, by the principal who accepted it.
 *
 * `principal` is a ULID, not an identifier — it names nobody outside the
 * platform, and without it the event would describe an acceptance by no one.
 */
export interface InvitesAcceptedPayload {
  invitationId: string;
  orgId: string;
  roleKey: string;
  principal: string;
}

/** An outstanding invitation was withdrawn. */
export interface InvitesRevokedPayload {
  invitationId: string;
}

/**
 * The connector seam's request (K-22 §4.2).
 *
 * The engine cannot write a membership tuple — it is tenant-wide directory
 * state, outside this scope's transaction — so it asks and an executor effects.
 * Deliberately fat (D-19): that executor must never need a cross-module read to
 * act, which is why the tenant is on the payload rather than inferred.
 */
export interface MemberAddRequestedPayload {
  principal: string;
  orgId: string;
  tenantId: string;
  roleKey: string;
  invitationId: string;
}

/**
 * engine-invites' event contract — the four event types this engine emits and
 * the payload each one carries.
 *
 * Satisfies the kernel's `EventContract`, so a vertical writes
 * `consumersFor<[InvitesEvents]>()({ … })` and gets typed payloads plus
 * rejection of an event type this engine does not emit.
 */
export type InvitesEvents = {
  events: {
    'invites.sent': InvitesSentPayload;
    'invites.accepted': InvitesAcceptedPayload;
    'invites.revoked': InvitesRevokedPayload;
    /** Not in this engine's namespace on purpose — it is addressed to an executor. */
    'member.add-requested': MemberAddRequestedPayload;
  };
};

/** Every event type this engine emits. */
export type InvitesEventType = keyof InvitesEvents['events'];

/**
 * `ctx.emit`, with the event type and its payload welded together.
 *
 * This is what stops `InvitesEvents` becoming a description nothing holds in
 * agreement. `ctx.emit` takes `payload: unknown`, so a map declared beside the
 * emit sites would be checked by nobody and could rot silently into a lie a
 * vertical compiles against. Routing every emit through here makes the map the
 * *source*: rename a payload field on one side and the other side fails to
 * compile, and emitting a type the map does not declare fails too.
 *
 * Zero runtime behaviour of its own — it forwards to `ctx.emit` unchanged.
 */
export function emitInvitesEvent<K extends InvitesEventType>(
  ctx: OperationContext,
  event: Omit<DomainEventInput, 'type' | 'payload'> & {
    type: K;
    payload: InvitesEvents['events'][K];
  },
): void {
  ctx.emit(event);
}
