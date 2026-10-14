import {
  LAKE_LITERAL,
  actor as actorSchema,
  lakeEvent,
  type LakeEvent,
  type LakeEventsInput,
  type LakeEventsPage,
  type TenantId,
} from '@substrat-run/contracts';

/**
 * The Tier-2 lake's query gateway (#1334) — the one path by which anything in the product
 * reads `kernel.events`, and the place the tenant boundary is held for it.
 *
 * Every tenant's events share one Iceberg table, and the sink cannot partition it, so
 * nothing below this file knows whose row is whose. Isolation is therefore made here, in
 * three layers, each enough on its own:
 *
 * 1. **The tenant is an argument, never an input.** `compileLakeEvents` takes it apart from
 *    the filters, and the filter schema (`lakeEventsInput`) has no tenant field and refuses
 *    unknown keys. The caller's only way to name a tenant is the route's path segment, which
 *    the API's authentication has already confined.
 * 2. **The predicate is written first, by the only producer of SQL.** No caller supplies
 *    SQL, an identifier or a fragment: the query is a closed shape, every column is from
 *    the list below, and every value is a literal that passes `LAKE_LITERAL` — an alphabet
 *    with no quote in it — or is refused. `tenant_id = '<tenant>'` is the first conjunct of
 *    every WHERE, and the filters can only AND onto it.
 * 3. **The answer is checked, not trusted.** Every row must carry the tenant asked for. One
 *    that does not fails the whole read with nothing returned: a defect in the layers above
 *    becomes an error rather than a disclosure.
 *
 * The engine is a seam (`LakeQueryEngine`) because §5.3 says it is replaceable — Iceberg is
 * the contract, R2 SQL is today's reader, DuckDB over the same catalog the fallback. The
 * gateway is where the contract lives, so swapping the engine changes none of the above.
 */

/** The query engine over the lake: one SQL statement in, rows keyed by column name out. */
export interface LakeQueryEngine {
  query(sql: string): Promise<readonly Record<string, unknown>[]>;
}

/** The lake's one table — `LAKE.namespace`.`LAKE.table` in `scripts/lake-provision.mjs`. */
const LAKE_TABLE = 'kernel.events';

/**
 * The envelope columns a lake read returns. Deliberately NOT `payload`, `subject_id`,
 * `authorization` or `impersonation`: erasure does not reach the lake yet, so what was said
 * stays out of every answer until it does. `impersonated` is derived, so the fact of a staff
 * session is visible and the session's own record is not.
 */
const COLUMNS = [
  'id',
  'type',
  'schema_version',
  'occurred_at',
  'tenant_id',
  'scope_id',
  'actor',
  'entity_type',
  'entity_id',
  'pii_class',
  'operation',
  'version',
  'caused_by',
  'invocation_id',
] as const;

/** A row the engine handed back for a tenant other than the one asked about. */
export class LakeTenantMismatchError extends Error {
  constructor(readonly expected: TenantId) {
    super(`lake gateway: the engine returned a row outside tenant ${expected}; the read is refused whole`);
    this.name = 'LakeTenantMismatchError';
  }
}

/**
 * A value as a SQL string literal. Refuses anything outside `LAKE_LITERAL` rather than
 * escaping it — every caller has already parsed its value against a narrower schema, so a
 * refusal here means a schema and this file have parted company, which must be loud.
 */
function literal(value: string): string {
  if (!LAKE_LITERAL.test(value)) throw new Error(`lake gateway: refusing a literal outside the lake alphabet`);
  return `'${value}'`;
}

/**
 * One page of a tenant's events, newest first, as SQL.
 *
 * `DISTINCT` because the drain is at-least-once: a retried batch lands twice, as rows that
 * are identical column for column, and the lake's own rule is to dedupe on id before
 * reading anything. Keyset on `id` (a ULID, so time-ordered) rather than on `occurred_at`,
 * so the cursor is a string comparison every engine agrees on. One row over the limit is
 * asked for, to know whether there is a next page without a second query.
 */
