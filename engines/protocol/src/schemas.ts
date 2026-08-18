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
import type {
  ProtocolResponseRow,
  ProtocolSignatureRequestRow,
  ProtocolSignatureRow,
  ProtocolTemplateRow,
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
void _templateRow;
void _responseRow;
void _signatureRow;
void _requestRow;
