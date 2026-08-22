/**
 * The work order engine's declared operation surface (#707/#738).
 *
 * An engine declaring its operations is what lets a VERTICAL bind them to its
 * own URLs without restating them. Before this, `defineEngineRoutes` had to
 * carry an input schema the vertical wrote itself — a local `z.object({ orderId
 * })` standing in for a shape the engine only expressed as a TypeScript type —
 * and the operation NAME was an unchecked string, because `ModuleRegistration`
 * erases its keys.
 *
 * What is deliberately NOT here is `http`. An engine is entity-agnostic and owns
 * no URL shape: a bike shop calls the same work order a repair, and both are
 * right. The path is the composing vertical's decision, declared with
 * `defineEngineRoutes` against these names.
 *
 * `createWorkOrder` is absent for a different reason — it is an in-scope
 * function, not an operation. A vertical calls it inside its own transaction so
 * it can price, label and link in one go; exposing it as an invocable operation
 * would offer a second way in that skips all of that.
 */
import { defineOperations, z } from '@substrat-run/contracts';
import { workorderEntities } from './entities.js';
import { billableLine, materialLine, timeEntry, workOrder } from './schemas.js';

/** The keys these operations check. Mirrors `PERM` in index.ts. */
export const WORKORDER_PERMISSIONS = [
  'workorder:create',
  'workorder:read',
  'workorder:assign',
  'workorder:report',
  'workorder:complete',
  'workorder:close',
] as const;

const orderId = z.object({ orderId: z.string().min(1) });

export const workorderOperations = defineOperations(workorderEntities, WORKORDER_PERMISSIONS)({
  'workorder/get': {
    summary: 'One work order with everything reported against it',
    permission: { key: 'workorder:read', entity: 'workorder', idFrom: 'orderId' },
    input: orderId,
    output: z.object({
      order: workOrder,
      time: z.array(timeEntry),
      material: z.array(materialLine),
    }),
  },

  'workorder/list': {
    summary: 'Work orders, newest first, optionally filtered by status',
    permission: 'workorder:read',
    input: z.object({ status: z.string().optional() }),
    inputOptional: true,
    // The ENTRY, not the envelope — `paged` is what wraps it, here and in the
    // emitted document.
    output: workOrder,
    // #811. `number` first, so the default walk is the one this list shipped
    // with: newest work order at the top. `status` is offered as a sort as well
    // as a filter — a board grouped by state is the second thing an office asks
    // for, and the alternative is a vertical forking the engine to get it.
    paged: {
      over: {
        entity: 'workorder',
        sortable: ['number', 'status', 'created_at'],
        filterable: ['status', 'assigned_to', 'kind'],
      },
      order: 'desc',
    },
  },

  'workorder/assign': {
    summary: 'Assign a technician',
    permission: 'workorder:assign',
    input: orderId.extend({ technician: z.string().min(1) }),
    output: workOrder,
  },

  'workorder/start': {
    summary: 'Start the work',
    permission: 'workorder:assign',
    input: orderId,
    output: workOrder,
  },

  'workorder/report-time': {
    summary: 'Report time against the order',
    permission: 'workorder:report',
    input: orderId.extend({ hours: z.string(), note: z.string().optional() }),
    output: timeEntry,
  },

  'workorder/report-material': {
    summary: 'Report material against the order',
    permission: 'workorder:report',
    input: orderId.extend({ article: z.string(), qty: z.string(), note: z.string().optional() }),
    output: materialLine,
  },

  'workorder/complete': {
    summary: 'Complete the order with its billable lines',
    permission: 'workorder:complete',
    input: orderId.extend({ billable: z.array(billableLine) }),
    output: z.object({ order: workOrder, total: z.string() }),
  },

  'workorder/close': {
    summary: 'Close the order at hand-over',
    permission: 'workorder:close',
    input: orderId,
    output: workOrder,
  },
});