export function compileLakeEvents(tenantId: TenantId, input: LakeEventsInput): string {
  const where = [`tenant_id = ${literal(tenantId)}`];
  if (input.scopeId !== undefined) where.push(`scope_id = ${literal(input.scopeId)}`);
  if (input.type !== undefined) where.push(`type = ${literal(input.type)}`);
  if (input.entityType !== undefined) where.push(`entity_type = ${literal(input.entityType)}`);
  if (input.entityId !== undefined) where.push(`entity_id = ${literal(input.entityId)}`);
  // The shipper sends the decoded actor (`pipelines-sink.ts`), so a principal is its bare id.
  if (input.actor !== undefined) where.push(`actor = ${literal(input.actor)}`);
  if (input.operation !== undefined) where.push(`operation = ${literal(input.operation)}`);
  if (input.version !== undefined) where.push(`version = ${literal(input.version)}`);
  if (input.impersonated) where.push('impersonation IS NOT NULL');
  if (input.since !== undefined) where.push(`occurred_at >= ${literal(input.since)}`);
  if (input.until !== undefined) where.push(`occurred_at < ${literal(input.until)}`);
  if (input.cursor !== undefined) where.push(`id < ${literal(input.cursor)}`);
  return (
    `SELECT DISTINCT ${COLUMNS.join(', ')}, (impersonation IS NOT NULL) AS impersonated ` +
    `FROM ${LAKE_TABLE} WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${input.limit + 1}`
  );
}

/** The stored actor, decoded the way `timelineEntry` decodes it, or the self-naming marker. */
function decodeActor(raw: unknown): LakeEvent['actor'] {
  const direct = actorSchema.safeParse(raw);
  if (direct.success) return direct.data;
  if (typeof raw === 'string') {
    try {
      const parsed = actorSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // not JSON: falls through to the marker
    }
  }
  return { system: 'undecodable' } as LakeEvent['actor'];
}

/** The column as an ISO instant, whether the engine hands back epoch millis or text. */
function instantOf(raw: unknown): string {
  const ms = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error('lake gateway: a row carried no readable occurred_at');
  return new Date(ms).toISOString();
}

const nullableString = (raw: unknown): string | null => (typeof raw === 'string' ? raw : null);

function toEvent(row: Record<string, unknown>): LakeEvent {
  return lakeEvent.parse({
    id: row.id,
    type: row.type,
    schemaVersion: Number(row.schema_version),
    occurredAt: instantOf(row.occurred_at),
    scopeId: row.scope_id,
    actor: decodeActor(row.actor),
    entityType: row.entity_type,
    entityId: row.entity_id,
    piiClass: row.pii_class,
    operation: nullableString(row.operation),
    version: nullableString(row.version),
    causedBy: nullableString(row.caused_by),
    invocationId: nullableString(row.invocation_id),
    impersonated: row.impersonated === true || row.impersonated === 1,
  });
}

/**
 * One page of `tenantId`'s lake events. Throws `LakeTenantMismatchError` — and returns
 * nothing — if the engine answers with any row of another tenant.
 */
export async function queryLakeEvents(
  engine: LakeQueryEngine,
  tenantId: TenantId,
  input: LakeEventsInput,
): Promise<LakeEventsPage> {
  const rows = await engine.query(compileLakeEvents(tenantId, input));
  // Every row, before any is decoded or dropped: the check is about what the engine
  // returned, not about what this page would have shown.
  if (rows.some((r) => r.tenant_id !== tenantId)) throw new LakeTenantMismatchError(tenantId);
  // DISTINCT collapses exact duplicates; this collapses any the engine still let through.
  const seen = new Set<string>();
  const events: LakeEvent[] = [];
  for (const row of rows) {
    const event = toEvent(row);
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
  }
  const page = events.slice(0, input.limit);
  const more = events.length > input.limit;
  return { events: page, nextCursor: more ? (page[page.length - 1]?.id ?? null) : null, consistency: 'eventual' };
}
