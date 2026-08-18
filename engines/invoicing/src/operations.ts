/**
 * The invoicing engine's declared operation surface (#707/#738).
 *
 * ## Three operations, and the engine is not composed through them
 *
 * This engine is composed by **event**: a vertical *emits*
 * `workorder.completed` / `commerce.order-placed` / `timesheet.period-closed`,
 * the engine's consumers build the basis, and the vertical reads the result
 * back. There are deliberately no in-scope exports — the engine is the only
 * writer of its rows, which is what keeps immutable-after-export safe from a
 * half-finished caller.
 *
 * So these three are the whole *callable* surface, and they are what a vertical
 * binds to its own URLs with `defineEngineRoutes`. What is absent is the
 * interesting half: there is no `invoicing/create`, and its absence is the
 * engine's design rather than an omission.
 *
 * No `http` — the engine owns no URL shape (`/invoicing`, `/fakturaunderlag`,
 * `/billing`, all correct depending on the vertical's vocabulary). No `emits`:
 * `invoicing/export` does emit, but its event is about the underlag and the
 * manifest declares it by hand, as engine-workorder's and engine-protocol's do.
 *
 * ## Every check here is a NODE check, and that is the honest description
 *
 * Including `invoicing/get`, which reads one basis by id. An underlag has no
 * declared parent — its customer is an opaque `EntityRef` into whatever the
 * vertical calls a customer — so there is no edge for an entity-narrowed grant
 * to resolve along, and the handler checks at the scope. Declared as it behaves,
 * not as it might ideally behave: `permission: 'invoicing:read'` says "anyone
 * holding this key in this scope", which is exactly what the code does. A
 * vertical needing a customer to see only their own basis puts that walk in its
 * own operation, where the customer edge exists.
 */
import { defineOperations, z } from '@substrat-run/contracts';
import { invoicingEntities, underlagRow } from './entities.js';
import { underlagDetail, underlagListRow } from './schemas.js';

/** The keys these operations check. Mirrors `INVOICING_PERM` in index.ts. */
export const INVOICING_PERMISSIONS = ['invoicing:read', 'invoicing:export'] as const;

const underlagId = z.object({ underlagId: z.string().min(1) });

export const invoicingOperations = defineOperations(invoicingEntities, INVOICING_PERMISSIONS)({
  'invoicing/list': {
    summary: 'Invoice bases, newest first, optionally filtered by status',
    permission: 'invoicing:read',
    input: z.object({ status: z.string().optional() }),
    // The handler answers with every basis when called with no body at all.
    inputOptional: true,
    output: z.array(underlagListRow),
  },

  'invoicing/get': {
    summary: 'One invoice basis with its lines and total',
    permission: 'invoicing:read',
    input: underlagId,
    output: underlagDetail,
  },

  'invoicing/export': {
    summary: 'Export an invoice basis — makes it immutable',
    permission: 'invoicing:export',
    input: underlagId,
    output: underlagRow,
  },
});
