/**
 * Tock's operations — the business logic, and nothing else.
 *
 * Everything structural is derived from `spec/model.ts`: the migrations were emitted from the
 * entities, the manifest is assembled from both halves of the model, the route table is
 * derived at mount time. What is left here is what only a person could decide — what it means
 * for a run to be counted, and who may move one.
 *
 * `satisfies` at the bottom is the join: a handler whose input or return disagrees with the
 * declared operation, one declared and not implemented, or one implemented and not declared,
 * is a compile error naming the exact method.
 *
 * ## The file is never read here
 *
 * `profile-run` receives already-parsed records because module code cannot reach a blob —
 * capabilities come from `ctx`, and `ctx` has no blob. The host reads the file and hands the
 * records in, and that operation carries no `http` so a browser cannot hand them in instead.
 * Everything downstream of profiling is pure `ctx.sql` over stored rows.
 */
import {
  addDecimal,
  operationInputsOf,
  substratError,
  type CountedPage,
  type EntityRow,
  type HandlerInput,
  type HandlerOutput,
} from '@substrat-run/contracts';
import {
  assertAllowed,
  ulid,
  type ModuleRegistration,
  type OperationContext,
  type OperationHandler,
} from '@substrat-run/kernel';
import {
  DIM_NONE,
  dimsOfSet,
  FIELD_HISTORY_MAX,
  MAX_GROUPING_DIMENSIONS,
  tockEntities,
  tockOperations,
} from '../spec/model.js';
import { TOCK_PERM, tockManifest } from './manifest.js';
import { tockMigrations } from './migrations.generated.js';

type SourceRow = EntityRow<typeof tockEntities, 'source'>;
type SchemaRow = EntityRow<typeof tockEntities, 'schema'>;
type RunRow = EntityRow<typeof tockEntities, 'run'>;
type SourceFileRow = EntityRow<typeof tockEntities, 'source_file'>;
type ObservationRow = EntityRow<typeof tockEntities, 'observation'>;
type FieldHistoryRow = EntityRow<typeof tockEntities, 'field_history'>;
type RowRow = EntityRow<typeof tockEntities, 'row'>;

const runRef = (id: string) => ({ entityType: 'run', entityId: id });
const sourceRef = (key: string) => ({ entityType: 'source', entityId: key });

/** One field's declaration inside `tock_schemas.fields_json`. */
interface FieldDef {
  type: string;
  role: 'dimension' | 'measure' | 'ignored';
  required?: boolean;
  labelField?: string;
}
type FieldDefs = Record<string, FieldDef>;

/** How long a source file and its rows are kept (concept section 9). Days. */
const ROW_RETENTION_DAYS = 90;

// ── small shared reads ──────────────────────────────────────────────────────

function runOrThrow(ctx: OperationContext, id: string): RunRow {
  const row = ctx.sql.query<RunRow>('SELECT * FROM tock_runs WHERE id = ?', [id])[0];
  if (!row) throw substratError('not_found', `run not found: ${id}`);
  return row;
}

function sourceOrThrow(ctx: OperationContext, key: string): SourceRow {
  const row = ctx.sql.query<SourceRow>('SELECT * FROM tock_sources WHERE key = ?', [key])[0];
  if (!row) throw substratError('not_found', `source not found: ${key}`);
  return row;
}

function schemaOrThrow(ctx: OperationContext, sourceKey: string, version: number): SchemaRow {
  const row = ctx.sql.query<SchemaRow>(
    'SELECT * FROM tock_schemas WHERE source_key = ? AND version = ?',
    [sourceKey, version],
  )[0];
  if (!row) throw substratError('not_found', `no version ${version} of schema ${sourceKey}`);
  return row;
}

/**
 * The UTC calendar day an instant falls in.
 *
 * A slice rather than a date object, because instants here are ISO-8601 text by house rule
 * and the first ten characters of one ARE the day. Parsing it into a date and formatting it
 * back would be a round trip through a representation this codebase deliberately does not use.
 */
