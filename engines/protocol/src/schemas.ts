/**
 * The shapes this engine PUBLISHES — what a composing vertical returns from an
 * operation it has bound, and what reaches its API document.
 *
 * These existed only as TypeScript interfaces, which is enough to implement
 * against and not enough to DECLARE against: `defineOperations` takes a schema,
 * so without these a vertical binding `protocol/get` had nothing to point at.
 *
 * **Each one is asserted against its interface, in both directions.** A schema
 * that drifts from the shape the handler actually returns is worse than no
 * schema — it publishes a contract nobody honours, which is exactly the defect
 * #695 found eleven times. The assertions below fail to compile if either side
 * gains, loses or retypes a field.
 */
import { z } from '@substrat-run/contracts';
import { protocolInstanceRow } from './entities.js';
import { contentUnion } from './inputs.js';
import type {
  ProtocolDetail,
  ProtocolResponseRow,
  ProtocolSignatureRequestRow,
  ProtocolSignatureRow,
  ProtocolSummary,
  ProtocolTemplateRow,
  RequestSignaturesResult,
  SignResult,
} from './index.js';

export const protocolTemplateRow = z.object({
  id: z.string(),
  key: z.string(),
  version: z.number(),
  title: z.string(),
  content_json: z.string(),
  created_at: z.string(),
});

export const protocolResponseRow = z.object({
  id: z.string(),
  instance_id: z.string(),
  item_key: z.string(),
  value_json: z.string(),
  note: z.string().nullable(),
  responded_by: z.string(),
  responded_at: z.string(),
});

export const protocolSignatureRow = z.object({
  id: z.string(),
  instance_id: z.string(),
  signed_by: z.string(),
  kind: z.enum(['primary', 'counter']),
  method: z.string(),
  content_hash: z.string(),
  evidence_ref: z.string().nullable(),
  signed_at: z.string(),
  request_id: z.string().nullable(),
  signatory_kind: z.enum(['principal', 'external']),
  signatory_label: z.string().nullable(),
});

export const protocolSignatureRequestRow = z.object({
  id: z.string(),
  instance_id: z.string(),
  party_label: z.string(),
  party_kind: z.enum(['principal', 'external']),
  party_ref: z.string().nullable(),
  signature_kind: z.enum(['primary', 'counter']),
  method: z.string(),
  auth_level: z.enum(['basic', 'strong']).nullable(),
  contact_key_id: z.string().nullable(),
  contact_ciphertext: z.string().nullable(),
  status: z.enum(['pending', 'signed', 'declined', 'expired', 'cancelled']),
  content_hash: z.string(),
  external_ref: z.string().nullable(),
  resolved_note: z.string().nullable(),
  requested_by: z.string(),
  requested_at: z.string(),
  resolved_at: z.string().nullable(),
});

/**
 * The COMPOSITE returns — what the operations answer with, as opposed to the
 * rows above.
 *
 * These existed only as interfaces, and an interface is exactly as much as an
 * operation cannot be declared against. `output` on a declared operation is a
 * Zod schema, so without these four `protocol/get` and `protocol/sign` had
 * nothing to point at and the engine could declare only the half of its surface
 * that happens to return one row.
 *
 * They are assembled from the row schemas rather than restating their fields,
 * so a column added to a row reaches every projection that carries it.
 */
export const signResult = z.object({
  instance: protocolInstanceRow,
  signature: protocolSignatureRow,
});

export const requestSignaturesResult = z.object({
  instance: protocolInstanceRow,
  contentHash: z.string(),
  requests: z.array(protocolSignatureRequestRow),
});

export const protocolDetail = z.object({
  instance: protocolInstanceRow,
  template: z.object({
    key: z.string(),
    version: z.number(),
    title: z.string(),
    content: contentUnion,
  }),
  /** The full append-only history — every edit, in order. */
  responses: z.array(protocolResponseRow),
  /** Per item, last append wins — the current answers. */
  latest: z.record(z.string(), protocolResponseRow),
  /** The primary (issuing) signature, or null while unsigned. */
  signature: protocolSignatureRow.nullable(),
  /** Every row: the primary plus any counter-signatures. */
  signatures: z.array(protocolSignatureRow),
  requests: z.array(protocolSignatureRequestRow),
});

export const protocolSummary = z.object({
  instance: protocolInstanceRow,
  title: z.string(),
  contentKind: z.enum(['checklist', 'document']),
  answered: z.number(),
  total: z.number(),
  signedBy: z.string().nullable(),
  signedAt: z.string().nullable(),
  countersignedBy: z.string().nullable(),
  countersignedAt: z.string().nullable(),
  /** How many requested signatures are still outstanding. */
  pendingSignatures: z.number(),
});

// -- the assertions ---------------------------------------------------------
// Bidirectional: `A extends B ? B extends A ? true : never : never` is `true`
// only when the two are the same shape. A drifting schema stops compiling here
// rather than shipping a contract the handler does not honour.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _templateRow: Exact<z.infer<typeof protocolTemplateRow>, ProtocolTemplateRow> = true;
const _responseRow: Exact<z.infer<typeof protocolResponseRow>, ProtocolResponseRow> = true;
const _signatureRow: Exact<z.infer<typeof protocolSignatureRow>, ProtocolSignatureRow> = true;
const _requestRow: Exact<
  z.infer<typeof protocolSignatureRequestRow>,
  ProtocolSignatureRequestRow
> = true;
const _signResult: Exact<z.infer<typeof signResult>, SignResult> = true;
const _requestResult: Exact<z.infer<typeof requestSignaturesResult>, RequestSignaturesResult> =
  true;
const _detail: Exact<z.infer<typeof protocolDetail>, ProtocolDetail> = true;
const _summary: Exact<z.infer<typeof protocolSummary>, ProtocolSummary> = true;

void _templateRow;
void _responseRow;
void _signatureRow;
void _requestRow;
void _signResult;
void _requestResult;
void _detail;
void _summary;
