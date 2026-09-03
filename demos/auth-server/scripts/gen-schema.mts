/**
 * Emit the issuer's SQLite schema FROM Better Auth's own table declarations.
 *
 *   src/auth-schema.generated.ts   the Drizzle tables the adapter reads
 *   db/ddl.generated.ts            the raw CREATE TABLE statements both stores init from
 *
 * Both were hand-maintained until the 1.7 migration, and hand-maintaining them was a
 * standing drift trap: the DDL, the Drizzle schema and what the library actually expects
 * are three copies of one fact, and a plugin that adds a column breaks the third copy at
 * RUNTIME, in a Durable Object, on a query nobody ran in CI. `oauthProvider` replaced three
 * tables with six and forty-odd columns — hand-writing that once would have been merely
 * error-prone; hand-writing it every time the plugin evolves is a defect waiting for a
 * deploy. So the source of truth is `getAuthTables(auth.options)` — read off the REAL
 * `buildAuth` config, not a parallel one — and `pnpm lint:auth-schema --check` in CI
 * re-emits and refuses on drift, which is what makes "do not edit by hand" true rather
 * than merely requested. `test/schema-generated.test.ts` answers the other half a diff
 * cannot: whether the emitted DDL, run against a real database, satisfies the library.
 *
 * Columns stay snake_case (what live databases already have) and the Drizzle schema is what
 * maps them, so the adapter and the DDL cannot disagree about a name.
 *
 *   pnpm --filter @substrat-run/demo-auth-server gen:schema [--check]
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getAuthTables } from 'better-auth/db';
import { MockEmailTransport } from '@substrat-run/adapter-email';
import { buildAuth } from '../src/auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The real config's plugin list is what decides the schema, so read the real config. */
const auth = buildAuth({
  // `getAuthTables` never touches the database; only `plugins` shape the answer.
  database: undefined as never,
  secret: 'schema-generation-only',
  baseURL: 'http://localhost',
  trustedOrigins: ['http://localhost'],
  transport: new MockEmailTransport(),
  sender: { email: 'no-reply@example.test', name: 'Schema' },
});

const tables = getAuthTables(auth.options as never) as Record<
  string,
  {
    modelName?: string;
    fields: Record<
      string,
      {
        type: string;
        fieldName?: string;
        required?: boolean;
        unique?: boolean;
        defaultValue?: unknown;
        references?: { model: string; field: string; onDelete?: string };
        index?: boolean;
      }
    >;
    indexes?: { fields: string[]; unique?: boolean }[];
  }
>;

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Better Auth type → storage. SQLite is not a `supportsJSON`/`supportsArrays` provider for
 * the drizzle adapter, so `string[]` and `json` arrive already serialized: the column is
 * plain TEXT and Drizzle must NOT also declare `mode: 'json'`, or every value round-trips
 * through JSON twice.
 */
const SQL_TYPE: Record<string, string> = {
  string: 'TEXT',
  'string[]': 'TEXT',
  json: 'TEXT',
  number: 'INTEGER',
  boolean: 'INTEGER',
  date: 'INTEGER',
};

const DRIZZLE_COLUMN: Record<string, (col: string) => string> = {
  string: (c) => `text('${c}')`,
  'string[]': (c) => `text('${c}')`,
  json: (c) => `text('${c}')`,
  number: (c) => `integer('${c}')`,
  boolean: (c) => `integer('${c}', { mode: 'boolean' })`,
  date: (c) => `integer('${c}', { mode: 'timestamp_ms' })`,
};

/** SQLite's own clock, in the epoch-ms Better Auth stores dates as. */
const NOW_MS = "(cast(unixepoch('subsecond') * 1000 as integer))";

interface Column {
  field: string;
  column: string;
  type: string;
  required: boolean;
  unique: boolean;
  hasDefault: boolean;
  defaultLiteral?: string;
  references?: { table: string; column: string; onDelete?: string };
}

