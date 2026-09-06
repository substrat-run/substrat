import { z } from 'zod';
import { scopeId, tenantId } from './ids.js';

/**
 * The signals dimension vocabulary (#1231) — the one set of names every
 * observability-facing fact is stamped with, defined once so that every chart,
 * list, graph node and failure record means the same thing by `version`, and an
 * aggregate anywhere can click through to its exemplars with filters intact.
 *
 * What each dimension names, precisely:
 *
 * - `tenant` / `scope` — the branded directory ids, exactly as the spine stamps
 *   them on every event.
 * - `vertical` — the vertical's package name (`@substrat-run/demo-ticket0`),
 *   the registry's identity for it.
 * - `version` — the version REGISTRY id (ULID) of the vertical version the fact
 *   was recorded under. The id, not the human version label: the label is one
 *   `getVersion` away, while the id survives channels, previews and re-releases
 *   of the same label. For a record written outside any deploy the stamp is the
 *   version bound to the scope at write time — stated here because it is an
 *   approximation everywhere the writer is not the deploy itself.
 * - `operation` — the operation on whose behalf the work ran: a vertical's
 *   operation name (`ticket0/answer`) for scope-side facts, the platform
 *   operation string (`preview.create`, `intent.connector:scrive`) for
 *   control-plane facts.
 * - `eventType` — a DOMAIN event type (`receipt.landed`), never the Workers
 *   invocation shape (fetch/rpc/scheduled/alarm); the observability seam names
 *   that `invocation` so the two can never be confused in a filter.
 * - `connection` — the connection id (ULID), not the provider slug: a tenant can
 *   hold two connections to one provider, and the slug cannot tell them apart.
 *
 * `modelAttribution` (model-usage.ts) predates this vocabulary and stays its own
 * frozen five-key shape — the smallest per-request metadata limit among model
 * providers fixes it at five, so it is deliberately NOT widened to this schema;
 * a signals reader reconciles it at read time.
 */
export const SIGNAL_DIMENSIONS = [
  'tenant',
  'scope',
  'vertical',
  'version',
  'operation',
  'eventType',
  'connection',
] as const;
export type SignalDimension = (typeof SIGNAL_DIMENSIONS)[number];

/**
 * A partial stamp: the dimensions one durable record carries. Every key is
 * optional — a record states what it knows and nothing else — but `.strict()`,
 * so an eighth dimension cannot drift in through a stamp; widening the
 * vocabulary is an edit HERE, read in a PR diff, or nowhere.
 */
export const signalStamp = z
  .object({
    tenant: tenantId,
    scope: scopeId,
    vertical: z.string().min(1),
    version: z.string().min(1),
    operation: z.string().min(1),
    eventType: z.string().min(1),
    connection: z.string().min(1),
  })
  .partial()
  .strict();
export type SignalStamp = z.infer<typeof signalStamp>;
