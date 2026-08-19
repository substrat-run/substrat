/**
 * engine-invoicing — composed **by event**, not by call.
 *
 * There are deliberately no in-scope exports. A vertical does not build an invoice
 * basis; it completes a work order (or places an order, or closes a period) and
 * this engine's consumers build the basis from that event's fat payload. The
 * vertical reads the result back through `invoicing/list` / `invoicing/get`, or by
 * consuming `invoicing.underlag-updated` into a side table keyed by the underlag's
 * id (decision 28).
 *
 * That absence is the design. This engine is the ONLY writer of its rows, which is
 * what keeps `exported` genuinely immutable: a caller cannot export an underlag
 * half-way through a delivery that is still appending lines to it. Extracting
 * `exportUnderlag` for a vertical to call would hand out exactly that race.
 *
 * The thin-operation rule in CLAUDE.md is about engines composed by call — where a
 * vertical wraps the engine inside its own transaction. Here the operations ARE the
 * surface, and their logic living in them is correct rather than an omission.
 *
 * `demos/callout`'s scenario asserts this shape: "star topology observed: the
 * invoicing engine consumed the event", then reads the basis via `invoicing/list`.
 */
import { z } from 'zod';
import {
  addMoney,
  entityRef,
  money,
  moduleManifest,
  moneyOf,
  permissionKey,
  type EntityRow,
  type Money,
  substratError,
} from '@substrat-run/contracts';
import { invoicingEntities, underlagLine } from './entities.js';

// The entity registry is PUBLIC: every demo composes this engine, and a vertical
// declaring an operation that returns an invoice basis needs the schema rather
// than a retyped copy of it.
export { invoicingEntities, underlagLine, underlagRow } from './entities.js';
/**
 * The composite read shapes (#738), and the declared operation surface a
 * vertical binds to its own URLs with `defineEngineRoutes`. The handlers below
 * are typed FROM these schemas, so the published contract and the projection
 * cannot drift apart.
 */
