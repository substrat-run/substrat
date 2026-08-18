/**
 * The protocol engine's declared operation surface (#707/#738).
 *
 * An engine declaring its operations is what lets a VERTICAL bind them to its
 * own URLs without restating them. Before this, a vertical mounting
 * `protocol/get` wrote its own `z.object({ instanceId })` — a second
 * description of a shape this engine already owned — and the operation NAME was
 * an unchecked string, because `ModuleRegistration` erases its keys.
 *
 * What is deliberately NOT here:
 *
 * - **`http`.** This engine is entity-agnostic and owns no URL shape: Callout
 *   hangs protocols off work orders and Handlebar off bikes, and both are right.
 *   The path is the composing vertical's decision, declared with
 *   `defineEngineRoutes` against these names.
 * - **`emits`.** The manifest still declares the nine event types by hand, as
 *   engine-workorder's does. Deriving them needs `entityIdFrom` to name an
 *   OUTPUT field carrying the protocol's id, and three of these operations
 *   answer with a composite whose instance sits one level down
 *   (`{ instance, signature }`). Declaring the events would mean either
 *   flattening returns to suit the declaration or guessing the id — and #695's
 *   eighteen `entityId: undefined` events are what guessing that field looks
 *   like. It stays hand-declared until the model can say `instance.id`.
 * - **The in-scope functions.** `defineTemplate`, `instantiateProtocol`,
 *   `fillProtocol` and the rest are composed by call, inside a vertical's own
 *   transaction. These fourteen names are their default HTTP-reachable
 *   bindings, not a second way in.
 *
 * ## Inputs are the handler's own schemas, with three deliberate exceptions
 *
 * Every `input` below is the same Zod object the in-scope function parses —
 * that identity is the reason the model is TypeScript, and it is what makes a
 * transcribed argument name impossible. The exceptions are the operations whose
 * REGISTERED shape has always differed from the function's: `instantiate`
 * takes a flattened `entityType`/`entityId` pair where `instantiateProtocol`
 * takes an `EntityRef`, and `sign`/`countersign`/`get`/`void` take an id where
 * the functions take richer arguments. Those shapes are declared here because
 * here is where they are true.
 */
import { defineOperations, z } from '@substrat-run/contracts';
import { protocolEntities, protocolInstanceRow } from './entities.js';
import {
  bindDocumentInput,
  cancelSignatureRequestsInput,
  declineSignatureInput,
  defineTemplateInput,
  fillProtocolInput,
  recordSignatureInput,
  requestSignaturesInput,
} from './inputs.js';
import {
  protocolDetail,
  protocolResponseRow,
  protocolSignatureRequestRow,
  protocolSummary,
  protocolTemplateRow,
  requestSignaturesResult,
  signResult,
} from './schemas.js';

/** The keys these operations check. Mirrors `PROTOCOL_PERM` in index.ts. */
export const PROTOCOL_PERMISSIONS = [
  'protocol:create',
  'protocol:fill',
  'protocol:bind',
  'protocol:request-signature',
  'protocol:record-signature',
  'protocol:sign',
  'protocol:countersign',
  'protocol:read',
  'protocol:attach',
  'protocol:void',
] as const;

/** The registered operations address an instance by id and nothing else. */
const instanceId = z.object({ instanceId: z.string().min(1) });