const dayOf = (instant: string) => instant.slice(0, 10);
const monthOf = (instant: string) => instant.slice(0, 7);
/** A grain bucket's start, as the ISO instant the rollup key stores. */
const dayStart = (instant: string) => `${dayOf(instant)}T00:00:00.000Z`;
const monthStart = (instant: string) => `${monthOf(instant)}-01T00:00:00.000Z`;

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

/**
 * The day's salt, minted on first use and never re-minted after it is destroyed.
 *
 * Web Crypto, because it is the same API in Node, Workers and browsers — never a `node:`
 * import, and never a hand-rolled hash to dodge one.
 *
 * A destroyed salt is a tombstone: the row survives with `secret` null so a later run can
 * tell "the salt is gone" from "there was never one". Minting a replacement would undo the
 * erasure that destroying it performed, so this refuses instead.
 */
function saltFor(ctx: OperationContext, day: string): { saltId: string; secret: string } {
  const existing = ctx.sql.query<{ salt_id: string; secret: string | null; destroyed_at: string | null }>(
    'SELECT salt_id, secret, destroyed_at FROM tock_salts WHERE day = ?',
    [day],
  )[0];
  if (existing) {
    if (existing.secret === null)
      throw substratError(
        'precondition_failed',
        `the salt for ${day} was destroyed — its subject keys cannot be reproduced, so this day cannot be re-profiled`,
      );
    return { saltId: existing.salt_id, secret: existing.secret };
  }
  const saltId = ulid();
  const secret = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer);
  ctx.sql.exec(
    'INSERT INTO tock_salts (day, salt_id, secret, created_at, destroyed_at) VALUES (?, ?, ?, ?, NULL)',
    [day, saltId, secret, ctx.now()],
  );
  return { saltId, secret };
}

