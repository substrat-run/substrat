import { defineOperations, money } from '@substrat-run/contracts';
import { protocolInstanceRow } from '@substrat-run/engine-protocol';
import { billableLine, workOrder } from '@substrat-run/engine-workorder';
import { z } from 'zod';
import { handlebarEntities } from './entities.js';

/** The permission keys operations may require. */
export const HANDLEBAR_PERMISSIONS = [
  'customer:manage',
  'bike:manage',
  'workorder:create',
  'workorder:complete',
  'workorder:close',
  'workorder:read',
  'protocol:create',
] as const;

/** A price-list row. A table, not an entity — no id, never an `EntityRef`. */
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
 * Handlebar policy: a condition report is started against a bike's repair, and
 * the template defaults to the one the seed ships.
 *
 * Declared here and parsed by the handler — the SAME object. Moving it rather
 * than restating it is the point: retyping this default from memory got it
 * wrong on the first attempt, and only the scenario test caught it.
 */
export const startConditionReportInput = z.object({
  orderId: z.string().min(1),
  templateKey: z.string().min(1).default('tillstandsrapport'),
});

/**
 * Handlebar's declared operation surface (#707). All eleven.
 *
 * Every engine type this vertical returns already has an exported schema —
 * `workOrder`, `billableLine`, `protocolInstanceRow`, `money` — so nothing here
 * transcribes an engine's shape. That is the difference between this and
 * Callout's first pass, which could declare only six.
 *
 * Note `workOrder`, NOT `workorderRow`: the engine stores `facility_type` /
 * `facility_id` as two snake_case columns and publishes one `EntityRef` in
 * camelCase. Only the published type is what an operation returns.
 */
export const handlebarOperations = defineOperations(handlebarEntities, HANDLEBAR_PERMISSIONS)({
  'bike-shop/create-customer': {
    summary: 'Register a customer',
    permission: 'customer:manage',
    input: z.object({ number: z.string(), name: z.string(), phone: z.string().optional() }),
    output: handlebarEntities.customer.fields,
    http: { method: 'POST', path: '/customers' },
  },
  'bike-shop/list-customers': {
    summary: 'List customers with their bikes',
    permission: 'customer:manage',
    output: z.array(
      handlebarEntities.customer.fields.extend({ bikes: z.array(handlebarEntities.bike.fields) }),
    ),
    http: { method: 'GET', path: '/customers' },
  },
  'bike-shop/register-bike': {
    summary: "Register a bike against its owner",
    permission: 'bike:manage',
    input: z.object({ customerId: z.string(), label: z.string(), frameNo: z.string().optional() }),
    output: handlebarEntities.bike.fields,
    http: { method: 'POST', path: '/customers/{customerId}/bikes' },
  },
  'bike-shop/upsert-price': {
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
  'bike-shop/price-list': {
    summary: 'The current price list',
    permission: 'customer:manage',
    output: z.array(priceRow),
    http: { method: 'GET', path: '/price-list' },
  },
  'bike-shop/create-repair': {
    summary: 'Open a repair against a bike',
    permission: 'workorder:create',
    input: z.object({
      bikeId: z.string(),
      kind: z.string(),
      title: z.string(),
      description: z.string().optional(),
    }),
    output: workOrder,
  },
  'bike-shop/start-condition-report': {
    summary: 'Instantiate the condition-report protocol for a repair',
    permission: 'protocol:create',
    input: startConditionReportInput,
    output: protocolInstanceRow,
  },
  'bike-shop/complete-repair': {
    summary: 'Complete a repair and price its billable lines',
    permission: 'workorder:complete',
    input: z.object({ orderId: z.string() }),
    output: z.object({ order: workOrder, billable: z.array(billableLine), total: money }),
  },
  'bike-shop/close-repair': {
    summary: 'Close a completed repair at pickup',
    permission: 'workorder:close',
    input: z.object({ orderId: z.string() }),
    output: workOrder,
  },
  'bike-shop/portal-repairs': {
    summary: "The repairs visible to the caller's portal",
    narrows: { reason: 'a customer sees their own repairs, not a denial' },
    output: z.array(workOrder),
  },
  'bike-shop/timeline': {
    summary: 'The event timeline for one entity',
    permission: 'workorder:read',
    input: z.object({ entityType: z.string(), entityId: z.string() }),
    output: z.array(z.object({ type: z.string(), occurred_at: z.string(), actor: z.string() })),
  },
});
