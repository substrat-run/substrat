import { z } from 'zod';
import { actor } from './events.js';
import { TRACE_STEP_CAP } from './trace-sink.js';

/**
 * A recorded request trace (#2358): the head of the hosted invocation line (#1746) plus the
 * steps inside the call.
 *
 * The same shape serves every source. A local recorder fills the whole thing; the hosted
 * record can fill the head and leave `steps` empty, because a step costs per-call
 * instrumentation the hosted path samples or skips. A reader therefore treats an empty
 * `steps` as "not recorded", never as "nothing happened" — which is why `stepsDropped` and
 * `capture` exist: they say what the recorder kept and what it left out.
 *
 * The plain-TypeScript twin of these schemas is `trace-sink.ts`, which the platform entry can
 * import without zod; `request-trace.test.ts` fails the build if the two disagree.
 */

const atMs = z.number().int().min(0);
const stepBase = { atMs, durationMs: z.number().int().min(0).optional() };

export const traceCheckStep = z.object({
  type: z.literal('check'),
  ...stepBase,
  permission: z.string().min(1),
  entity: z.string().nullable(),
  allowed: z.boolean(),
  decidedBy: z.string().nullable(),
  requires: z.array(z.string()),
  callerHas: z.array(z.string()),
});

export const traceSqlStep = z.object({
  type: z.literal('sql'),
  ...stepBase,
  operation: z.enum(['query', 'exec']),
  statement: z.string(),
  params: z.array(z.unknown()).optional(),
  rowsRead: z.number().int().min(0).optional(),
  rowsWritten: z.number().int().min(0).optional(),
  error: z.string().optional(),
});

export const traceEmitStep = z.object({
  type: z.literal('emit'),
  ...stepBase,
  eventType: z.string().min(1),
  entity: z.string().min(1),
});

export const traceLogStep = z.object({
  type: z.literal('log'),
  ...stepBase,
  level: z.string(),
  message: z.string(),
});

export const traceValidationStep = z.object({
  type: z.literal('validation'),
  ...stepBase,
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});

export const traceOutboundStep = z.object({
  type: z.literal('outbound'),
  ...stepBase,
  host: z.string(),
  path: z.string(),
  method: z.string(),
  status: z.number().int().nullable(),
  outcome: z.string(),
});

export const traceStoreStep = z.object({
  type: z.literal('store'),
  ...stepBase,
  binding: z.string(),
  operation: z.string(),
  outcome: z.string(),
});

export const traceErrorStep = z.object({
  type: z.literal('error'),
  ...stepBase,
  code: z.string().nullable(),
  message: z.string(),
  stack: z.string().optional(),
});

export const traceStep = z.discriminatedUnion('type', [
  traceCheckStep,
  traceSqlStep,
  traceEmitStep,
  traceLogStep,
  traceValidationStep,
  traceOutboundStep,
  traceStoreStep,
  traceErrorStep,
]);

export const traceHead = z.object({
  invocationId: z.string().min(1),
  startedAt: z.string().min(1),
  tenantId: z.string(),
  scopeId: z.string().nullable(),
  vertical: z.string().nullable(),
  surface: z.string().nullable(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  status: z.number().int().nullable(),
  threw: z.boolean(),
  durationMs: z.number().min(0),
  level: z.enum(['error', 'warn', 'info']),
  operation: z.string().nullable(),
  problemCode: z.string().nullable(),
  principalKind: z.string().nullable(),
  principal: actor.nullable(),
  eventCount: z.number().int().min(0).nullable(),
  eventTypes: z.array(z.string()),
  entities: z.array(z.string()),
  versionId: z.string().nullable(),
  specVersion: z.string().nullable(),
});

/** What a recorder kept and left out, so a reader never mistakes a thin trace for a quiet call. */
export const traceCapture = z.object({
  /** SQL parameter values were stored (otherwise only the statement text). */
  sqlParams: z.boolean(),
  /** Steps past {@link TRACE_STEP_CAP}, counted rather than stored. */
  stepsDropped: z.number().int().min(0),
});

export const requestTrace = z.object({
  ...traceHead.shape,
  steps: z.array(traceStep).max(TRACE_STEP_CAP),
  capture: traceCapture,
});

export type RequestTrace = z.infer<typeof requestTrace>;
