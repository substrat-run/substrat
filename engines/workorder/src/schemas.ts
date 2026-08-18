/**
 * The shapes this engine PUBLISHES — what a composing vertical returns, stores
 * against, and declares operations over.
 *
 * A file of their own because both `index.ts` (which implements against them)
 * and `operations.ts` (which declares against them) need them. With the schemas
 * living in `index.ts` and `index.ts` re-exporting `operations.ts`, importing
 * the engine ran `operations.ts` before `workOrder` was initialised — a cycle
 * that a warm `dist` hides and a tool importing the module finds immediately.
 */
import { entityRef, money, z } from '@substrat-run/contracts';
import { workorderEntities } from './entities.js';

/** Exact decimals as strings — six places, never a float. */
export const decimal = z.string().regex(/^\d+(\.\d{1,6})?$/);

export const billableLine = z.object({
  article: z.string().min(1),
  description: z.string().min(1),
  qty: decimal,
  unit: z.string().min(1),
  unitPrice: money,
  lineTotal: money,
  sourceType: z.enum(['time', 'material']),
  sourceId: z.string().min(1),
});
export type BillableLine = z.infer<typeof billableLine>;

export const workOrder = z.object({
  id: z.string(),
  number: z.number(),
  facility: entityRef,
  customer: entityRef,
  kind: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: workorderEntities.workorder.fields.shape.status,
  assignedTo: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type WorkOrder = z.infer<typeof workOrder>;

/**
 * A reported time entry, as the engine publishes it.
 *
 * A Zod schema rather than an interface because a vertical declaring an
 * operation that RETURNS this needs something to point at — `output` takes a
 * schema, and the alternative is every composer retyping the shape, which is a
 * description held in agreement by nothing.
 */
export const timeEntry = z.object({
  id: z.string(),
  order_id: z.string(),
  technician: z.string(),
  hours: z.string(),
  note: z.string().nullable(),
  reported_at: z.string(),
});
export type TimeEntry = z.infer<typeof timeEntry>;

/** A reported material line, as the engine publishes it. */
export const materialLine = z.object({
  id: z.string(),
  order_id: z.string(),
  article: z.string(),
  qty: z.string(),
  note: z.string().nullable(),
  reported_by: z.string(),
  reported_at: z.string(),
});
export type MaterialLine = z.infer<typeof materialLine>;