async function subjectKey(secret: string, subject: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${secret}:${subject}`);
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}

/** What a value looks like, for the observed half of declared-versus-observed. */
function inferType(value: string): string {
  if (/^-?\d+$/.test(value)) return 'int';
  if (/^-?\d+\.\d+$/.test(value)) return 'decimal';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return 'timestamp';
  if (value === 'true' || value === 'false') return 'bool';
  return 'text';
}

// ── modelling ───────────────────────────────────────────────────────────────

const declareSourceOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/declare-source']>,
  HandlerOutput<(typeof tockOperations)['tock/declare-source']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.schemaManage));
  const existing = ctx.sql.query<SourceRow>('SELECT * FROM tock_sources WHERE key = ?', [input.key])[0];
  if (existing) throw substratError('conflict', `a source called ${input.key} already exists`);

  ctx.sql.exec(
    'INSERT INTO tock_sources (key, title, expected_cadence, created_at) VALUES (?, ?, ?, ?)',
    [input.key, input.title, input.expectedCadence, ctx.now()],
  );
  const row = sourceOrThrow(ctx, input.key);
  ctx.emit({
    type: 'tock.source-declared',
    schemaVersion: 1,
    entity: sourceRef(row.key),
    piiClass: 'none',
    payload: { key: row.key, title: row.title, expected_cadence: row.expected_cadence },
  });
  return row;
};

const listSourcesOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/list-sources']>,
  HandlerOutput<(typeof tockOperations)['tock/list-sources']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead));
  return ctx.page<SourceRow>('source', input ?? {});
};

/**
 * Save the next version of a source's shape. Never edits one.
 *
 * The two-dimension cap is enforced HERE, at save time, with the reason in the message. A
 * schema accepted with three grouping dimensions would count fine and then be unable to group
 * by the third — a limit discovered at report time by someone who cannot act on it.
 */
const saveSchemaOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/save-schema']>,
  HandlerOutput<(typeof tockOperations)['tock/save-schema']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.schemaManage));
  sourceOrThrow(ctx, input.sourceKey);

  const dimensions = Object.entries(input.fields).filter(([, f]) => f.role === 'dimension');
  if (dimensions.length > MAX_GROUPING_DIMENSIONS)
    throw substratError(
      'validation_failed',
      `a schema may declare at most ${MAX_GROUPING_DIMENSIONS} grouping dimensions; this one declares ${dimensions.length} (${dimensions.map(([n]) => n).join(', ')}). The rollup holds two dimension slots, so a third could be stored and never grouped by.`,
    );
  for (const [name, f] of Object.entries(input.fields)) {
    if (f.labelField && !input.fields[f.labelField])
      throw substratError('validation_failed', `field '${name}' names a labelField '${f.labelField}' that is not a field of this schema`);
  }

  const latest = ctx.sql.query<{ version: number }>(
    'SELECT MAX(version) AS version FROM tock_schemas WHERE source_key = ?',
    [input.sourceKey],
  )[0];
  const version = (latest?.version ?? 0) + 1;
  const id = ulid();
  ctx.sql.exec(
    'INSERT INTO tock_schemas (id, source_key, version, fields_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, input.sourceKey, version, JSON.stringify(input.fields), ctx.principal, ctx.now()],
  );
  ctx.link({ entityType: 'schema', entityId: id }, sourceRef(input.sourceKey));

  const row = schemaOrThrow(ctx, input.sourceKey, version);
  ctx.emit({
    type: 'tock.schema-saved',
    schemaVersion: 1,
    entity: { entityType: 'schema', entityId: row.id },
    piiClass: 'none',
    payload: { id: row.id, source_key: row.source_key, version: row.version },
  });
  return row;
};

const listSchemasOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/list-schemas']>,
  HandlerOutput<(typeof tockOperations)['tock/list-schemas']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead));
  return ctx.page<SchemaRow>('schema', { ...input, filters: { source_key: input.sourceKey } });
};

// ── the lifecycle ───────────────────────────────────────────────────────────

const receiveRunOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/receive-run']>,
  HandlerOutput<(typeof tockOperations)['tock/receive-run']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.runManage));
  sourceOrThrow(ctx, input.sourceKey);

  const id = ulid();
  const now = ctx.now();
  ctx.sql.exec(
    `INSERT INTO tock_runs
       (id, source_key, schema_version, filename, byte_size, content_hash, status,
        period_from, period_to, row_count, rejected_count, received_at, received_by, counted_at)
     VALUES (?, ?, NULL, ?, ?, ?, 'received', ?, ?, NULL, NULL, ?, ?, NULL)`,
    [id, input.sourceKey, input.filename, input.byteSize, input.contentHash, input.periodFrom, input.periodTo, now, ctx.principal],
  );
  // The bytes' identity, and when they stop being kept. `purge_after` is written now rather
  // than computed at read time so the retention promise is a fact on the row a person can see.
  const purgeAfter = `${new Date(Date.parse(now) + ROW_RETENTION_DAYS * 86_400_000).toISOString()}`;
  ctx.sql.exec(
    'INSERT INTO tock_source_files (run_id, content_hash, byte_size, storage_key, stored_at, purge_after) VALUES (?, ?, ?, ?, ?, ?)',
    [id, input.contentHash, input.byteSize, input.storageKey, now, purgeAfter],
  );
  ctx.link(runRef(id), sourceRef(input.sourceKey));

  const row = runOrThrow(ctx, id);
  ctx.emit({
    type: 'tock.run-received',
    schemaVersion: 1,
    entity: runRef(row.id),
    piiClass: 'none',
    payload: {
      id: row.id,
      source_key: row.source_key,
      filename: row.filename,
      byte_size: row.byte_size,
      content_hash: row.content_hash,
      period_from: row.period_from,
      period_to: row.period_to,
    },
  });
  return row;
};

/**
 * Record a batch of parsed records: the rows, the observations, and the field history.
 *
 * Resumable by construction — a run stays `received` until a batch says it is `final`, and
 * every write here is an upsert, so re-delivering a batch after a failed invocation costs a
 * duplicate row and no corruption. The rows themselves are keyed by a fresh ULID rather than
 * anything derived, so exact idempotency is deliberately NOT claimed: a caller that replays a
 * batch it already delivered will double-count, and the host is what must not do that.
 */
const profileRunOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/profile-run']>,
  HandlerOutput<(typeof tockOperations)['tock/profile-run']>
> = async (ctx, input) => {
  const run = runOrThrow(ctx, input.runId);
  assertAllowed(await ctx.check(TOCK_PERM.runManage, runRef(run.id)));
  if (run.status !== 'received' && run.status !== 'profiled')
    throw substratError('conflict', `a ${run.status} run cannot be profiled`, { reason: 'wrong_state' });
  if (run.status === 'profiled')
    throw substratError('conflict', 'this run has already finished profiling', { reason: 'already_profiled' });

  let written = 0;

  for (const record of input.batch) {
    const day = dayOf(record.occurredAt);
    const { secret } = saltFor(ctx, day);
    const key = await subjectKey(secret, record.subject);

    const dims: Record<string, string | null> = {};
    for (const [field, value] of Object.entries(record.fields)) {
      dims[field] = value;
      // The observed half. Counted per field whether or not any schema declares it — a field
      // nobody modelled is the finding, so refusing it here would destroy the evidence.
      const present = value === null ? 0 : 1;
      ctx.sql.exec(
        `INSERT INTO tock_observations (id, run_id, field, present_count, null_count, inferred_type, distinct_estimate, declared)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0)
         ON CONFLICT(run_id, field) DO UPDATE SET
           present_count = present_count + excluded.present_count,
           null_count    = null_count + excluded.null_count`,
        [ulid(), run.id, field, present, 1 - present, value === null ? 'unknown' : inferType(value)],
      );
      // Kept longer than the rows it came from — that is the whole job, so it is written per
      // day rather than per run and never pruned with them.
      ctx.sql.exec(
        `INSERT INTO tock_field_history (source_key, field, day, first_seen, last_seen, n)
           VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_key, field, day) DO UPDATE SET
           last_seen = excluded.last_seen,
           n = n + excluded.n`,
        [run.source_key, field, day, record.occurredAt, record.occurredAt, present],
      );
    }

    ctx.sql.exec(
      'INSERT INTO tock_rows (id, run_id, occurred_at, subject_key, dims_json, metrics_json) VALUES (?, ?, ?, ?, ?, ?)',
      [ulid(), run.id, record.occurredAt, key, JSON.stringify(dims), '{}'],
    );
    written += 1;
  }

  const total = (run.row_count ?? 0) + written;
  ctx.sql.exec('UPDATE tock_runs SET row_count = ?, status = ? WHERE id = ?', [
    total,
    input.final ? 'profiled' : 'received',
    run.id,
  ]);

  const after = runOrThrow(ctx, run.id);
  if (input.final) {
    ctx.emit({
      type: 'tock.run-profiled',
      schemaVersion: 1,
      entity: runRef(after.id),
      piiClass: 'none',
      payload: { id: after.id, source_key: after.source_key, row_count: after.row_count, status: after.status },
    });
  }
  return { ...after, complete: Boolean(input.final) };
};

const mapRunOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/map-run']>,
  HandlerOutput<(typeof tockOperations)['tock/map-run']>
> = async (ctx, input) => {
  const run = runOrThrow(ctx, input.runId);
  assertAllowed(await ctx.check(TOCK_PERM.runManage, runRef(run.id)));
  if (run.status !== 'profiled')
    throw substratError(
      'conflict',
      `a ${run.status} run cannot be mapped — profiling is what puts the evidence on the table that mapping is a decision about`,
      { reason: 'wrong_state' },
    );
  schemaOrThrow(ctx, run.source_key, input.schemaVersion);

  ctx.sql.exec('UPDATE tock_runs SET schema_version = ?, status = ? WHERE id = ?', [
    input.schemaVersion,
    'mapped',
    run.id,
  ]);
  const row = runOrThrow(ctx, run.id);
  ctx.emit({
    type: 'tock.run-mapped',
    schemaVersion: 1,
    entity: runRef(row.id),
    piiClass: 'none',
    payload: { id: row.id, source_key: row.source_key, schema_version: row.schema_version },
  });
  return row;
};

/**
 * Count a mapped run and freeze it.
 *
 * Nothing is written to the run this one displaces. Which run is current for a period is
 * derived — the latest counted one covering it — so making this one current is a consequence
 * of counting it and not an update to anything else. Both runs keep their rollup rows, which
 * is what lets an old report still show what it originally reported.
 *
 * Two grains are computed independently from the rows rather than one from the other. Counts
 * here are additive so a month could be summed from days, but doing it that way is the habit
 * that breaks the moment a non-additive measure appears, and the cost of not forming it is
 * one more pass over rows already in memory.
 */
const countRunOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/count-run']>,
  HandlerOutput<(typeof tockOperations)['tock/count-run']>
> = async (ctx, input) => {
  const run = runOrThrow(ctx, input.runId);
  assertAllowed(await ctx.check(TOCK_PERM.runManage, runRef(run.id)));
  if (run.status !== 'mapped')
    throw substratError('conflict', `a ${run.status} run cannot be counted`, { reason: 'wrong_state' });

  const schema = schemaOrThrow(ctx, run.source_key, run.schema_version ?? 0);
  const fields: FieldDefs = JSON.parse(schema.fields_json) as FieldDefs;
  const dimensions = Object.entries(fields).filter(([, f]) => f.role === 'dimension').map(([n]) => n);
  const measure = Object.entries(fields).find(([, f]) => f.role === 'measure')?.[0];

  const rows = ctx.sql.query<RowRow>('SELECT * FROM tock_rows WHERE run_id = ? ORDER BY id', [run.id]);

  // The grouping sets the report serves — the total plus each single dimension. Not the
  // cartesian product: row count is the sum over each grouping of its distinct tuples, and
  // the difference between those two models is larger than any storage decision here.
  const groupings: { dimSet: string; dims: string[] }[] = [
    { dimSet: 'total', dims: [] },
    ...dimensions.map((d) => ({ dimSet: d, dims: [d] })),
  ];

  interface Cell { events: number; measure: string | null }
  const cells = new Map<string, Cell>();
  const labels = new Map<string, string>();
  let rejected = 0;

  for (const row of rows) {
    const values = JSON.parse(row.dims_json) as Record<string, string | null>;
    for (const [name, f] of Object.entries(fields)) {
      if (f.required && (values[name] === undefined || values[name] === null)) rejected += 1;
      if (f.role === 'dimension' && f.labelField) {
        const value = values[name];
        const label = values[f.labelField];
        // Captured per run, which is what makes "the title as it was" true a year later.
        if (value !== null && value !== undefined && label !== null && label !== undefined)
          labels.set(`${name}\u0000${value}`, label);
      }
    }
    const amount = measure === undefined ? null : (values[measure] ?? null);

    for (const grouping of groupings) {
      // An absent value is its own bucket, never folded into a fabricated one and never a
      // NULL, which inside this composite key would not compare equal to itself. Which of the
      // two absences this is — no such slot, or no value in it — is read off `dim_set`.
      const dim1 = grouping.dims[0] === undefined ? DIM_NONE : (values[grouping.dims[0]] ?? DIM_NONE);
      const dim2 = grouping.dims[1] === undefined ? DIM_NONE : (values[grouping.dims[1]] ?? DIM_NONE);
      for (const [grain, start] of [['day', dayStart(row.occurred_at)], ['month', monthStart(row.occurred_at)]] as const) {
        const key = [grain, grouping.dimSet, start, dim1, dim2].join('\u0000');
        const cell = cells.get(key) ?? { events: 0, measure: null };
        cell.events += 1;
        // A missing amount stays null and is skipped, because a measure defaulted to zero is
        // invisible in a total and silently wrong.
        if (amount !== null) cell.measure = cell.measure === null ? amount : addDecimal(cell.measure, amount);
        cells.set(key, cell);
      }
    }
  }

  for (const [key, cell] of cells) {
    const [grain, dimSet, periodStart, dim1, dim2] = key.split('\u0000') as [string, string, string, string, string];
    ctx.sql.exec(
      `INSERT INTO tock_rollups
         (source_key, grain, dim_set, period_start, dim1, dim2, run_id, events, measure, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_key, grain, dim_set, period_start, dim1, dim2, run_id) DO UPDATE SET
         events = excluded.events, measure = excluded.measure`,
      [run.source_key, grain, dimSet, periodStart, dim1, dim2, run.id, cell.events, cell.measure, measure ?? null],
    );
  }

  for (const [key, label] of labels) {
    const [dim, value] = key.split('\u0000') as [string, string];
    ctx.sql.exec(
      `INSERT INTO tock_labels (run_id, dim, value, label, captured_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, dim, value) DO UPDATE SET label = excluded.label`,
      [run.id, dim, value, label, ctx.now()],
    );
  }

  // What produced these numbers, by content identity rather than by name. A list called
  // "2026-03" can be edited upstream without its name changing, so the hash is the part a
  // re-run can be held to.
  ctx.sql.exec(
    `INSERT INTO tock_rule_states (id, run_id, rule_kind, identifier, content_hash, captured_at)
       VALUES (?, ?, 'salt', ?, ?, ?)
     ON CONFLICT(run_id, rule_kind) DO UPDATE SET identifier = excluded.identifier`,
    [ulid(), run.id, `days:${dayOf(run.period_from)}..${dayOf(run.period_to)}`, schema.id, ctx.now()],
  );

  ctx.sql.exec('UPDATE tock_runs SET status = ?, rejected_count = ?, counted_at = ? WHERE id = ?', [
    'counted',
    rejected,
    ctx.now(),
    run.id,
  ]);
  const after = runOrThrow(ctx, run.id);
  ctx.emit({
    type: 'tock.run-counted',
    schemaVersion: 1,
    entity: runRef(after.id),
    piiClass: 'none',
    payload: {
      id: after.id,
      source_key: after.source_key,
      schema_version: after.schema_version,
      period_from: after.period_from,
      period_to: after.period_to,
      row_count: after.row_count,
      rejected_count: after.rejected_count,
      counted_at: after.counted_at,
    },
  });
  return { ...after, complete: true };
};

// ── reads ───────────────────────────────────────────────────────────────────

const getRunOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/get-run']>,
  HandlerOutput<(typeof tockOperations)['tock/get-run']>
> = async (ctx, input) => {
  const run = runOrThrow(ctx, input.runId);
  assertAllowed(await ctx.check(TOCK_PERM.reportRead, runRef(run.id)));
  return run;
};

const listRunsOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/list-runs']>,
  HandlerOutput<(typeof tockOperations)['tock/list-runs']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead));
  // `total: true` is declared, so the kernel counts and the declared output is a CountedPage.
  // `ctx.page` returns the union for every caller, and the narrowing is the declaration's.
  return ctx.page<RunRow>('run', {
    ...input,
    filters: { source_key: input.sourceKey },
    total: true,
  }) as CountedPage<RunRow>;
};

const listObservationsOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/list-observations']>,
  HandlerOutput<(typeof tockOperations)['tock/list-observations']>
> = async (ctx, input) => {
  const run = runOrThrow(ctx, input.runId);
  assertAllowed(await ctx.check(TOCK_PERM.reportRead, runRef(run.id)));
  return ctx.page<ObservationRow>('observation', { ...input, filters: { run_id: run.id } });
};

/**
 * Where the declaration and the data disagree.
 *
 * The first finding is the one no sampling tool can produce: a field that arrived and nobody
 * declared. Absence of evidence is invisible to a sampler; here both halves are facts, so
 * their disagreement is one too.
 */
const deviationsOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/deviations']>,
  HandlerOutput<(typeof tockOperations)['tock/deviations']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead));
  sourceOrThrow(ctx, input.sourceKey);

  const version =
    input.schemaVersion ??
    ctx.sql.query<{ version: number }>('SELECT MAX(version) AS version FROM tock_schemas WHERE source_key = ?', [
      input.sourceKey,
    ])[0]?.version;
  if (version === undefined || version === null)
    throw substratError('precondition_failed', `source ${input.sourceKey} has no schema yet`);
  const schema = schemaOrThrow(ctx, input.sourceKey, version);
  const declared: FieldDefs = JSON.parse(schema.fields_json) as FieldDefs;

  const observed = ctx.sql.query<{ field: string; present: number; runs: number; types: string; first_seen: string; last_seen: string }>(
    `SELECT o.field                        AS field,
            SUM(o.present_count)           AS present,
            COUNT(DISTINCT o.run_id)       AS runs,
            GROUP_CONCAT(DISTINCT o.inferred_type) AS types,
            MIN(h.first_seen)              AS first_seen,
            MAX(h.last_seen)               AS last_seen
       FROM tock_observations o
       JOIN tock_runs r ON r.id = o.run_id
       LEFT JOIN tock_field_history h ON h.source_key = r.source_key AND h.field = o.field
      WHERE r.source_key = ?
      GROUP BY o.field`,
    [input.sourceKey],
  );

  const findings: HandlerOutput<(typeof tockOperations)['tock/deviations']>['findings'] = [];
  const seen = new Set<string>();

  for (const o of observed) {
    seen.add(o.field);
    const def = declared[o.field];
    if (!def) {
      findings.push({
        kind: 'undeclared_field',
        field: o.field,
        detail: `arrived in ${o.runs} run(s) and version ${version} does not declare it`,
        firstSeen: o.first_seen ?? null,
        lastSeen: o.last_seen ?? null,
        runs: o.runs,
      });
      continue;
    }
    const types = (o.types ?? '').split(',').filter((t) => t && t !== 'unknown');
    const wrong = types.filter((t) => t !== def.type);
    if (wrong.length > 0)
      findings.push({
        kind: 'type_mismatch',
        field: o.field,
        detail: `declared ${def.type}, observed ${wrong.join(', ')}`,
        firstSeen: o.first_seen ?? null,
        lastSeen: o.last_seen ?? null,
        runs: o.runs,
      });
  }

  for (const [field] of Object.entries(declared)) {
    if (seen.has(field)) continue;
    findings.push({
      kind: 'declared_never_arrived',
      field,
      detail: `declared in version ${version} and has never appeared in any run of this source`,
      firstSeen: null,
      lastSeen: null,
      runs: 0,
    });
  }

  // A producer sending dynamic keys turns a field list into a field explosion. Reported as a
  // data-quality finding rather than silently absorbed, because the cost lands on every later
  // read of this source.
  const distinct = ctx.sql.query<{ n: number }>(
    `SELECT COUNT(DISTINCT o.field) AS n FROM tock_observations o
       JOIN tock_runs r ON r.id = o.run_id WHERE r.source_key = ?`,
    [input.sourceKey],
  )[0];
  if ((distinct?.n ?? 0) > 200)
    findings.push({
      kind: 'cardinality_spike',
      field: '*',
      detail: `${distinct?.n} distinct field names across this source's runs — a producer sending dynamic keys will look like this`,
      firstSeen: null,
      lastSeen: null,
      runs: 0,
    });

  return { sourceKey: input.sourceKey, schemaVersion: version, findings };
};

const fieldHistoryOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/field-history']>,
  HandlerOutput<(typeof tockOperations)['tock/field-history']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead));
  const limit = Math.min(input.limit ?? FIELD_HISTORY_MAX, FIELD_HISTORY_MAX);
  const entries = input.field
    ? ctx.sql.query<FieldHistoryRow>(
        'SELECT * FROM tock_field_history WHERE source_key = ? AND field = ? ORDER BY day DESC, field LIMIT ?',
        [input.sourceKey, input.field, limit + 1],
      )
    : ctx.sql.query<FieldHistoryRow>(
        'SELECT * FROM tock_field_history WHERE source_key = ? ORDER BY day DESC, field LIMIT ?',
        [input.sourceKey, limit + 1],
      );
  // One more than asked for, so "there is more" is observed rather than guessed.
  const capped = entries.length > limit;
  return { entries: capped ? entries.slice(0, limit) : entries, limit, capped };
};

const listRowsOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/list-rows']>,
  HandlerOutput<(typeof tockOperations)['tock/list-rows']>
> = async (ctx, input) => {
  const run = runOrThrow(ctx, input.runId);
  assertAllowed(await ctx.check(TOCK_PERM.rowRead, runRef(run.id)));
  return ctx.page<RowRow>('row', { ...input, filters: { run_id: run.id } });
};

const readSourceFileOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/read-source-file']>,
  HandlerOutput<(typeof tockOperations)['tock/read-source-file']>
> = async (ctx, input) => {
  const run = runOrThrow(ctx, input.runId);
  // `row:read`, not `report:read` — the file IS raw rows, so guarding it with the reporting
  // permission would be a way around the whole permission table.
  assertAllowed(await ctx.check(TOCK_PERM.rowRead, runRef(run.id)));
  const row = ctx.sql.query<SourceFileRow>('SELECT * FROM tock_source_files WHERE run_id = ?', [run.id])[0];
  if (!row) throw substratError('not_found', `no stored file for run ${run.id}`);
  return row;
};

/**
 * The report, over the current run per period.
 *
 * "Current" is derived here rather than read off a column: for each period the answer is the
 * latest-counted run covering it, which is why counting a correction needs no write to the run
 * it displaces and why the displaced run's numbers are still readable through `get-run`.
 */
const reportOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/report']>,
  HandlerOutput<(typeof tockOperations)['tock/report']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead));
  sourceOrThrow(ctx, input.sourceKey);

  const rows = ctx.sql.query<{
    period_start: string;
    dim1: string;
    dim2: string;
    events: number;
    measure: string | null;
    unit: string | null;
    run_id: string;
    label1: string | null;
    label2: string | null;
  }>(
    `SELECT ro.period_start, ro.dim1, ro.dim2, ro.events, ro.measure, ro.unit, ro.run_id,
            l1.label AS label1, l2.label AS label2
       FROM tock_rollups ro
       JOIN tock_runs r ON r.id = ro.run_id
       LEFT JOIN tock_labels l1 ON l1.run_id = ro.run_id AND l1.dim = ro.dim_set AND l1.value = ro.dim1
       LEFT JOIN tock_labels l2 ON l2.run_id = ro.run_id AND l2.dim = ro.dim_set AND l2.value = ro.dim2
      WHERE ro.source_key = ? AND ro.grain = ? AND ro.dim_set = ?
        AND ro.period_start >= ? AND ro.period_start < ?
        AND r.counted_at = (
              SELECT MAX(r2.counted_at) FROM tock_rollups ro2
                JOIN tock_runs r2 ON r2.id = ro2.run_id
               WHERE ro2.source_key = ro.source_key AND ro2.grain = ro.grain
                 AND ro2.dim_set = ro.dim_set AND ro2.period_start = ro.period_start
            )
      ORDER BY ro.period_start, ro.dim1, ro.dim2`,
    [input.sourceKey, input.grain, input.dimSet, input.from, input.to],
  );

  // Unknown is an empty value in a slot the grouping USES; an empty value in a slot it does
  // not use is simply that slot being absent, and hiding those would hide every total.
  const used = dimsOfSet(input.dimSet).length;
  const unknown = (r: { dim1: string; dim2: string }) =>
    (used >= 1 && r.dim1 === DIM_NONE) || (used >= 2 && r.dim2 === DIM_NONE);
  const visible = input.includeUnknown ? rows : rows.filter((r) => !unknown(r));
  return {
    rows: visible.map((r) => ({
      periodStart: r.period_start,
      dim1: r.dim1,
      dim2: r.dim2,
      label1: r.label1,
      label2: r.label2,
      events: r.events,
      measure: r.measure,
      unit: r.unit,
      runId: r.run_id,
    })),
    grain: input.grain,
    dimSet: input.dimSet,
  };
};

const operations = {
  'tock/declare-source': declareSourceOp,
  'tock/list-sources': listSourcesOp,
  'tock/save-schema': saveSchemaOp,
  'tock/list-schemas': listSchemasOp,
  'tock/receive-run': receiveRunOp,
  'tock/profile-run': profileRunOp,
  'tock/map-run': mapRunOp,
  'tock/count-run': countRunOp,
  'tock/get-run': getRunOp,
  'tock/list-runs': listRunsOp,
  'tock/list-observations': listObservationsOp,
  'tock/deviations': deviationsOp,
  'tock/field-history': fieldHistoryOp,
  'tock/list-rows': listRowsOp,
  'tock/read-source-file': readSourceFileOp,
  'tock/report': reportOp,
} satisfies {
  [K in keyof typeof tockOperations]: OperationHandler<
    HandlerInput<(typeof tockOperations)[K]>,
    HandlerOutput<(typeof tockOperations)[K]>
  >;
};

export const tockModule: ModuleRegistration = {
  manifest: tockManifest,
  migrations: tockMigrations,
  operationInputs: operationInputsOf(tockOperations),
  operations: operations as ModuleRegistration['operations'],
};
