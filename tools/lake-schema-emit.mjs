#!/usr/bin/env node
/**
 * The lake's stream schema, derived from the outbox rather than typed beside it.
 *
 * `scripts/lake/outbox-stream-schema.generated.json` is what the Tier-2 stream is created
 * with: the columns of `_substrat_outbox` as Cloudflare Pipelines field declarations. It
 * restates a shape that already exists in two adapter DDLs — and the first hand-written
 * copy of it dropped `caused_by` on its first attempt (#1237). That is the case the
 * three-marks rule in CLAUDE.md exists for, so this is the producer and `--check` is the
 * gate.
 *
 * The SOURCE is the effective `_substrat_outbox` the pure adapter builds — the DDL block
 * plus the columns `runtime()` ALTERs in afterwards — read through the same extraction
 * `lint:spine-ddl` uses, which separately proves the hosted adapter builds the same table.
 * So a column that reaches production reaches this file, or CI is red until it does.
 *
 * What the DDL cannot say is the stream TYPE: `payload TEXT` is JSON on the wire,
 * `occurred_at TEXT` is a timestamp, `schema_version INTEGER` is an int64. That half is the
 * table below, keyed by column — and it is a closed list on both sides: an outbox column
 * the table does not name fails (the lake would silently drop it), and a table entry
 * naming no column fails (the table has drifted from the outbox). `required` is the
 * column's NOT NULL, which is the one fact the DDL does hold.
 *
 *   node tools/lake-schema-emit.mjs           # (re)write the file
 *   node tools/lake-schema-emit.mjs --check   # CI: fail if the file is not what this emits
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeTableColumns } from './spine-ddl-drift.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'scripts/lake/outbox-stream-schema.generated.json';
const TABLE = '_substrat_outbox';
const CHECK = process.argv.includes('--check');

/**
 * Stream field type per outbox column. `timestamp` carries `unit: 'millisecond'`, the
 * precision the ISO text the kernel writes actually has.
 */
const STREAM_TYPE = {
  id: 'string',
  type: 'string',
  schema_version: 'int64',
  occurred_at: 'timestamp',
  tenant_id: 'string',
  scope_id: 'string',
  actor: 'string',
  entity_type: 'string',
  entity_id: 'string',
  pii_class: 'string',
  subject_id: 'string',
  payload: 'json',
  authorization: 'json',
  impersonation: 'json',
  operation: 'string',
  version: 'string',
  caused_by: 'string',
};

/**
 * Outbox columns that are drain bookkeeping, not history. `drained_at` records that the
 * shipper took the row; the lake is what it took the row TO, so the column would be a
 * fact about the copy, not the event.
 */
const NOT_SHIPPED = new Set(['drained_at']);

/**
 * Columns the SINK computes, which exist in no DDL and so cannot be derived.
 *
 * The third category, and it needs naming rather than smuggling: the two above are about
 * which outbox columns travel, while these are facts about the SHIPMENT that only the
 * thing doing the shipping knows. They are appended after the derived fields and
 * deliberately exempt from the drift check below — a `seen.has()` over them would fail
 * every time, since the whole point is that the outbox does not have them.
 *
 * `bytes` is the row's serialized UTF-8 size, which is what makes per-tenant volume
 * answerable at all: every tenant's events share one parquet file, so R2 reports no
 * per-tenant storage and summing this column per tenant is the only honest measure.
 * Sum it over DEDUPLICATED rows — `SELECT DISTINCT tenant_id, id, bytes` first — because
 * the sink is at-least-once and a retried batch re-lands its already-ingested prefix;
 * a bare `SUM(bytes)` bills a tenant for the platform's retry. See the sink's own header
 * (packages/control-plane-api/src/pipelines-sink.ts) for the query.
 * It counts the row AS SHIPPED, not as stored — parquet is columnar and zstd-compressed,
 * and a tenant's share of a shared compressed file is not attributable to them anyway.
 * Billing on logical volume is the more defensible basis for exactly that reason: it does
 * not move when compaction runs, or when another tenant's data happens to compress well.
 *
 * Anything added here is a schema change, and a stream's schema cannot be updated — see
 * the --check message. Adding one after data exists means a NEW TABLE, because a sink
 * refuses to write to an existing one.
 */
const SINK_COMPUTED = [
  { name: 'bytes', type: 'int64', required: true },
];

/** A stream type's SQL storage class, so the table above cannot mis-declare a column. */
const STORAGE_OF = { string: 'TEXT', json: 'TEXT', timestamp: 'TEXT', int64: 'INTEGER' };

function emit() {
  const columns = scopeTableColumns(TABLE);
  const problems = [];
  const fields = [];
  for (const col of columns) {
    if (NOT_SHIPPED.has(col.name)) continue;
    const type = STREAM_TYPE[col.name];
    if (!type) {
      problems.push(
        `${TABLE}.${col.name} has no stream type — add it to STREAM_TYPE in tools/lake-schema-emit.mjs ` +
          `(or to NOT_SHIPPED, if it is bookkeeping the lake must not carry)`,
      );
      continue;
    }
    if (STORAGE_OF[type] !== col.type) {
      problems.push(`${TABLE}.${col.name} is ${col.type} in the DDL but declared ${type} for the stream`);
    }
    fields.push({
      name: col.name,
      type,
      required: Boolean(col.notnull || col.pk),
      ...(type === 'timestamp' ? { unit: 'millisecond' } : {}),
    });
  }
  for (const f of SINK_COMPUTED) {
    if (STREAM_TYPE[f.name]) {
      problems.push(`${f.name} is both SINK_COMPUTED and STREAM_TYPE — it cannot be derived and supplied`);
      continue;
    }
    fields.push({ name: f.name, type: f.type, required: f.required });
  }
  const seen = new Set(columns.map((c) => c.name));
  for (const name of [...Object.keys(STREAM_TYPE), ...NOT_SHIPPED]) {
    if (!seen.has(name)) problems.push(`STREAM_TYPE/NOT_SHIPPED names ${name}, which ${TABLE} no longer has`);
  }
  if (problems.length > 0) {
    console.error(`✗ lake schema cannot be derived:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  return `${JSON.stringify({ fields }, null, 2)}\n`;
}

const next = emit();
const file = path.join(ROOT, OUT);
const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

if (CHECK) {
  if (current !== next) {
    console.error(
      `✗ ${OUT} is not what tools/lake-schema-emit.mjs emits from ${TABLE}.\n` +
        `  Run \`pnpm lint:lake-schema\` and commit the result. A stream already created from the\n` +
        `  old file is NOT updated by that — the live table needs an Iceberg schema evolution.`,
    );
    process.exit(1);
  }
  console.log(`lake schema: ${OUT} matches ${TABLE}`);
} else {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  console.log(`${current === next ? 'unchanged' : 'wrote'} ${OUT}`);
}
