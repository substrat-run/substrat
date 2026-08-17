import { defineOperations, money } from '@substrat-run/contracts';
import { protocolInstanceRow } from '@substrat-run/engine-protocol';
import { billableLine, workOrder } from '@substrat-run/engine-workorder';
import { z } from 'zod';
import { calloutEntities } from './entities.js';

/** The permission keys operations may require. Mirrors `SC_PERM` in manifest.ts. */
export const CALLOUT_PERMISSIONS = ['customer:manage', 'facility:manage'] as const;

/**
 * Callout policy: protocols live on work orders. Declared here and parsed by the
 * handler — the SAME object, which is the point of the model being TypeScript.
 */
export const instantiateProtocolInput = z.object({
  templateKey: z.string().min(1),
  entityType: z.literal('workorder'),
  entityId: z.string().min(1),
});

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
 * ## Eleven of eleven
 *
 * Four of these return ENGINE types, and until the engines exported Zod schemas
 * for them a vertical could only have declared an `output` by transcribing the
 * engine's shape into Zod here — a description held in agreement by nothing, and
 * a wrong one worse than the `unknown` it replaced because it looks
 * authoritative. `protocolInstanceRow`, `workOrder` and `billableLine` removed
 * that, so the whole surface is declared.
 *
 * Note `workOrder`, NOT `workorderRow`: the engine stores `facility_type` and
 * `facility_id` as two snake_case columns and publishes one `EntityRef` in
 * camelCase. The row and the published type are different shapes, and only the
 * second is what an operation returns.
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
  'callout/upsert-price': {
    summary: 'Create or update a price-list article',
    permission: 'customer:manage',
    input: z.object({
      article: z.string(),
      description: z.string(),
      unit: z.string(),
      priceAmount: z.string(),
      currency: z.string().optional(),
      minQty: z.string().optional(),
      internal: z.boolean().optional(),
    }),
    output: priceRow,
  },
  'callout/create-workorder': {
    summary: 'Open a work order against a facility',
    permission: 'customer:manage',
    input: z.object({
      facilityId: z.string(),
      kind: z.string(),
      title: z.string(),
      description: z.string().optional(),
    }),
    output: workOrder,
  },
  'callout/complete-workorder': {
    summary: 'Complete a work order and price its billable lines',
    permission: 'customer:manage',
    input: z.object({ orderId: z.string() }),
    output: z.object({ order: workOrder, billable: z.array(billableLine), total: money }),
  },
  'callout/instantiate-protocol': {
    summary: 'Instantiate a protocol against an entity',
    permission: 'customer:manage',
    // The handler's own schema, not a restatement of it.
    input: instantiateProtocolInput,
    output: protocolInstanceRow,
  },
  'callout/portal-orders': {
    summary: "The work orders visible to the caller's portal",
    narrows: { reason: 'a portal caller sees their own orders, not a denial' },
    output: z.array(workOrder),
  },
  'callout/timeline': {
    summary: 'The event timeline for one entity',
    permission: 'customer:manage',
    input: z.object({ entityType: z.string(), entityId: z.string() }),
    output: z.array(z.object({ type: z.string(), occurred_at: z.string(), actor: z.string() })),
  },
});
