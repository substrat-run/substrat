import { defineLifecycles } from '@substrat-run/contracts';
import { protocolEntities } from './entities.js';
import { protocolOperations } from './operations.js';

/**
 * The protocol instance's state machine, declared (#844).
 *
 * It was already here — as `instance.status !== 'open'` at five call sites plus
 * an `already_voided` throw, held to the `status` enum in `entities.ts` by
 * nothing. This is the same machine in one place the compiler checks: a state
 * the column cannot hold, a value the column CAN hold with no state declared for
 * it, an edge to nowhere, or an operation this engine does not declare are all
 * refused.
 *
 * ## The engine keeps its own conflict vocabulary
 *
 * `assertTransition` is the default adoption and this engine does not take it.
 * Its refusals answer three different questions — `content_frozen` (the content
 * may no longer change), `wrong_status` (the verb needs another state),
 * `already_voided` (there is nothing left to do) — and a consumer branching on
 * `PROTOCOL_CONFLICT_REASONS` already sees all three. Flattening them into one
 * `invalid_transition` would be a non-additive change to a published surface for
 * no gain, so `index.ts` asks this declaration the *legality* question with
 * `transitionFor` and keeps its own reason. The declaration is still the single
 * description of what is legal; only the prose stays local.
 *
 * ## Composed by call — so the check lives with the in-scope function
 *
 * This engine is composed **by call** (`signProtocol`, `voidProtocol`, …), and a
 * vertical wraps those inside its own transaction. So the check sits in the
 * in-scope function, not in the registered operation: a vertical composing
 * `requestSignatures` gets the invariant, and one that only calls the operation
 * gets the same invariant by the same route.
 *
 * Edges are named by the operation id even where the caller is the in-scope
 * function, because the operation is the stable public name for the verb and the
 * join key everything else uses — `manifest.guards[].before`, the emitted XState
 * machine, the docs diagram.
 *
 * ## `protocol/record-signature` is an edge whose move is conditional
 *
 * Recording a signature moves the instance to `signed` only when every requested
 * party has signed; earlier ones leave it where it is. It is still the edge:
 * this verb, and no other, performs `pending_signature → signed`, and dropping
 * it to `allow` would emit a diagram in which nothing ever reaches `signed` from
 * out-for-signature. The condition stays in the handler, where a lifecycle
 * deliberately cannot reach — the same placement booking gives `not_yet_expired`
 * on its `held → expired` edge.
 *
 * ## What is deliberately not here
 *
 * `protocol/get`, `protocol/list-for-entity`, `protocol/list-templates`,
 * `protocol/define-template` and `protocol/instantiate` are reads and creations,
 * and no instance state gates them. **Absence means "not governed", never
 * "forbidden"** — the machine describes which mutations a state admits, and an
 * operation it has never heard of is not its business.
 *
 * `protocol/decline-signature` is absent for a sharper reason: it is gated by
 * the *signature request's* own status (`pending`), not the instance's. That is
 * a second machine on a row this registry does not declare as an entity, and
 * describing one of its edges here would put the check in a place that does not
 * make it.
 *
 * `guards` are absent too, and that is K-38 holding: a guard is wired in the
 * manifest as `{ before, predicate, config }` and evaluated by the kernel. Every
 * edge below names its operation, so a guard on the operation already is a guard
 * on the edge — this engine's own `protocol/all-signed` predicate is wired that
 * way by the composing vertical.
 */
export const protocolLifecycles = defineLifecycles(
  protocolEntities,
  protocolOperations,
)({
  protocol: {
    field: 'status',
    initial: 'open',
    states: {
      /**
       * Content still moves. The only state that admits substates (K-17).
       *
       * It is also the only one with no freeze invariant: `pending_signature`
       * holds a hash parties are signing against, `signed` holds the attestation
       * itself, and `voided` is over. Refining "being filled in" — `in_review`,
       * `awaiting_customer` — is vertical vocabulary, and this is where it would
       * go. The other three declare nothing, and that absence is the intent.
       */
      open: {
        on: {
          'protocol/request-signatures': 'pending_signature',
          'protocol/sign': 'signed',
          'protocol/void': 'voided',
        },
        allow: ['protocol/fill', 'protocol/bind-document'],
        extensible: true,
      },
      /**
       * Out for signature: the content hash is frozen and the requests are live.
       *
       * Withdrawing THAWS — `cancel-signatures` returns it to `open` and clears
       * the frozen hash — which is why this state has an edge back and `signed`
       * does not.
       */
      pending_signature: {
        on: {
          'protocol/record-signature': 'signed',
          'protocol/cancel-signatures': 'open',
          'protocol/void': 'voided',
        },
      },
      /**
       * Attested and frozen. Counter-signing is legal here and moves nothing:
       * a second signature over the SAME frozen content, which is why it is
       * `allow` rather than a self-loop nobody performs.
       */
      signed: {
        on: { 'protocol/void': 'voided' },
        allow: ['protocol/countersign'],
      },
      /** Terminal, and terminal for a reason: voiding is how a protocol is superseded, never deleted. */
      voided: {
        terminal: true,
      },
    },
  },
});

/** The machine for the `protocol` entity — the shape the evaluator takes. */
export const protocolLifecycle = protocolLifecycles.protocol;