export { underlagDetail, underlagListRow } from './schemas.js';
export { invoicingOperations, INVOICING_PERMISSIONS } from './operations.js';
import {
  assertAllowed,
  ulid,
  type ConsumerHandler,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';

// ============================================================================
// The invoicing engine (demos/callout/spec/testrun.md §4.3/§5.3). Consumes
// `workorder.completed` — snapshot, not join: prices and quantities are frozen
// from the event payload, provenance kept as EntityRef columns. Zero imports
// from the workorder engine (star topology, D-19).
// ============================================================================

export const INVOICING_PERM = {
  read: permissionKey.parse('invoicing:read'),
  export: permissionKey.parse('invoicing:export'),
};

export const invoicingManifest = moduleManifest.parse({
  id: '@substrat-run/engine-invoicing',
  version: '0.0.1',
  kernelContract: '^0.0.1',
  permissions: [
    { key: 'invoicing:read', description: 'Read invoice bases' },
    { key: 'invoicing:export', description: 'Export an invoice basis (makes it immutable)' },
  ],
  events: {
    emits: [
      { type: 'invoicing.underlag-updated', schemaVersion: 1 },
      // v2: `total` is Money, not a bare amount string. v1 stated a number with
      // no currency on a financial artifact — and `demos/callout/spec/testrun.md`
      // always specified `total: Money`, so this is the code meeting its own
      // spec rather than a change of intent.
      //
      // NOT dual-emitted, despite D-28's deprecation-window rule: consumer
      // dispatch keys on event TYPE only (`WHERE o.type = ?`; the schemaVersion
      // in `consumes` is discarded at registration), so emitting v1 and v2 would
      // deliver BOTH to every consumer of this type. For an export event that
      // means a connector could invoice twice, silently. A clean replace instead
      // fails loudly — a v1 consumer's strict parse rejects v2 and dead-letters,
      // which is visible. See kernel-design open question on version routing.
      { type: 'invoicing.underlag-exported', schemaVersion: 2 },
    ],
    consumes: [
      { type: 'workorder.completed', schemaVersion: 1 },
      { type: 'commerce.order-placed', schemaVersion: 1 },
      { type: 'timesheet.period-closed', schemaVersion: 1 },
    ],
  },
  migrations: { journalDir: './migrations', compatibleFrom: '0.0.1' },
  attachmentTargets: [{ entityType: 'underlag', readPermission: 'invoicing:read' }],
  entitlementKey: 'invoicing',
  ui: {
    routes: [{ path: 'invoicing', screen: './ui/UnderlagList', permission: 'invoicing:read' }],
    nav: [{ label: 'invoicing.nav', icon: 'receipt', to: 'invoicing', permission: 'invoicing:read' }],
    entityViews: [{ entityType: 'underlag', view: './ui/UnderlagCard' }],
  },
});

export const invoicingMigrations = [
  {
    version: '0001-init',
    sql: `
      CREATE TABLE invoicing_underlag (
        id            TEXT PRIMARY KEY,
        number        INTEGER NOT NULL UNIQUE,
        customer_type TEXT NOT NULL,
        customer_id   TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('open','exported')),
        created_at    TEXT NOT NULL,
        exported_at   TEXT
      );
      CREATE TABLE invoicing_lines (
        id                TEXT PRIMARY KEY,
        underlag_id       TEXT NOT NULL REFERENCES invoicing_underlag(id),
        source_type       TEXT NOT NULL,
        source_id         TEXT NOT NULL,
        article           TEXT NOT NULL,
        description       TEXT NOT NULL,
        qty               TEXT NOT NULL,
        unit              TEXT NOT NULL,
        unit_price_amount TEXT NOT NULL,
        currency          TEXT NOT NULL,
        line_total_amount TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
    `,
  },
  {
    // #328: split DOCUMENT-level provenance (which delivery produced the line —
    // a `workorder`/`order`/`timesheet` + its id) from PER-LINE provenance (what
    // the line itself is — `time` vs `material`). Until now `source_type`/
    // `source_id` carried the document, and the per-line `sourceType`/`sourceId`
    // the `workorder.completed` payload validates were parsed and discarded.
    // `document_*` is always known, so NOT NULL; per-line provenance exists only
    // where a producer supplies it (the workorder path today), so `source_*`
    // becomes nullable — which in SQLite means rebuilding the table. Existing
    // rows hold the document in `source_*`: move it to `document_*` and leave
    // per-line provenance NULL (it was never captured, so it cannot be invented).
    version: '0002-split-line-provenance',
    sql: `
      CREATE TABLE invoicing_lines_new (
        id                TEXT PRIMARY KEY,
        underlag_id       TEXT NOT NULL REFERENCES invoicing_underlag(id),
        document_type     TEXT NOT NULL,
        document_id       TEXT NOT NULL,
        source_type       TEXT,
        source_id         TEXT,
        article           TEXT NOT NULL,
        description       TEXT NOT NULL,
        qty               TEXT NOT NULL,
        unit              TEXT NOT NULL,
        unit_price_amount TEXT NOT NULL,
        currency          TEXT NOT NULL,
        line_total_amount TEXT NOT NULL,
        created_at        TEXT NOT NULL
      );
      INSERT INTO invoicing_lines_new
        (id, underlag_id, document_type, document_id, source_type, source_id,
         article, description, qty, unit, unit_price_amount, currency,
         line_total_amount, created_at)
      SELECT
        id, underlag_id, source_type, source_id, NULL, NULL,
        article, description, qty, unit, unit_price_amount, currency,
        line_total_amount, created_at
      FROM invoicing_lines;
      DROP TABLE invoicing_lines;
      ALTER TABLE invoicing_lines_new RENAME TO invoicing_lines;
    `,
  },
];

// What this engine needs from the fat event payload — its OWN parse of the
// contract; it never imports the producer's types.
const completedPayload = z.object({
  orderId: z.string().min(1),
  number: z.number().int(),
  customer: entityRef,
  billable: z.array(
    z.object({
      article: z.string().min(1),
      description: z.string().min(1),
      qty: z.string().min(1),
      unit: z.string().min(1),
      unitPrice: money,
      lineTotal: money,
      sourceType: z.enum(['time', 'material']),
      sourceId: z.string().min(1),
    }),
  ),
  total: money,
});

// ADDITIVE (D-28): a SECOND input event. The engine learns to build a
// invoice basis from a retail order without touching the workorder path — new
// `consumes` entry + this parse + the consumer below, no migration, no
// permission. Its OWN Zod view of the contract; zero imports from the producer.
const commercePlacedPayload = z.object({
  orderId: z.string().min(1),
  number: z.number().int(),
  customer: entityRef,
  paymentMethod: z.string().min(1),
  billable: z.array(
    z.object({
      article: z.string().min(1),
      description: z.string().min(1),
      qty: z.string().min(1),
      unit: z.string().min(1),
      unitPrice: money,
      lineTotal: money,
    }),
  ),
  total: money,
});

// ADDITIVE (D-28): a THIRD input event — a closed (approved) period of reported
// time. Same discipline as the two above: the engine's OWN Zod view of the
// contract, zero imports from the producer. `closeId` is whatever the producer
// uses as its immutable closing artifact (an attest, an approval, a lock) — it
// is the idempotency key here, so one closing can never bill twice.
const timesheetClosedPayload = z.object({
  closeId: z.string().min(1),
  customer: entityRef,
  period: z.string().min(1),
  billable: z.array(
    z.object({
      article: z.string().min(1),
      description: z.string().min(1),
      qty: z.string().min(1),
      unit: z.string().min(1),
      unitPrice: money,
      lineTotal: money,
    }),
  ),
  total: money,
});

/**
 * DERIVED from the entity registry (`entities.ts`), as is `UnderlagLine`. They
 * were hand-written interfaces, so the schema was described twice — and a
 * vertical that wanted to declare a return against either had to write it a
 * third time.
 */
export type UnderlagRow = EntityRow<typeof invoicingEntities, 'underlag'>;

export type UnderlagLine = z.infer<typeof underlagLine>;

/**
 * The two read projections, written out rather than inferred from the schemas
 * in `schemas.ts` — deliberately, because the schemas are checked AGAINST these.
 *
 * Typing the handlers from `z.infer<typeof underlagDetail>` was tried first and
 * is not a check: a schema that drops a field the handler still returns keeps
 * compiling, because an object with extra properties is assignable to a narrower
 * type. It caught a retyped field and missed a missing one, which is the
 * permissive-failure shape that makes a decorative check worse than none. Two
 * independent descriptions held together by an exactness assertion catch both.
 */
export type UnderlagListRow = UnderlagRow & { total: string };

export interface UnderlagDetail {
  underlag: UnderlagRow;
  lines: UnderlagLine[];
  total: string;
}

/**
 * The underlag's total, as Money.
 *
 * Uses `addMoney`, not `addDecimal`: an invoice basis that sums 100 SEK and
 * 100 EUR into "200" is not a rounding bug, it is a financial artifact stating
 * a number that means nothing. `addMoney` throws on a currency mismatch, so the
 * engine refuses rather than invents. `assertSingleCurrency` in the consumers is
 * the real guard — this is defence in depth behind it.
 */
function underlagTotalMoney(ctx: OperationContext, underlagId: string): Money {
  const rows = ctx.sql.query<{ line_total_amount: string; currency: string }>(
    'SELECT line_total_amount, currency FROM invoicing_lines WHERE underlag_id = ?',
    [underlagId],
  );
  // An underlag with no lines is unreachable in practice — find-or-create and
  // the line inserts share one transaction — but a zero total must still have a
  // currency to be Money at all. Attributing a currency to an empty document is
  // exactly the guess this engine should not make; SEK is the demo default and
  // the honest fix is a currency column on the underlag, which needs a migration
  // and therefore a human checkpoint (see docs/strategy/commerce-gaps.md §3.1).
  if (rows.length === 0) return moneyOf('0', 'SEK');

  return rows
    .map((r) => moneyOf(r.line_total_amount, r.currency))
    .reduce((sum, m) => addMoney(sum, m));
}

/** Back-compat shim: the operation surface has always returned a bare string. */
function underlagTotal(ctx: OperationContext, underlagId: string): string {
  return underlagTotalMoney(ctx, underlagId).amount;
}

/**
 * A document has one currency. Reject at write time, so a mixed-currency
 * delivery dead-letters and the underlag is never corrupted — rejecting at read
 * time instead would leave a document that can never be listed or exported
 * again.
 */
function assertSingleCurrency(
  ctx: OperationContext,
  underlagId: string,
  incoming: readonly { unitPrice: Money; lineTotal: Money }[],
): void {
  const existing = ctx.sql.query<{ currency: string }>(
    'SELECT DISTINCT currency FROM invoicing_lines WHERE underlag_id = ?',
    [underlagId],
  );
  const currencies = new Set<string>([
    ...existing.map((r) => r.currency),
    ...incoming.map((l) => l.lineTotal.currency),
    ...incoming.map((l) => l.unitPrice.currency),
  ]);
  if (currencies.size > 1) {
    throw substratError('conflict', 
      `currency mismatch on underlag ${underlagId}: ${[...currencies].sort().join(', ')} — an underlag is one document in one currency`,
    );
  }
}

const onWorkOrderCompleted: ConsumerHandler = (ctx, event) => {
  const p = completedPayload.parse(event.payload);
  if (p.billable.length === 0) return;

  // Idempotent on at-least-once redelivery (K-11): the order is the dedup key.
  // Its lines are already present → this delivery is a replay, do nothing.
  // This guard was missing while `onCommerceOrderPlaced` had it, so the two
  // consumers of one engine disagreed about whether replay was possible — and
  // the docs promised the guard for both.
  const already = ctx.sql.query<{ found: number }>(
    `SELECT 1 AS found FROM invoicing_lines WHERE document_type = 'workorder' AND document_id = ? LIMIT 1`,
    [p.orderId],
  )[0];
  if (already) return;

  // Find-or-create the OPEN underlag for this customer; an exported underlag
  // is immutable — late deliveries open a new one (engine invariant on top of
  // the kernel's delivery journal).
  let underlag = ctx.sql.query<UnderlagRow>(
    `SELECT * FROM invoicing_underlag WHERE customer_type = ? AND customer_id = ? AND status = 'open'`,
    [p.customer.entityType, p.customer.entityId],
  )[0];
  if (!underlag) {
    const id = ulid();
    const number =
      ctx.sql.query<{ n: number }>(
        'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM invoicing_underlag',
      )[0]?.n ?? 1;
    ctx.sql.exec(
      `INSERT INTO invoicing_underlag (id, number, customer_type, customer_id, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
      [id, number, p.customer.entityType, p.customer.entityId, new Date().toISOString()],
    );
    underlag = ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [id])[0]!;
  }

  assertSingleCurrency(ctx, underlag.id, p.billable);

  for (const line of p.billable) {
    ctx.sql.exec(
      `INSERT INTO invoicing_lines
         (id, underlag_id, document_type, document_id, source_type, source_id,
          article, description, qty, unit,
          unit_price_amount, currency, line_total_amount, created_at)
       VALUES (?, ?, 'workorder', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid(),
        underlag.id,
        p.orderId,
        line.sourceType,
        line.sourceId,
        line.article,
        line.description,
        line.qty,
        line.unit,
        line.unitPrice.amount,
        line.unitPrice.currency,
        line.lineTotal.amount,
        new Date().toISOString(),
      ],
    );
  }

  ctx.emit({
    type: 'invoicing.underlag-updated',
    schemaVersion: 1,
    entity: { entityType: 'underlag', entityId: underlag.id },
    piiClass: 'none',
    payload: {
      underlagId: underlag.id,
      addedLines: p.billable.length,
      source: { entityType: 'workorder', entityId: p.orderId },
    },
  });
};

// ADDITIVE consumer for the retail order event (concept §7). Same snapshot,
// -not-join discipline as `onWorkOrderCompleted`; source_type is 'order'. Only
// invoice-payment orders bill — card/Swish settle through a payment connector.
const onCommerceOrderPlaced: ConsumerHandler = (ctx, event) => {
  const p = commercePlacedPayload.parse(event.payload);
  if (p.paymentMethod !== 'invoice') return;
  if (p.billable.length === 0) return;

  // Idempotent on at-least-once redelivery (K-11): the order is the dedup key.
  // Its lines are already present → this delivery is a replay, do nothing.
  const already = ctx.sql.query<{ found: number }>(
    `SELECT 1 AS found FROM invoicing_lines WHERE document_type = 'order' AND document_id = ? LIMIT 1`,
    [p.orderId],
  )[0];
  if (already) return;

  let underlag = ctx.sql.query<UnderlagRow>(
    `SELECT * FROM invoicing_underlag WHERE customer_type = ? AND customer_id = ? AND status = 'open'`,
    [p.customer.entityType, p.customer.entityId],
  )[0];
  if (!underlag) {
    const id = ulid();
    const number =
      ctx.sql.query<{ n: number }>(
        'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM invoicing_underlag',
      )[0]?.n ?? 1;
    ctx.sql.exec(
      `INSERT INTO invoicing_underlag (id, number, customer_type, customer_id, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
      [id, number, p.customer.entityType, p.customer.entityId, new Date().toISOString()],
    );
    underlag = ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [id])[0]!;
  }

  assertSingleCurrency(ctx, underlag.id, p.billable);

  for (const line of p.billable) {
    ctx.sql.exec(
      `INSERT INTO invoicing_lines
         (id, underlag_id, document_type, document_id, source_type, source_id,
          article, description, qty, unit,
          unit_price_amount, currency, line_total_amount, created_at)
       VALUES (?, ?, 'order', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid(),
        underlag.id,
        p.orderId,
        line.article,
        line.description,
        line.qty,
        line.unit,
        line.unitPrice.amount,
        line.unitPrice.currency,
        line.lineTotal.amount,
        new Date().toISOString(),
      ],
    );
  }

  ctx.emit({
    type: 'invoicing.underlag-updated',
    schemaVersion: 1,
    entity: { entityType: 'underlag', entityId: underlag.id },
    piiClass: 'none',
    payload: {
      underlagId: underlag.id,
      addedLines: p.billable.length,
      source: { entityType: 'order', entityId: p.orderId },
    },
  });
};

// ADDITIVE consumer for the closed-timesheet event. Same snapshot-not-join
// discipline; source_type is 'timesheet' and the closing artifact is the dedup
// key, so an at-least-once redelivery can never bill a period twice.
const onTimesheetPeriodClosed: ConsumerHandler = (ctx, event) => {
  const p = timesheetClosedPayload.parse(event.payload);
  if (p.billable.length === 0) return;

  // Idempotent on at-least-once redelivery (K-11): the closing is the dedup key.
  const already = ctx.sql.query<{ found: number }>(
    `SELECT 1 AS found FROM invoicing_lines WHERE document_type = 'timesheet' AND document_id = ? LIMIT 1`,
    [p.closeId],
  )[0];
  if (already) return;

  let underlag = ctx.sql.query<UnderlagRow>(
    `SELECT * FROM invoicing_underlag WHERE customer_type = ? AND customer_id = ? AND status = 'open'`,
    [p.customer.entityType, p.customer.entityId],
  )[0];
  if (!underlag) {
    const id = ulid();
    const number =
      ctx.sql.query<{ n: number }>(
        'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM invoicing_underlag',
      )[0]?.n ?? 1;
    ctx.sql.exec(
      `INSERT INTO invoicing_underlag (id, number, customer_type, customer_id, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
      [id, number, p.customer.entityType, p.customer.entityId, new Date().toISOString()],
    );
    underlag = ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [id])[0]!;
  }

  assertSingleCurrency(ctx, underlag.id, p.billable);

  for (const line of p.billable) {
    ctx.sql.exec(
      `INSERT INTO invoicing_lines
         (id, underlag_id, document_type, document_id, source_type, source_id,
          article, description, qty, unit,
          unit_price_amount, currency, line_total_amount, created_at)
       VALUES (?, ?, 'timesheet', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid(),
        underlag.id,
        p.closeId,
        line.article,
        line.description,
        line.qty,
        line.unit,
        line.unitPrice.amount,
        line.unitPrice.currency,
        line.lineTotal.amount,
        new Date().toISOString(),
      ],
    );
  }

  ctx.emit({
    type: 'invoicing.underlag-updated',
    schemaVersion: 1,
    entity: { entityType: 'underlag', entityId: underlag.id },
    piiClass: 'none',
    payload: {
      underlagId: underlag.id,
      addedLines: p.billable.length,
      source: { entityType: 'timesheet', entityId: p.closeId },
    },
  });
};

const listOp: OperationHandler<{ status?: string } | undefined, UnderlagListRow[]> = async (
  ctx,
  input,
) => {
  assertAllowed(await ctx.check(INVOICING_PERM.read));
  const rows = input?.status
    ? ctx.sql.query<UnderlagRow>(
        'SELECT * FROM invoicing_underlag WHERE status = ? ORDER BY number DESC',
        [input.status],
      )
    : ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag ORDER BY number DESC');
  return rows.map((r) => ({ ...r, total: underlagTotal(ctx, r.id) }));
};

const getOp: OperationHandler<{ underlagId: string }, UnderlagDetail> = async (ctx, input) => {
  assertAllowed(await ctx.check(INVOICING_PERM.read));
  const underlag = ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [
    input.underlagId,
  ])[0];
  if (!underlag) throw substratError('not_found', `underlag not found: ${input.underlagId}`);
  const lines = ctx.sql.query<UnderlagLine>(
    'SELECT * FROM invoicing_lines WHERE underlag_id = ? ORDER BY id',
    [input.underlagId],
  );
  return { underlag, lines, total: underlagTotal(ctx, input.underlagId) };
};

