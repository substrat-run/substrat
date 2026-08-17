import { defineOperations } from '@substrat-run/contracts';
import { z } from 'zod';
import { calloutEntities } from './entities.js';

/** The permission keys operations may require. Mirrors `SC_PERM` in manifest.ts. */
export const CALLOUT_PERMISSIONS = ['customer:manage', 'facility:manage'] as const;

/** A price-list row. A table, not an entity — so its shape lives here, not in the registry. */
const priceRow = z.object({
  article: z.string(),
  description: z.string(),
  unit: z.string(),
  price_amount: z.string(),
  currency: z.string(),
  min_qty: z.string().nullable(),
  internal: z.number(),
});

/**
 * Callout's declared operation surface (#707).
 *
 * ## Six of eleven, deliberately
 *
 * The operations that return an ENGINE type — `create-workorder`,
 * `complete-workorder`, `instantiate-protocol`, `portal-orders` — are absent,
 * and the reason is worth stating rather than leaving as a gap.
 *
 * `output` is a Zod schema, so declaring one for `WorkOrder` or
 * `ProtocolInstanceRow` would mean **transcribing the engine's type into Zod
 * here**. That is a fourth description of a shape the engine already owns, kept
 * in agreement by nothing — and transcription is precisely the cost that decided
 * the model's notation (#680). A wrong transcription would be worse than the
 * `unknown` it replaced, because it would look authoritative.
 *
 * The real fix is engines exporting Zod schemas for their row types, the same
 * shape as #696's event contracts. Until then this follows the rule #695 arrived
 * at from measuring a production app: **declare a return where a caller branches
 * on it**, and leave the rest honestly opaque. They declared 54 of 159; this is
 * 6 of 11, and the split is a finding rather than an omission.
 *
 * `ApiOperationDoc.output` already carries the same "adopted incrementally" note.
 */
export const calloutOperations = defineOperations(calloutEntities, CALLOUT_PERMISSIONS)({
  'callout/whoami': {
    summary: "Report the caller's role in this scope",
    // No permission gates it: answering "what may I do" must work for everyone,
    // including a principal who may do nothing.
    narrows: { reason: 'every principal may ask what they themselves may do' },
    // No body at all.
    output: z.object({ role: z.enum(['office-admin', 'technician', 'none']) }),
  },
  'callout/create-customer': {
    summary: 'Register a customer',
    permission: 'customer:manage',
    input: z.object({ number: z.string(), name: z.string(), orgRef: z.string().optional() }),
    // The row shape comes from the registry — not restated here.
    output: calloutEntities.customer.fields,
    http: { method: 'POST', path: '/customers' },
  },
  'callout/list-customers': {
    summary: 'List customers with their facilities',
    permission: 'customer:manage',
    // A bare array, not a `{ rows }` wrapper: the handler is shipped behaviour
    // and the first draft of this declaration described something that is not
    // true. Downstream may falsify the model; it may not author it.
    output: z.array(
      calloutEntities.customer.fields.extend({
        facilities: z.array(calloutEntities.facility.fields),
      }),
    ),
    http: { method: 'GET', path: '/customers' },
  },
  'callout/create-facility': {
    summary: 'Register a facility for a customer',
    permission: 'facility:manage',
    input: z.object({
      customerId: z.string(),
      name: z.string(),
      address: z.string().optional(),
      accessNote: z.string().optional(),
    }),
    output: calloutEntities.facility.fields,
    http: { method: 'POST', path: '/customers/{customerId}/facilities' },
  },
  'callout/price-list': {
    summary: 'The current price list',
    permission: 'customer:manage',
    output: z.array(priceRow),
    http: { method: 'GET', path: '/price-list' },
  },
  'callout/timeline': {
    summary: 'The event timeline for one entity',
    permission: 'customer:manage',
    input: z.object({ entityType: z.string(), entityId: z.string() }),
    output: z.array(z.object({ type: z.string(), occurred_at: z.string(), actor: z.string() })),
  },
});
