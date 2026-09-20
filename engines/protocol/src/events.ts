/**
 * engine-protocol's event contract (#696) — what a VERTICAL imports so that
 * consuming this engine is checked rather than guessed.
 *
 * ## Why this file exists
 *
 * Composing an engine by CALL has been typed since the in-scope functions
 * shipped. Composing one by EVENT was three plain strings and an `unknown`: the
 * key was `string`, the payload was `unknown`, and every consumer hand-wrote the
 * shape it was handed as a cast with every field optional. That cost a live
 * vertical a production defect — it consumed `protocol.signed` and not
 * `protocol.countersigned`, and since completion rides on whoever signs LAST,
 * every multi-party contract stayed `pending` for ever while the engine held the
 * document `signed`.
 *
 * `ProtocolEvents` is the map, `completionGroups` is the part that catches that
 * exact bug, and `emitProtocolEvent` is what keeps the map honest: every emit
 * site in this engine goes through it, so the declared payload and the emitted
 * literal cannot drift apart without `tsc` saying so.
 *
 * ## TYPES ONLY — this changes nothing at runtime
 *
 * The runtime contract is still the fat payload and **the consumer's own Zod
 * parse** (kernel `EventContract`, `packages/kernel/src/scope-host.ts`).
 * Importing a producer's validator is what turns version skew into a crash
 * instead of a tolerated absence; these types are for the compiler, not for the
 * boundary. `emitProtocolEvent` is not erased — it is a real call that forwards
 * to `ctx.emit` unchanged — but nothing about the emitted event differs.
 *
 * ## VERTICAL-FACING ONLY
 *
 * A sibling engine consuming `protocol.signed` must NOT import this — R1 (star
 * topology) forbids the import, and the defensive parse is what lets an engine
 * ride out #128's dual-emit window. `engine-invoicing` consuming
 * `workorder.completed` through its own Zod view is the correct shape and stays
 * so. A vertical is in a different position on every count: it already imports
 * the engines, it knows which are composed, and it ships and upgrades them as
 * one unit.
 *
 * Additive, like every other engine surface: a new event type may appear, an
 * existing payload field does not change shape without a `schemaVersion` bump.
 */
import type { DomainEventInput, EntityRef } from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';

import type { Signatory } from './inputs.js';

/**
 * The entity an instance binds to, as it rides every payload here.
 *
 * Structurally an `EntityRef` — spelled out because the engine is
 * entity-agnostic: this is whatever the vertical bound the protocol TO, never
 * the protocol itself (that is the envelope's `entity`).
 */
export type ProtocolSubjectRef = EntityRef;

/** A protocol instance was started on a vertical entity. */
export interface ProtocolInstantiatedPayload {
  instanceId: string;
  templateKey: string;
  templateVersion: number;
  title: string;
  contentKind: 'checklist' | 'document';
  entity: ProtocolSubjectRef;
}

/** One append to a checklist's answer history — never an edit of an earlier one. */
export interface ProtocolResponseRecordedPayload {
  instanceId: string;
  responseId: string;
  itemKey: string;
  /** Booleans for checks; strings for measurements and text (decimals stay strings, K-14). */
  value: boolean | string;
  entity: ProtocolSubjectRef;
}

/** Vertical-owned document content was bound to an open document protocol. */
export interface ProtocolContentBoundPayload {
  instanceId: string;
  templateKey: string;
  templateVersion: number;
  /** Vertical vocabulary for what this is — 'avtal', 'styrelserapport'. */
  documentType: string;
  /** The vertical entity holding the real content. */
  contentRef: EntityRef;
  /** The hash the VERTICAL computed over its own rows, per the template's `hashRecipe`. */
  boundHash: string;
  /** The attachment holding the bytes a signatory is shown; null when nothing was rendered (#711). */
  documentAttachmentId: string | null;
  /** The kernel's hash of those bytes at upload; null whenever the id is. */
  documentSha256: string | null;
  entity: ProtocolSubjectRef;
}

/** One party on a dispatched signature request set. */
export interface ProtocolRequestedParty {
  requestId: string;
  label: string;
  kind: 'principal' | 'external';
  ref: string | null;
  signatureKind: 'primary' | 'counter';
  /** Resolved here rather than at the connector — a party that said nothing reads `basic` (#620). */
  authLevel: 'basic' | 'strong';
  /** How to reach this party, sealed to the connection that will send the document (#687). */
  contact: { keyId: string; ciphertext: string } | null;
}

/**
 * The content is frozen and named parties have been asked to sign it.
 *
 * Deliberately fat: a connector dispatching this must never need a cross-module
 * read, so the recipient list, the hash, the bound document and the sealed
 * contacts all travel with the event.
 */
export interface ProtocolSignaturesRequestedPayload {
  instanceId: string;
  templateKey: string;
  templateVersion: number;
  entity: ProtocolSubjectRef;
  /** 'scrive', 'bankid' — the provider a connector will dispatch to. */
  method: string;
  contentHash: string;
  contentRef: EntityRef | null;
  boundHash: string | null;
  documentAttachmentId: string | null;
  parties: ProtocolRequestedParty[];
}