export const protocolOperations = defineOperations(protocolEntities, PROTOCOL_PERMISSIONS)({
  'protocol/define-template': {
    summary: 'Define a protocol template, or version an existing one',
    // A node check: a template belongs to the scope, not to any one instance.
    permission: 'protocol:create',
    input: defineTemplateInput,
    output: protocolTemplateRow,
  },

  'protocol/list-templates': {
    summary: 'The latest version of every template — the instantiation picker',
    permission: 'protocol:read',
    output: z.array(protocolTemplateRow),
  },

  'protocol/instantiate': {
    summary: 'Start a protocol instance on an entity, pinning the template version',
    // Also a node check, and deliberately: the entity named here belongs to the
    // VERTICAL, so whether this principal may protocol *that* work order is a
    // question only the vertical can ask. It asks it by composing
    // `instantiateProtocol` behind its own check.
    permission: 'protocol:create',
    input: z.object({
      templateKey: z.string().min(1),
      entityType: z.string().min(1),
      entityId: z.string().min(1),
    }),
    output: protocolInstanceRow,
  },

  'protocol/fill': {
    summary: 'Record a response on an open checklist protocol (append-only)',
    permission: { key: 'protocol:fill', entity: 'protocol', idFrom: 'instanceId' },
    input: fillProtocolInput,
    output: protocolResponseRow,
  },

  'protocol/bind-document': {
    summary: 'Bind vertical-owned document content and its hash to an open document protocol',
    permission: { key: 'protocol:bind', entity: 'protocol', idFrom: 'instanceId' },
    input: bindDocumentInput,
    output: protocolInstanceRow,
  },

  'protocol/request-signatures': {
    summary: 'Freeze the content and request signatures from named parties',
    permission: { key: 'protocol:request-signature', entity: 'protocol', idFrom: 'instanceId' },
    input: requestSignaturesInput,
    output: requestSignaturesResult,
  },

  'protocol/cancel-signatures': {
    summary: 'Withdraw an outstanding request set and thaw the instance',
    permission: { key: 'protocol:request-signature', entity: 'protocol', idFrom: 'instanceId' },
    input: cancelSignatureRequestsInput,
    output: protocolInstanceRow,
  },

  'protocol/record-signature': {
    // The ingress-facing pair. Both check a NODE, and both check a connector's
    // key rather than a person's: the caller speaks for an external signing
    // provider and arrives with a request id, not with an instance it was
    // granted. The permission diff is where a deployment declares it trusts
    // something to do that.
    summary: 'Record a signature reported by an external signing provider',
    permission: 'protocol:record-signature',
    input: recordSignatureInput,
    output: signResult,
  },

  'protocol/decline-signature': {
    summary: 'Record that a party declined, or that the provider’s window expired',
    permission: 'protocol:record-signature',
    input: declineSignatureInput,
    output: protocolSignatureRequestRow,
  },

  'protocol/sign': {
    summary: 'Sign a protocol in-app — freezes its content forever',
    permission: { key: 'protocol:sign', entity: 'protocol', idFrom: 'instanceId' },
    input: instanceId,
    output: signResult,
  },

  'protocol/countersign': {
    summary: 'Counter-sign an already-signed protocol, on the same frozen content',
    permission: { key: 'protocol:countersign', entity: 'protocol', idFrom: 'instanceId' },
    input: instanceId,
    output: signResult,
  },

  'protocol/void': {
    summary: 'Void (supersede) a protocol — never deletes',
    permission: { key: 'protocol:void', entity: 'protocol', idFrom: 'instanceId' },
    input: instanceId.extend({ reason: z.string().min(1) }),
    output: protocolInstanceRow,
  },

  'protocol/get': {
    summary: 'One protocol with its template, responses, signatures and requests',
    permission: { key: 'protocol:read', entity: 'protocol', idFrom: 'instanceId' },
    input: instanceId,
    output: protocolDetail,
  },

  /**
   * The one operation here whose authority cannot be stated as a leading
   * `permission`, and the reason is this engine's defining property.
   *
   * The check is `protocol:read` against the entity the protocols hang on — a
   * work order in Callout, a bike in Handlebar — so the entity's TYPE arrives as
   * data. `PermissionCheck.entity` must name a type known at declaration time,
   * and there is no honest value to put there: `'protocol'` would be false,
   * because what is checked is the PARENT, not any protocol.
   *
   * So it declares `narrows` instead, which records the fact that actually
   * protects anything — this is not a node check — and names the key the walk
   * evaluates, so `protocol:read` still reaches the permission review. What is
   * lost is the entity type, which was never available to lose.
   */
  'protocol/list-for-entity': {
    summary: 'Every protocol on one entity, with its progress and signatures',
    narrows: {
      reason: 'checked against the entity the protocols hang on, whose type is the caller’s',
      checks: ['protocol:read'],
    },
    input: z.object({ entityType: z.string().min(1), entityId: z.string().min(1) }),
    output: z.array(protocolSummary),
  },
});