interface Table {
  model: string;
  table: string;
  columns: Column[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
}

function tableOf(model: string, def: (typeof tables)[string]): Table {
  const table = snake(def.modelName ?? model);
  const columns: Column[] = [
    { field: 'id', column: 'id', type: 'string', required: true, unique: false, hasDefault: false },
  ];
  const indexes: { name: string; columns: string[]; unique: boolean }[] = [];
  for (const [field, f] of Object.entries(def.fields)) {
    const column = snake(f.fieldName ?? field);
    const isDate = f.type === 'date';
    const literal =
      f.defaultValue === undefined
        ? undefined
        : typeof f.defaultValue === 'function'
          ? isDate
            ? NOW_MS
            : undefined
          : typeof f.defaultValue === 'boolean'
            ? f.defaultValue
              ? '1'
              : '0'
            : Array.isArray(f.defaultValue)
              ? `'${JSON.stringify(f.defaultValue)}'`
              : typeof f.defaultValue === 'number'
                ? String(f.defaultValue)
                : `'${String(f.defaultValue)}'`;
    columns.push({
      field,
      column,
      type: f.type,
      required: f.required !== false,
      unique: Boolean(f.unique),
      hasDefault: literal !== undefined,
      ...(literal !== undefined ? { defaultLiteral: literal } : {}),
      ...(f.references
        ? {
            references: {
              table: snake(tables[f.references.model]?.modelName ?? f.references.model),
              column: snake(f.references.field),
              ...(f.references.onDelete ? { onDelete: f.references.onDelete } : {}),
            },
          }
        : {}),
    });
    if (f.index) indexes.push({ name: `${table}_${column}_idx`, columns: [column], unique: false });
  }
  for (const idx of def.indexes ?? []) {
    const cols = idx.fields.map((f) => snake(def.fields[f]?.fieldName ?? f));
    indexes.push({ name: `${table}_${cols.join('_')}_idx`, columns: cols, unique: Boolean(idx.unique) });
  }
  return { model, table, columns, indexes };
}

const models = Object.entries(tables).map(([model, def]) => tableOf(model, def));

/* ---- db/ddl.generated.ts ---- */

function ddlOf(t: Table): string {
  const cols = t.columns.map((c) => {
    const parts = [`${c.column} ${SQL_TYPE[c.type] ?? 'TEXT'}`];
    if (c.column === 'id') parts.push('PRIMARY KEY');
    if (c.required || c.column === 'id') parts.push('NOT NULL');
    if (c.unique) parts.push('UNIQUE');
    if (c.hasDefault) parts.push(`DEFAULT ${c.defaultLiteral}`);
    if (c.references) {
      parts.push(`REFERENCES ${c.references.table}(${c.references.column})`);
      if (c.references.onDelete) parts.push(`ON DELETE ${c.references.onDelete.toUpperCase()}`);
    }
    return `    ${parts.join(' ')}`;
  });
  return `  \`CREATE TABLE IF NOT EXISTS ${t.table} (\n${cols.join(',\n')})\`,`;
}

const ddl = `/**
 * GENERATED by scripts/gen-schema.mts from Better Auth's own table declarations
 * (\`getAuthTables\` over the real \`buildAuth\` config) — do not edit by hand.
 * Re-emit with \`pnpm --filter @substrat-run/demo-auth-server gen:schema\`;
 * \`test/schema-generated.test.ts\` fails if this file and the config disagree.
 *
 * The raw \`CREATE TABLE\` DDL for the issuer's SQLite store — the drizzle-over-SQLite drivers
 * (Durable Object and better-sqlite3) do not run migrations, so both stores are created from
 * these on init.
 *
 * This lives OUTSIDE \`src/\` on purpose. \`tools/boundary-lint.mjs\` builds its table-ownership
 * map by scanning every \`CREATE TABLE <name>\` under a package's \`src/\`, and these are the
 * GENERIC Better Auth table names (\`user\`, \`session\`, \`account\`, \`verification\`) that other
 * packages (e.g. apps/dashboard) also create. Declaring them under \`src/\` would make this demo
 * the global "owner" of those names and flag every other package's own auth tables as R5
 * violations. Raw infra DDL is not module code, so — like Callout's \`migrations/*.sql\` — it
 * belongs out of the linted module tree.
 */
export const SCHEMA_STATEMENTS: string[] = [
${models.map(ddlOf).join('\n')}
${models
  .flatMap((t) => t.indexes)
  .map((i) => `  \`CREATE${i.unique ? ' UNIQUE' : ''} INDEX IF NOT EXISTS ${i.name} ON ${i.columns[0] && models.find((m) => m.indexes.includes(i))?.table} (${i.columns.join(', ')})\`,`)
  .join('\n')}
  // This issuer's own config — notably its generated, persisted signing secret, and the
  // per-instance \`cfg:\` rows the platform and the dashboard deliver. Not a Better Auth
  // table, so it is declared here rather than derived.
  \`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)\`,
  // The UPSTREAM identity providers an operator has enabled (\`src/providers.ts\`). Also not a
  // Better Auth table: the library takes its social providers as CONFIG, and this is where an
  // issuer that is configured at runtime keeps them instead.
  \`CREATE TABLE IF NOT EXISTS identity_provider (
    provider_id TEXT PRIMARY KEY NOT NULL,
    client_id TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    tenant_id TEXT,
    allow_signup INTEGER NOT NULL DEFAULT 0,
    trust_email INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)))\`,
];
`;

