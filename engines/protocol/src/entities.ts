import { defineEntities } from '@substrat-run/contracts';
import { z } from 'zod';

/**
 * engine-protocol's entities (#697/#707).
 *
 * ## Why an engine declares these at all
 *
 * A vertical composing this engine needs two things it cannot get today:
 *
 * 1. **The entity-type constant.** Callout declares
 *    `{ entityType: 'protocol', parentType: 'workorder' }` and Handlebar
 *    `{ entityType: 'workorder', parentType: 'bike' }` — permission-walk edges
 *    naming entities the vertical does not own. Both sides are unchecked strings
 *    today, and a typo is a silently dead edge.
 * 2. **The row schema.** `output` in a declared operation is a Zod schema, so a
 *    vertical operation returning a `ProtocolInstanceRow` would have to
 *    transcribe this engine's shape into Zod — a description held in agreement
 *    by nothing. Exporting the schema removes the transcription rather than
 *    asking every vertical to get it right.
 *
 * ## One entity, eight tables
 *
 * `protocol` is the only thing here the platform can point at: attachments hang
 * off it, grants narrow to it, and verticals declare relation edges to it.
 * Templates, responses, signatures and signature requests are rows this engine
 * owns and operates on — reachable through the exported in-scope functions, and
 * never the subject of an `EntityRef`.
 *
 * The `_v2` table is the live one; `0001`'s originals stay in the journal
 * verbatim because it is append-only, and are not described here.
 */
export const protocolEntities = defineEntities({
  protocol: {
    table: 'protocol_instances_v2',
    fields: z.object({
      id: z.string(),
      template_key: z.string(),
      template_version: z.number(),
      /** The entity this instance binds to — entity-agnostic by design. */
      entity_type: z.string(),
      entity_id: z.string(),
      status: z.enum(['open', 'pending_signature', 'signed', 'voided']),
      created_by: z.string(),
      created_at: z.string(),
      voided_by: z.string().nullable(),
      voided_reason: z.string().nullable(),
      voided_at: z.string().nullable(),
      /** Document kind: the vertical entity holding the real content. */
      content_ref_type: z.string().nullable(),
      content_ref_id: z.string().nullable(),
      /** Document kind: the hash the VERTICAL computed over its own rows. */
      bound_hash: z.string().nullable(),
      /** Set when content freezes — the hash every signature must match. */
      frozen_hash: z.string().nullable(),
      frozen_at: z.string().nullable(),
    }),
    /**
     * No `parent`. This engine is entity-agnostic: an instance binds to whatever
     * the vertical says, so only the vertical knows where protocols hang. That
     * absence is the design, not an omission.
     */
  },
});

/**
 * The row shape, for a vertical declaring an operation that returns one.
 * `ProtocolInstanceRow` is derived from this rather than written beside it.
 */
export const protocolInstanceRow = protocolEntities.protocol.fields;
