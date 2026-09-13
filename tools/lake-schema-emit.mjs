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