/* ---- src/auth-schema.generated.ts ---- */

function drizzleOf(t: Table): string {
  const cols = t.columns.map((c) => {
    let expr = (DRIZZLE_COLUMN[c.type] ?? DRIZZLE_COLUMN.string!)(c.column);
    if (c.column === 'id') expr += '.primaryKey()';
    if (c.references) {
      const onDelete = c.references.onDelete ? `, { onDelete: '${c.references.onDelete}' }` : '';
      expr += `.references(() => ${camel(c.references.table)}.${camel(c.references.column)}${onDelete})`;
    }
    if (c.unique) expr += '.unique()';
    if (c.hasDefault && c.defaultLiteral === NOW_MS) expr += '.default(nowMs)';
    else if (c.hasDefault && c.type === 'boolean') expr += `.default(${c.defaultLiteral === '1'})`;
    else if (c.hasDefault && c.type === 'number') expr += `.default(${c.defaultLiteral})`;
    else if (c.hasDefault && c.defaultLiteral) expr += `.default(${c.defaultLiteral.replace(/^'|'$/g, "'")})`;
    if (c.required || c.column === 'id') expr += '.notNull()';
    return `  ${c.field}: ${expr},`;
  });
  const indexes = t.indexes.length
    ? `,\n  (table) => [${t.indexes
        .map(
          (i) =>
            `${i.unique ? 'uniqueIndex' : 'index'}('${i.name}').on(${i.columns
              .map((c) => `table.${t.columns.find((col) => col.column === c)?.field ?? camel(c)}`)
              .join(', ')})`,
        )
        .join(', ')}]`
    : '';
  return `export const ${camel(t.table)} = sqliteTable(\n  '${t.table}',\n  {\n${cols.join('\n')}\n  }${indexes},\n);`;
}

function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

const schemaFile = `/**
 * GENERATED by scripts/gen-schema.mts from Better Auth's own table declarations
 * (\`getAuthTables\` over the real \`buildAuth\` config) — do not edit by hand.
 * Re-emit with \`pnpm --filter @substrat-run/demo-auth-server gen:schema\`;
 * \`test/schema-generated.test.ts\` fails if this file and the config disagree.
 *
 * The Drizzle schema the Better Auth adapter reads. Column names are snake_case — this file
 * is what maps Better Auth's camelCase fields onto them, so the adapter and \`db/ddl.generated.ts\`
 * cannot disagree about a name.
 *
 * SQLite is not a \`supportsJSON\`/\`supportsArrays\` provider for the drizzle adapter, so
 * \`string[]\` and \`json\` fields arrive already serialized and their columns are plain \`text\` —
 * declaring \`mode: 'json'\` here would round-trip every value through JSON twice.
 */
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** SQLite's own clock, in the epoch-ms Better Auth stores dates as. */
const nowMs = sql\`(cast(unixepoch('subsecond') * 1000 as integer))\`;

${models.map(drizzleOf).join('\n\n')}

export const schema = {
${models.map((t) => `  ${camel(t.table)},`).join('\n')}
};
`;

const targets: [string, string][] = [
  [join(root, 'db', 'ddl.generated.ts'), ddl],
  [join(root, 'src', 'auth-schema.generated.ts'), schemaFile],
];

const check = process.argv.includes('--check');
let drifted = false;
for (const [path, content] of targets) {
  const current = (() => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  })();
  if (current === content) continue;
  if (check) {
    drifted = true;
    console.error(`gen-schema: ${path.replace(`${root}/`, '')} is out of date`);
  } else {
    writeFileSync(path, content);
    console.log(`gen-schema: wrote ${path.replace(`${root}/`, '')}`);
  }
}
if (check && drifted) process.exit(1);
if (check && !drifted) console.log(`gen-schema: ${targets.length} file(s) up to date`);