/** A requested party refused, or the provider timed them out. */
export interface ProtocolSignatureDeclinedPayload {
  instanceId: string;
  requestId: string;
  templateKey: string;
  entity: ProtocolSubjectRef;
  partyLabel: string;
  outcome: 'declined' | 'expired';
  reason: string;
}

/** An outstanding request set was withdrawn and the instance thawed back to `open`. */
export interface ProtocolSignaturesCancelledPayload {
  instanceId: string;
  templateKey: string;
  entity: ProtocolSubjectRef;
  /** How many pending requests the withdrawal actually resolved. */
  cancelled: number;
  reason: string;
}

/**
 * What BOTH completion events carry — the shared `base` of `emitSignatureEvent`,
 * named so a consumer can see that the two agree by construction.
 *
 * Not itself an event payload: `protocol.signed` is exactly this, and
 * `protocol.countersigned` is this with `signedBy` re-pointed and two fields
 * added. The split is real and is NOT to be collapsed — see
 * `ProtocolCountersignedPayload`.
 */
export interface ProtocolSignatureBase {
  instanceId: string;
  templateKey: string;
  templateVersion: number;
  entity: ProtocolSubjectRef;
  method: string;
  contentHash: string;
  /** Document kind: what was signed lives in the vertical, so this is the pointer, not the content. */
  contentRef: EntityRef | null;
  boundHash: string | null;
  /** The document the signatory was SHOWN (#711); null for a checklist. */
  documentAttachmentId: string | null;
  /** Fat: the frozen answers travel with the event (checklist kind). */
  responses: Record<string, unknown>;
  signatory: Signatory;
  evidenceRef: string | null;
  signedAt: string;
  /** False while other requested parties are still outstanding. */
  complete: boolean;
  signatories: Signatory[];
}

/**
 * The primary signature. `signedBy` is the party who just signed.
 */
export interface ProtocolSignedPayload extends ProtocolSignatureBase {
  signedBy: string;
}

/**
 * An ADDITIONAL signature on the same frozen content.
 *
 * `signedBy` genuinely differs from `protocol.signed` and that is why these are
 * two types rather than one: here it is re-pointed at the PRIMARY signatory and
 * is nullable (that row can be gone), while the party who just signed arrives in
 * `countersignedBy`. A shared payload type would hide exactly the confusion the
 * split exists to prevent.
 */
export interface ProtocolCountersignedPayload extends ProtocolSignatureBase {
  /** The PRIMARY signatory, or null if that row is gone. */
  signedBy: string | null;
  /** The party who just counter-signed. */
  countersignedBy: string;
  countersignatory: Signatory;
}

/** A protocol was superseded. Voiding never deletes. */
export interface ProtocolVoidedPayload {
  instanceId: string;
  entity: ProtocolSubjectRef;
  previousStatus: 'open' | 'pending_signature' | 'signed' | 'voided';
  reason: string;
}

/**
 * engine-protocol's event contract — the nine event types this engine emits and
 * the payload each one carries, plus the one set of events that report the same
 * fact by different routes.
 *
 * Satisfies the kernel's `EventContract`, so a vertical writes
 * `consumersFor<[ProtocolEvents]>()({ … })` and gets typed payloads, rejection
 * of an event type this engine does not emit, and — via `completionGroups` — a
 * compile error naming the completion event it forgot.
 */
export type ProtocolEvents = {
  events: {
    'protocol.instantiated': ProtocolInstantiatedPayload;
    'protocol.response-recorded': ProtocolResponseRecordedPayload;
    'protocol.content-bound': ProtocolContentBoundPayload;
    'protocol.signatures-requested': ProtocolSignaturesRequestedPayload;
    'protocol.signature-declined': ProtocolSignatureDeclinedPayload;
    'protocol.signatures-cancelled': ProtocolSignaturesCancelledPayload;
    'protocol.signed': ProtocolSignedPayload;
    'protocol.countersigned': ProtocolCountersignedPayload;
    'protocol.voided': ProtocolVoidedPayload;
  };
  /**
   * Completion rides on whoever signs LAST — a two-party contract completes as a
   * COUNTERSIGNATURE, and `complete: true` is on both events. Handling one and
   * not the other is the production defect #696 was filed for, so the kernel
   * demands both once either is handled.
   */
  completionGroups: {
    signature: 'protocol.signed' | 'protocol.countersigned';
  };
};

/** Every event type this engine emits. */
export type ProtocolEventType = keyof ProtocolEvents['events'];

/**
 * `ctx.emit`, with the event type and its payload welded together.
 *
 * This is what stops `ProtocolEvents` becoming a description nothing holds in
 * agreement. `ctx.emit` takes `payload: unknown`, so an event map declared
 * beside the emit sites would be checked by nobody and could rot silently into a
 * lie a vertical compiles against. Routing every emit through here makes the map
 * the *source*: rename a payload field on one side and the other side fails to
 * compile, and emitting a type the map does not declare fails too.
 *
 * Zero runtime behaviour of its own — it forwards to `ctx.emit` unchanged.
 */
export function emitProtocolEvent<K extends ProtocolEventType>(
  ctx: OperationContext,
  event: Omit<DomainEventInput, 'type' | 'payload'> & {
    type: K;
    payload: ProtocolEvents['events'][K];
  },
): void {
  ctx.emit(event);
}