const exportOp: OperationHandler<{ underlagId: string }, UnderlagRow> = async (ctx, input) => {
  assertAllowed(await ctx.check(INVOICING_PERM.export));
  const underlag = ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [
    input.underlagId,
  ])[0];
  if (!underlag) throw substratError('not_found', `underlag not found: ${input.underlagId}`);
  if (underlag.status !== 'open') {
    throw substratError('conflict', `underlag ${underlag.number} is '${underlag.status}' — exported underlag are immutable`);
  }
  ctx.sql.exec(
    `UPDATE invoicing_underlag SET status = 'exported', exported_at = ? WHERE id = ?`,
    [new Date().toISOString(), underlag.id],
  );
  ctx.emit({
    type: 'invoicing.underlag-exported',
    schemaVersion: 2,
    entity: { entityType: 'underlag', entityId: underlag.id },
    piiClass: 'none',
    payload: {
      underlagId: underlag.id,
      number: underlag.number,
      // Money, not a bare string: the consumer of an export event is an
      // accounting connector, and "1550" without a currency is not an amount.
      total: underlagTotalMoney(ctx, underlag.id),
    },
  });
  return ctx.sql.query<UnderlagRow>('SELECT * FROM invoicing_underlag WHERE id = ?', [
    underlag.id,
  ])[0]!;
};

export const invoicingModule: ModuleRegistration = {
  manifest: invoicingManifest,
  migrations: invoicingMigrations,
  operations: {
    'invoicing/list': listOp as never,
    'invoicing/get': getOp as never,
    'invoicing/export': exportOp as never,
  },
  consumers: {
    'workorder.completed': onWorkOrderCompleted,
    'commerce.order-placed': onCommerceOrderPlaced,
    'timesheet.period-closed': onTimesheetPeriodClosed,
  },
};
