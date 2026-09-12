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
type VariantRow = EntityRow<typeof tockEntities, 'variant'>;
type OutputSchemaRow = EntityRow<typeof tockEntities, 'output_schema'>;
type MappingRow = EntityRow<typeof tockEntities, 'mapping'>;

/** One correspondence: a field over here becomes a field over there. Nothing else. */
interface MappingRule {
  from: string;
  to: string;
}

/** The envelope every record carries, whatever its kind. A real value, never a null. */
const ROOT = '';

/**
 * A variant's key is its selector joined — `track/scroll`. Readable, and its own path.
 *
 * The join is only reversible because `tock/declare-variants` refuses a selector value that
 * is empty or contains `/`. That refusal is what lets `pathOf` read a key back as the list
 * of levels a record inherits from; without it `ui/click` would be one kind that reads as
 * two, inheriting from a `ui` nobody declared, and `''` would be a kind that reads as the
 * envelope. The constraint lives at declaration because that is the only place a person can
 * still fix it.
 */
const keyOf = (selector: readonly string[]) => selector.join('/');

/**
 * Every prefix of a variant key, root first: `''`, `'track'`, `'track/scroll'`.
 *
 * This is what "schemas stack" means mechanically — a record's shape is the union along this
 * list, so the envelope is declared once and a kind declares only what it adds.
 */
function pathOf(variantKey: string): string[] {
  if (variantKey === ROOT) return [ROOT];
  const parts = variantKey.split('/');
  return [ROOT, ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
}

/**
 * Which kind a record belongs to: the LONGEST variant whose discriminator values all hold.
 *
 * Returns `ROOT` when none match, which is a classification and not a rejection — a producer
 * shipping a kind nobody declared must never cost the data, and the findings view is where
 * that surfaces. Ambiguity cannot arise here because a longer selector always wins; two
 * variants with the SAME selector are refused at declaration instead.
 */
function classify(
  discriminators: string[],
  variants: readonly { key: string; selector: string[] }[],
  fields: Record<string, string | null>,
): string {
  let best = ROOT;
  // The depth is carried, never re-derived from the key: `best.split('/')` asks the key how
  // deep it is, which is a second, weaker answer to a question the selector already answered
  // exactly. They agree only while every selector value is `/`-free — true today because
  // declaration refuses otherwise, and not a thing this loop should depend on.
  let bestDepth = 0;
  for (const v of variants) {
    if (v.selector.length <= bestDepth) continue;
    const holds = v.selector.every((want, i) => {
      const field = discriminators[i];
      return field !== undefined && fields[field] === want;
    });
    if (holds) {
      best = v.key;
      bestDepth = v.selector.length;
    }
  }
  return best;
}

/** A source's declared kinds, in the shape `classify` wants. */
function variantsOf(ctx: OperationContext, sourceKey: string) {
  const rows = ctx.sql.query<VariantRow>(
    'SELECT * FROM tock_variants WHERE source_key = ? ORDER BY key',
    [sourceKey],
  );
  return rows.map((r) => ({ key: r.key, selector: JSON.parse(r.selector) as string[] }));
}

function discriminatorsOf(ctx: OperationContext, sourceKey: string): string[] {
  const row = ctx.sql.query<{ discriminators: string | null }>(
    'SELECT discriminators FROM tock_sources WHERE key = ?',
    [sourceKey],
  )[0];
  // Null is the older fact — this source predates variants — and reads as "no kinds".
  return row?.discriminators ? (JSON.parse(row.discriminators) as string[]) : [];
}
type RuleStateRow = EntityRow<typeof tockEntities, 'rule_state'>;

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

function schemaOrThrow(ctx: OperationContext, sourceKey: string, version: number, variantKey = ROOT): SchemaRow {
  const row = ctx.sql.query<SchemaRow>(
    'SELECT * FROM tock_schemas WHERE source_key = ? AND variant_key = ? AND version = ?',
    [sourceKey, variantKey, version],
  )[0];
  if (!row) throw substratError('not_found', `no version ${version} of the ${variantKey || 'envelope'} schema for ${sourceKey}`);
  return row;
}

/**
 * The fields a record of this kind carries — the union along its path, nearest wins.
 *
 * Always the latest version of each prefix. A run pins the ENVELOPE version it was mapped to;
 * pinning every level independently would need a version per level on the run, which is a
 * cost this slice does not pay and the mapping slice will have to.
 */
function effectiveFields(ctx: OperationContext, sourceKey: string, variantKey: string): FieldDefs {
  const out: FieldDefs = {};
  for (const prefix of pathOf(variantKey)) {
    const row = ctx.sql.query<SchemaRow>(
      'SELECT * FROM tock_schemas WHERE source_key = ? AND variant_key = ? ORDER BY version DESC LIMIT 1',
      [sourceKey, prefix],
    )[0];
    if (row) Object.assign(out, JSON.parse(row.fields_json) as FieldDefs);
  }
  return out;
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
const hourStart = (instant: string) => `${instant.slice(0, 13)}:00:00.000Z`;

/**
 * The three grains the report declares, and therefore the three counting writes.
 *
 * All three, because a grain a caller may ask for and nothing ever writes is a report that
 * is empty forever and says nothing about why. `hour` was exactly that.
 */
const GRAINS = [
  ['hour', hourStart],
  ['day', dayStart],
  ['month', monthStart],
] as const;

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

/** No non-null value has been seen yet, so nothing is known about the type. */
const TYPE_UNKNOWN = 'unknown';

/**
 * The observed types of one field, as the column stores them: a comma-separated set.
 *
 * A SET rather than one value, because a field is not obliged to be consistent and the
 * inconsistency is the finding. `unknown` means only "no non-null value yet", so it is never
 * a member beside a real type — it is what an empty set renders as.
 */
const typeSet = (types: Iterable<string>): string => {
  const real = [...new Set(types)].filter((t) => t && t !== TYPE_UNKNOWN).sort();
  return real.length === 0 ? TYPE_UNKNOWN : real.join(',');
};

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
    'INSERT INTO tock_sources (key, title, expected_cadence, discriminators, created_at) VALUES (?, ?, ?, ?, ?)',
    [input.key, input.title, input.expectedCadence, '[]', ctx.now()],
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

/**
 * Declare the discriminators and the kinds, as one act.
 *
 * Replaces the set rather than versioning it. A variant that stopped existing would strand
 * every row classified into it, pointing at a kind nobody declares any more — so the set is
 * frozen once a run has been COUNTED instead, which is the point after which a
 * classification is load-bearing. Before that, changing your mind is free.
 */
const declareVariantsOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/declare-variants']>,
  HandlerOutput<(typeof tockOperations)['tock/declare-variants']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.schemaManage));
  sourceOrThrow(ctx, input.sourceKey);

  const counted = ctx.sql.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tock_runs WHERE source_key = ? AND status = 'counted'",
    [input.sourceKey],
  )[0];
  if ((counted?.n ?? 0) > 0)
    throw substratError(
      'conflict',
      'this source has counted runs, and their rows were classified by the kinds declared then — changing the kinds now would make a current number unreproducible',
      { reason: 'already_counted' },
    );

  const seen = new Set<string>();
  for (const v of input.variants) {
    if (v.selector.length > input.discriminators.length)
      throw substratError(
        'validation_failed',
        `selector [${v.selector.join(', ')}] is longer than the ${input.discriminators.length} declared discriminator(s) — a selector is a PREFIX of them`,
      );
    const key = keyOf(v.selector);
    if (seen.has(key))
      throw substratError('validation_failed', `two variants share the selector [${v.selector.join(', ')}]`);
    seen.add(key);
  }

  ctx.sql.exec('UPDATE tock_sources SET discriminators = ? WHERE key = ?', [
    JSON.stringify(input.discriminators),
    input.sourceKey,
  ]);
  ctx.sql.exec('DELETE FROM tock_variants WHERE source_key = ?', [input.sourceKey]);
  const now = ctx.now();
  for (const v of input.variants) {
    ctx.sql.exec(
      'INSERT INTO tock_variants (id, source_key, key, selector, created_at) VALUES (?, ?, ?, ?, ?)',
      [ulid(), input.sourceKey, keyOf(v.selector), JSON.stringify(v.selector), now],
    );
  }
  ctx.emit({
    type: 'tock.variants-declared',
    schemaVersion: 1,
    entity: sourceRef(input.sourceKey),
    piiClass: 'none',
    payload: { sourceKey: input.sourceKey },
  });
  return {
    sourceKey: input.sourceKey,
    discriminators: input.discriminators,
    variants: ctx.sql.query<VariantRow>('SELECT * FROM tock_variants WHERE source_key = ? ORDER BY key', [input.sourceKey]),
  };
};

const listVariantsOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/list-variants']>,
  HandlerOutput<(typeof tockOperations)['tock/list-variants']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead));
  sourceOrThrow(ctx, input.sourceKey);
  return {
    discriminators: discriminatorsOf(ctx, input.sourceKey),
    variants: ctx.sql.query<VariantRow>('SELECT * FROM tock_variants WHERE source_key = ? ORDER BY key', [input.sourceKey]),
  };
};

/** The latest version of one output shape, or undefined when none is declared. */
function latestOutput(ctx: OperationContext, sourceKey: string, key: string): OutputSchemaRow | undefined {
  return ctx.sql.query<OutputSchemaRow>(
    'SELECT * FROM tock_output_schemas WHERE source_key = ? AND key = ? ORDER BY version DESC LIMIT 1',
    [sourceKey, key],
  )[0];
}

const saveOutputSchemaOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/save-output-schema']>,
  HandlerOutput<(typeof tockOperations)['tock/save-output-schema']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.schemaManage));
  sourceOrThrow(ctx, input.sourceKey);

  const dims = Object.entries(input.fields).filter(([, f]) => f.role === 'dimension');
  if (dims.length > MAX_GROUPING_DIMENSIONS)
    throw substratError(
      'validation_failed',
      `an output shape may declare at most ${MAX_GROUPING_DIMENSIONS} grouping dimensions; this one declares ${dims.length} (${dims.map(([n]) => n).join(', ')})`,
    );


  /**
   * Additive only, and refused by name when it is not.
   *
   * A field that changes meaning turns every number already counted under it into a silent
   * lie, and unlike a wrong count that is not visible afterwards — the rows look fine. So the
   * refusal happens here, where someone can still choose a different field name.
   */
  const prior = latestOutput(ctx, input.sourceKey, input.key);
  if (prior) {
    const was = JSON.parse(prior.fields_json) as Record<string, { type: string; role: string }>;
    for (const [name, def] of Object.entries(was)) {
      const now = input.fields[name];
      if (!now)
        throw substratError(
          'validation_failed',
          `output '${input.key}' v${prior.version} declares '${name}' and this version drops it — an output shape is additive, because numbers already counted under a field cannot be un-counted`,
        );
      if (now.type !== def.type || now.role !== def.role)
        throw substratError(
          'validation_failed',
          `output '${input.key}' would change '${name}' from ${def.role}/${def.type} to ${now.role}/${now.type} — a field never changes meaning; add a new one`,
        );
    }
  }

  /**
   * One measure, for the same reason `save-schema` refuses a second: `groupingsOf` takes
   * `.find()` over the declared fields, so every measure after the first is silently
   * dropped at count time. The shape would look accepted while the number was quietly
   * about one column — a rollup row holds a single `measure` and a single `unit` and has
   * nowhere to put a second.
   *
   * AFTER the additive check on purpose. An edit that turns a dimension into a measure
   * beside an existing one trips both, and "a field never changes meaning" is the more
   * useful of the two answers: it names the field and the edit, where this one would only
   * report the count.
   */
  const measures = Object.entries(input.fields).filter(([, f]) => f.role === 'measure');
  if (measures.length > 1)
    throw substratError(
      'validation_failed',
      `an output shape may declare at most 1 measure; this one declares ${measures.length} (${measures.map(([n]) => n).join(', ')}). A rollup row holds one measure and one unit, so a second could be declared and never counted.`,
    );

  const version = (prior?.version ?? 0) + 1;
  const id = ulid();
  ctx.sql.exec(
    'INSERT INTO tock_output_schemas (id, source_key, key, version, fields_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, input.sourceKey, input.key, version, JSON.stringify(input.fields), ctx.principal, ctx.now()],
  );
  const row = ctx.sql.query<OutputSchemaRow>('SELECT * FROM tock_output_schemas WHERE id = ?', [id])[0]!;
  ctx.emit({
    type: 'tock.output-schema-saved',
    schemaVersion: 1,
    entity: sourceRef(row.source_key),
    piiClass: 'none',
    payload: { source_key: row.source_key, key: row.key, version: row.version },
  });
  return row;
};

const listOutputSchemasOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/list-output-schemas']>,
  HandlerOutput<(typeof tockOperations)['tock/list-output-schemas']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead));
  return ctx.page<OutputSchemaRow>('output_schema', { ...input, filters: { source_key: input.sourceKey } });
};

const saveMappingOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/save-mapping']>,
  HandlerOutput<(typeof tockOperations)['tock/save-mapping']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.schemaManage));
  sourceOrThrow(ctx, input.sourceKey);

  const output = latestOutput(ctx, input.sourceKey, input.outputKey);
  if (!output) throw substratError('not_found', `source ${input.sourceKey} declares no output shape '${input.outputKey}'`);
  if (input.variantKey !== ROOT) {
    const known = ctx.sql.query<{ key: string }>('SELECT key FROM tock_variants WHERE source_key = ? AND key = ?', [
      input.sourceKey,
      input.variantKey,
    ])[0];
    if (!known) throw substratError('not_found', `source ${input.sourceKey} declares no variant '${input.variantKey}'`);
  }

  // Every rule must land somewhere the output actually has. A correspondence to a field
  // nobody declared would count into nothing and look like a mapping that worked.
  const outFields = JSON.parse(output.fields_json) as Record<string, unknown>;
  const seen = new Set<string>();
  for (const rule of input.rules) {
    if (!(rule.to in outFields))
      throw substratError('validation_failed', `output '${input.outputKey}' has no field '${rule.to}'`);
    if (seen.has(rule.to))
      throw substratError('validation_failed', `two rules both write '${rule.to}'`);
    seen.add(rule.to);
  }

  const prior = ctx.sql.query<{ version: number }>(
    'SELECT MAX(version) AS version FROM tock_mappings WHERE source_key = ? AND variant_key = ? AND output_key = ?',
    [input.sourceKey, input.variantKey, input.outputKey],
  )[0];
  const version = (prior?.version ?? 0) + 1;
  const id = ulid();
  ctx.sql.exec(
    'INSERT INTO tock_mappings (id, source_key, variant_key, output_key, version, rules_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.sourceKey, input.variantKey, input.outputKey, version, JSON.stringify(input.rules), ctx.principal, ctx.now()],
  );
  const row = ctx.sql.query<MappingRow>('SELECT * FROM tock_mappings WHERE id = ?', [id])[0]!;
  ctx.emit({
    type: 'tock.mapping-saved',
    schemaVersion: 1,
    entity: sourceRef(row.source_key),
    piiClass: 'none',
    payload: { source_key: row.source_key, variant_key: row.variant_key, output_key: row.output_key, version: row.version },
  });
  return row;
};

const listMappingsOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/list-mappings']>,
  HandlerOutput<(typeof tockOperations)['tock/list-mappings']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead));
  return ctx.page<MappingRow>('mapping', { ...input, filters: { source_key: input.sourceKey } });
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

  if (input.variantKey !== ROOT) {
    const known = ctx.sql.query<{ key: string }>('SELECT key FROM tock_variants WHERE source_key = ? AND key = ?', [
      input.sourceKey,
      input.variantKey,
    ])[0];
    if (!known) throw substratError('not_found', `source ${input.sourceKey} declares no variant '${input.variantKey}'`);
  }

  /**
   * The cap is on the EFFECTIVE shape, not on this schema alone.
   *
   * A record's dimensions are the union along its path, so a root declaring one and a variant
   * declaring two is three — and checking only the file in front of you would accept that and
   * fail at count time, about a schema the person is not looking at.
   */
  const inherited = new Map<string, FieldDef>();
  for (const prefix of pathOf(input.variantKey)) {
    if (prefix === input.variantKey) continue;
    const row = ctx.sql.query<SchemaRow>(
      'SELECT * FROM tock_schemas WHERE source_key = ? AND variant_key = ? ORDER BY version DESC LIMIT 1',
      [input.sourceKey, prefix],
    )[0];
    if (row) for (const [n, f] of Object.entries(JSON.parse(row.fields_json) as FieldDefs)) inherited.set(n, f);
  }
  const effective = new Map(inherited);
  for (const [n, f] of Object.entries(input.fields)) effective.set(n, f);
  const dimensions = [...effective].filter(([, f]) => f.role === 'dimension');
  if (dimensions.length > MAX_GROUPING_DIMENSIONS)
    throw substratError(
      'validation_failed',
      `a record may carry at most ${MAX_GROUPING_DIMENSIONS} grouping dimensions; this one would carry ${dimensions.length} (${dimensions.map(([n]) => n).join(', ')}) once the envelope is included. The rollup holds two dimension slots, so a third could be stored and never grouped by.`,
    );
  /**
   * One measure, refused at save time for exactly the reason the dimension cap is.
   *
   * A rollup row holds a single `measure` and a single `unit`. Counting used to take
   * `.find()` over the declared fields and silently drop every measure after the first — a
   * schema that looked accepted, and a number that was quietly about one column while the
   * schema named two.
   */
  const measures = Object.entries(input.fields).filter(([, f]) => f.role === 'measure');
  if (measures.length > 1)
    throw substratError(
      'validation_failed',
      `a schema may declare at most 1 measure; this one declares ${measures.length} (${measures.map(([n]) => n).join(', ')}). A rollup row holds one measure and one unit, so a second could be declared and never counted.`,
    );
  for (const [name, f] of Object.entries(input.fields)) {
    // Against the EFFECTIVE shape, like the dimension cap above: a kind's label field
    // routinely lives in the envelope — that is what declaring the envelope once is for —
    // and resolving against this file alone refused a schema whose record does carry it.
    if (f.labelField && !effective.has(f.labelField))
      throw substratError(
        'validation_failed',
        `field '${name}' names a labelField '${f.labelField}' that is not a field of this schema or of the ones it inherits`,
      );
  }

  // Versions run per VARIANT: the envelope and a kind evolve at their own paces, and one
  // shared counter would make a change to either look like a change to both.
  const latest = ctx.sql.query<{ version: number }>(
    'SELECT MAX(version) AS version FROM tock_schemas WHERE source_key = ? AND variant_key = ?',
    [input.sourceKey, input.variantKey],
  )[0];
  const version = (latest?.version ?? 0) + 1;
  const id = ulid();
  ctx.sql.exec(
    'INSERT INTO tock_schemas (id, source_key, variant_key, version, fields_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, input.sourceKey, input.variantKey, version, JSON.stringify(input.fields), ctx.principal, ctx.now()],
  );
  ctx.link({ entityType: 'schema', entityId: id }, sourceRef(input.sourceKey));

  // The variant is NOT optional here: versions run per variant, so version 3 of
  // `track/scroll` and version 3 of the envelope are different rows. Reading back at the
  // default ROOT either threw `not_found` for a kind the envelope had not reached yet, or —
  // worse — returned the ENVELOPE's row of the same number, so the operation answered with
  // another schema's id and the event announced a save that did not happen.
  const row = schemaOrThrow(ctx, input.sourceKey, version, input.variantKey);
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
  // `variant_key` travels only when asked for, and `''` IS an ask — it names the envelope.
  // An absent one must not become `WHERE variant_key = ''`, which would answer every
  // question about a kind with the envelope's versions.
  return ctx.page<SchemaRow>('schema', {
    ...input,
    filters: {
      ...(input.variantKey === undefined ? {} : { variant_key: input.variantKey }),
      source_key: input.sourceKey,
    },
  });
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
       (id, source_key, schema_version, filename, byte_size, content_hash, format, delimiter,
        time_field, subject_field, status, period_from, period_to, row_count, rejected_count,
        received_at, received_by, counted_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, NULL, NULL, ?, ?, NULL)`,
    [
      id, input.sourceKey, input.filename, input.byteSize, input.contentHash,
      input.format, input.delimiter, input.timeField, input.subjectField,
      input.periodFrom, input.periodTo, now, ctx.principal,
    ],
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
      format: row.format,
      time_field: row.time_field,
      subject_field: row.subject_field,
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
  assertAllowed(await ctx.check(TOCK_PERM.runManage, runRef(input.runId)));
  const run = runOrThrow(ctx, input.runId);
  if (run.status !== 'received' && run.status !== 'profiled')
    throw substratError('conflict', `a ${run.status} run cannot be profiled`, { reason: 'wrong_state' });
  if (run.status === 'profiled')
    throw substratError('conflict', 'this run has already finished profiling', { reason: 'already_profiled' });

  // Read once per invocation rather than per record: a batch is thousands of records and the
  // declaration does not move underneath them, so one operation gets one consistent answer.
  const discriminators = discriminatorsOf(ctx, run.source_key);
  const variants = variantsOf(ctx, run.source_key);
  let written = 0;

  /**
   * Accumulated for the whole batch and written once per KIND PER FIELD, rather than per field.
   *
   * `types` is a SET, and that is the correction. The column used to be assigned by whichever
   * record reached the field first and never revisited: a field whose first value was null
   * stayed `unknown` however many integers followed it, and a field carrying both integers
   * and text reported only one of them — so `deviations`, whose entire job is to notice
   * exactly that disagreement, could not see it.
   */
  interface Observed {
    present: number;
    nulls: number;
    readonly types: Set<string>;
  }
  /** Keyed by `[kind, field]` through JSON, for the delimiter-free reason `history` gives. */
  const observed = new Map<string, Observed>();
  /** Per field per day: the window it was seen in, and how many of those carried a value. */
  interface Seen {
    first: string;
    last: string;
    n: number;
  }
  const history = new Map<string, Seen>();

  for (const record of input.batch) {
    const day = dayOf(record.occurredAt);
    const { secret } = saltFor(ctx, day);
    const key = await subjectKey(secret, record.subject);

    // Which kind this record is. `ROOT` when it matches none, which is a classification and
    // never a rejection — a producer shipping an undeclared kind must not cost the data.
    const kind = classify(discriminators, variants, record.fields);

    const dims: Record<string, string | null> = {};
    for (const [field, value] of Object.entries(record.fields)) {
      dims[field] = value;
      // The observed half. Counted per field whether or not any schema declares it — a field
      // nobody modelled is the finding, so refusing it here would destroy the evidence.
      const present = value === null ? 0 : 1;
      // Counted per KIND per field. As one number per field, "absent because this kind does
      // not carry it" and "absent because it went missing" were the same number — which is
      // the distinction variants exist to draw.
      const okey = JSON.stringify([kind, field]);
      const o = observed.get(okey) ?? { present: 0, nulls: 0, types: new Set<string>() };
      o.present += present;
      o.nulls += 1 - present;
      if (value !== null) o.types.add(inferType(value));
      observed.set(okey, o);

      // Kept longer than the rows it came from — that is the whole job, so it is written per
      // day rather than per run and never pruned with them.
      //
      // A tuple key through JSON rather than a joined string: a field name is a producer's
      // text and may contain anything at all, and `JSON.stringify` of an array of strings is
      // the one cheap encoding with no delimiter to collide with.
      const hkey = JSON.stringify([field, day]);
      const h = history.get(hkey);
      if (h === undefined) {
        history.set(hkey, { first: record.occurredAt, last: record.occurredAt, n: present });
      } else {
        // MIN/MAX rather than last-write-wins: a file is not obliged to be sorted, and one
        // record out of order used to drag `last_seen` backwards or leave `first_seen` late.
        if (record.occurredAt < h.first) h.first = record.occurredAt;
        if (record.occurredAt > h.last) h.last = record.occurredAt;
        h.n += present;
      }
    }

    ctx.sql.exec(
      'INSERT INTO tock_rows (id, run_id, variant_key, occurred_at, subject_key, dims_json, metrics_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ulid(), run.id, kind, record.occurredAt, key, JSON.stringify(dims), '{}'],
    );
    written += 1;
  }

  for (const [okey, o] of observed) {
    const [kind, field] = JSON.parse(okey) as [string, string];
    // Merged with whatever an earlier batch of this run recorded: a resumed delivery adds to
    // the counts and UNIONS the types. `declared` is left alone — it is nil until a schema is
    // chosen, and `map-run` is what decides it.
    const prior = ctx.sql.query<{ inferred_type: string }>(
      'SELECT inferred_type FROM tock_observations WHERE run_id = ? AND variant_key = ? AND field = ?',
      [run.id, kind, field],
    )[0];
    const merged = typeSet([...o.types, ...(prior?.inferred_type ?? '').split(',')]);
    ctx.sql.exec(
      `INSERT INTO tock_observations (id, run_id, variant_key, field, present_count, null_count, inferred_type, distinct_estimate, declared)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
         ON CONFLICT(run_id, variant_key, field) DO UPDATE SET
           present_count = present_count + excluded.present_count,
           null_count    = null_count + excluded.null_count,
           inferred_type = excluded.inferred_type`,
      [ulid(), run.id, kind, field, o.present, o.nulls, merged],
    );
  }

  // Field history stays keyed per SOURCE, not per kind, and that is deliberate: its job is
  // "when did this field first arrive here", which outlives both the runs and the variant set
  // a person happened to declare at the time. Per-kind history would answer a narrower
  // question and lose the one the back-fill affordance actually asks.
  for (const [hkey, h] of history) {
    const [field, day] = JSON.parse(hkey) as [string, string];
    ctx.sql.exec(
      `INSERT INTO tock_field_history (source_key, field, day, first_seen, last_seen, n)
           VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_key, field, day) DO UPDATE SET
           first_seen = MIN(first_seen, excluded.first_seen),
           last_seen  = MAX(last_seen, excluded.last_seen),
           n = n + excluded.n`,
      [run.source_key, field, day, h.first, h.last, h.n],
    );
  }

  const total = (run.row_count ?? 0) + written;
  ctx.sql.exec('UPDATE tock_runs SET row_count = ?, status = ? WHERE id = ?', [
    total,
    input.final ? 'profiled' : 'received',
    run.id,
  ]);

  const after = runOrThrow(ctx, run.id);
  const complete = Boolean(input.final);
  /**
   * EVERY batch, not only the last one.
   *
   * A non-final batch writes rows, observations, field history and the run's own count, and
   * it used to emit nothing — a mutation with no entry on the spine, which is the one thing
   * the event rule exists to prevent. `complete` is what a consumer reads to tell a batch
   * that finished profiling from one that merely advanced it; `status` says the same thing in
   * the run's own vocabulary.
   */
  ctx.emit({
    type: 'tock.run-profiled',
    schemaVersion: 1,
    entity: runRef(after.id),
    piiClass: 'none',
    payload: {
      id: after.id,
      source_key: after.source_key,
      row_count: after.row_count,
      status: after.status,
      complete,
    },
  });
  return { ...after, complete };
};

const mapRunOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/map-run']>,
  HandlerOutput<(typeof tockOperations)['tock/map-run']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.runManage, runRef(input.runId)));
  const run = runOrThrow(ctx, input.runId);
  if (run.status !== 'profiled')
    throw substratError(
      'conflict',
      `a ${run.status} run cannot be mapped — profiling is what puts the evidence on the table that mapping is a decision about`,
      { reason: 'wrong_state' },
    );
  const schema = schemaOrThrow(ctx, run.source_key, input.schemaVersion);

  /**
   * Which observed fields this schema accounts for.
   *
   * Profiling cannot know — no schema is chosen yet — so it writes every observation with
   * `declared = 0`, and mapping is the moment the answer exists. Nothing used to write it
   * afterwards, so the flag `list-observations` filters on said "undeclared" about every
   * field forever, including the ones the modeller had just declared. Set both ways rather
   * than only to 1: re-mapping onto a different version has to be able to take it back.
   */
  const declared = Object.keys(JSON.parse(schema.fields_json) as FieldDefs);
  ctx.sql.exec('UPDATE tock_observations SET declared = 0 WHERE run_id = ?', [run.id]);
  if (declared.length > 0)
    ctx.sql.exec(
      `UPDATE tock_observations SET declared = 1
        WHERE run_id = ? AND field IN (${declared.map(() => '?').join(', ')})`,
      [run.id, ...declared],
    );

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
  assertAllowed(await ctx.check(TOCK_PERM.runManage, runRef(input.runId)));
  const run = runOrThrow(ctx, input.runId);
  if (run.status !== 'mapped')
    throw substratError('conflict', `a ${run.status} run cannot be counted`, { reason: 'wrong_state' });

  /**
   * Counted against the ENVELOPE, whatever kinds the rows belong to.
   *
   * `schemaOrThrow` resolves the root, and that is the boundary of this slice rather than an
   * oversight: envelope fields are the ones every record carries, so a dimension declared
   * there means the same thing for a page and for a track event. A dimension declared on one
   * KIND cannot be counted yet — two kinds could each declare `country` and the rollup, which
   * has no variant column, would silently merge them.
   *
   * Counting per kind is what output schemas are for: the thing counted becomes the output
   * shape rather than the arriving one, which is also what stops a producer's rename from
   * breaking the numbers. Until then a variant's own fields are observed and declared, and
   * not yet rolled up.
   */
  const schema = schemaOrThrow(ctx, run.source_key, run.schema_version ?? 0);
  const fields: FieldDefs = JSON.parse(schema.fields_json) as FieldDefs;
  const dimensions = Object.entries(fields).filter(([, f]) => f.role === 'dimension').map(([n]) => n);
  const measure = Object.entries(fields).find(([, f]) => f.role === 'measure')?.[0];

  const rows = ctx.sql.query<RowRow>('SELECT * FROM tock_rows WHERE run_id = ? ORDER BY id', [run.id]);

  /**
   * The grouping sets the report serves: the total, each single dimension, and — when a
   * schema declares two — the pair.
   *
   * The pair used to be missing while `dimsOfSet` parsed `a+b` and the rollup held two slots
   * for it, so the one grouping those two slots exist FOR reported empty. Not the cartesian
   * product of grouping sets, which is a different and much larger idea: row count is the sum
   * over each grouping of its distinct tuples.
   *
   * A pair names its dimensions in the order the SCHEMA declares them. There is one such set
   * rather than two, so `country+episode_id` is not the same string as `episode_id+country`
   * and only the declared order has rows.
   */
  /**
   * The output shapes this run counts into, and how each kind reaches them.
   *
   * Mappings STACK along a record's path exactly as schemas do: the envelope maps the fields
   * every record carries, a kind maps its own, nearest wins. One mapping written once at the
   * root therefore serves every kind, and a kind says only what is different about it.
   */
  const outputs = ctx.sql.query<OutputSchemaRow>(
    `SELECT o.* FROM tock_output_schemas o
      WHERE o.source_key = ?
        AND o.version = (SELECT MAX(v.version) FROM tock_output_schemas v
                          WHERE v.source_key = o.source_key AND v.key = o.key)`,
    [run.source_key],
  );
  const mappings = ctx.sql.query<MappingRow>(
    `SELECT m.* FROM tock_mappings m
      WHERE m.source_key = ?
        AND m.version = (SELECT MAX(v.version) FROM tock_mappings v
                          WHERE v.source_key = m.source_key AND v.variant_key = m.variant_key
                            AND v.output_key = m.output_key)`,
    [run.source_key],
  );

  /** The rules reaching a record of this kind for this output: root first, nearest last. */
  const rulesFor = (outputKey: string, variantKey: string): MappingRule[] => {
    const byTo = new Map<string, MappingRule>();
    for (const prefix of pathOf(variantKey)) {
      const m = mappings.find((x) => x.output_key === outputKey && x.variant_key === prefix);
      if (!m) continue;
      for (const r of JSON.parse(m.rules_json) as MappingRule[]) byTo.set(r.to, r);
    }
    return [...byTo.values()];
  };

  /** The grouping sets one shape serves: the total, each dimension, and the pair when it has two. */
  const groupingsOf = (shape: FieldDefs) => {
    const dims = Object.entries(shape).filter(([, f]) => f.role === 'dimension').map(([n]) => n);
    return {
      dims,
      measure: Object.entries(shape).find(([, f]) => f.role === 'measure')?.[0],
      sets: [
        { dimSet: 'total', dims: [] as string[] },
        ...dims.map((d) => ({ dimSet: d, dims: [d] })),
        ...(dims.length === MAX_GROUPING_DIMENSIONS ? [{ dimSet: dims.join('+'), dims }] : []),
      ],
    };
  };

  /**
   * What this run counts into.
   *
   * With no output shapes declared it is the envelope under `output_key = ''` — byte for byte
   * what every run counted before outputs existed, which is what keeps a source that never
   * adopts them working exactly as it did.
   *
   * With outputs declared the envelope STAYS, and that is not a leftover. A record matching
   * no declared kind is counted under the envelope and never dropped — the deviations view
   * says so in as many words, and it is the promise that makes an undeclared kind cost
   * nothing. Replacing the envelope with the outputs quietly broke it in both directions:
   * with no root-level mapping the record fell out of counting altogether, and with one it
   * was counted INTO an output whose shape says nothing about it. So the envelope is a
   * target for the unmatched, and only for them — a matched kind that no output maps is a
   * different and ordinary answer, since an output shape describes some of a stream.
   */
  const envelopeTakesEverything = outputs.length === 0;
  const targets = [
    { key: ROOT, shape: fields },
    ...outputs.map((o) => ({ key: o.key, shape: JSON.parse(o.fields_json) as FieldDefs })),
  ];
  const plans = new Map(targets.map((t) => [t.key, { ...groupingsOf(t.shape), shape: t.shape }]));

  interface Cell {
    readonly outputKey: string;
    readonly grain: string;
    readonly dimSet: string;
    readonly periodStart: string;
    readonly dim1: string;
    readonly dim2: string;
    events: number;
    measure: string | null;
    unit: string | null;
  }
  const cells = new Map<string, Cell>();
  const labels = new Map<string, { dim: string; value: string; label: string }>();
  let rejected = 0;

  for (const row of rows) {
    const raw = JSON.parse(row.dims_json) as Record<string, string | null>;

    // Required-ness and labels are judged against what ARRIVED, not against an output: a field
    // the file was supposed to carry is a fact about the file.
    for (const [name, f] of Object.entries(fields)) {
      if (f.required && (raw[name] === undefined || raw[name] === null)) rejected += 1;
      if (f.role === 'dimension' && f.labelField) {
        const value = raw[name];
        const label = raw[f.labelField];
        // Captured per run, which is what makes "the title as it was" true a year later.
        if (value !== null && value !== undefined && label !== null && label !== undefined)
          labels.set(JSON.stringify([name, value]), { dim: name, value, label });
      }
    }

    for (const target of targets) {
      const plan = plans.get(target.key)!;
      let values = raw;
      if (target.key === ROOT) {
        // Once outputs exist the envelope holds the UNMATCHED only — see `targets`. Without
        // this the same record would be counted twice where a root mapping happened to reach
        // it: once under the envelope and once under the output.
        if (!envelopeTakesEverything && row.variant_key !== ROOT) continue;
      } else {
        const rules = rulesFor(target.key, row.variant_key);
        // No rule reaches this kind, so this record is simply not part of this output. That is
        // an ordinary answer — an output shape describes some of a stream, rarely all of it.
        if (rules.length === 0) continue;
        values = {};
        for (const rule of rules) values[rule.to] = raw[rule.from] ?? null;
      }
      const amount = plan.measure === undefined ? null : (values[plan.measure] ?? null);

      for (const grouping of plan.sets) {
        // An absent value is its own bucket, never folded into a fabricated one and never a
        // NULL, which inside this composite key would not compare equal to itself. Which of
        // the two absences this is — no such slot, or no value in it — is read off `dim_set`.
        const dim1 = grouping.dims[0] === undefined ? DIM_NONE : (values[grouping.dims[0]] ?? DIM_NONE);
        const dim2 = grouping.dims[1] === undefined ? DIM_NONE : (values[grouping.dims[1]] ?? DIM_NONE);
        for (const [grain, startOf] of GRAINS) {
          const periodStart = startOf(row.occurred_at);
          const key = JSON.stringify([target.key, grain, grouping.dimSet, periodStart, dim1, dim2]);
          const cell = cells.get(key) ?? {
            outputKey: target.key,
            grain,
            dimSet: grouping.dimSet,
            periodStart,
            dim1,
            dim2,
            events: 0,
            measure: null,
            unit: plan.measure ?? null,
          };
          cell.events += 1;
          // A missing amount stays null and is skipped, because a measure defaulted to zero is
          // invisible in a total and silently wrong.
          if (amount !== null) cell.measure = cell.measure === null ? amount : addDecimal(cell.measure, amount);
          cells.set(key, cell);
        }
      }
    }
  }

  /**
   * `events` counts ROWS, and that is a request count rather than a listener count.
   *
   * Two records with the same `subject_key` inside a day are two events here, deliberately:
   * the rollup declares one count column and has nowhere to put a second. `subject_key` and
   * the `dedup_window` rule kind are what a distinct-listener measure would be built FROM,
   * and building it means adding a column to an approved table — a concept decision, not
   * something counting should start doing quietly.
   */
  for (const cell of cells.values()) {
    ctx.sql.exec(
      `INSERT INTO tock_rollups
         (source_key, output_key, grain, dim_set, period_start, dim1, dim2, run_id, events, measure, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_key, output_key, grain, dim_set, period_start, dim1, dim2, run_id) DO UPDATE SET
         events = excluded.events, measure = excluded.measure`,
      [
        run.source_key, cell.outputKey, cell.grain, cell.dimSet, cell.periodStart,
        cell.dim1, cell.dim2, run.id, cell.events, cell.measure, cell.unit,
      ],
    );
  }

  for (const l of labels.values()) {
    ctx.sql.exec(
      `INSERT INTO tock_labels (run_id, dim, value, label, captured_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id, dim, value) DO UPDATE SET label = excluded.label`,
      [run.id, l.dim, l.value, l.label, ctx.now()],
    );
  }

  /**
   * What produced these numbers, by content identity rather than by name.
   *
   * The `salt` row names the daily salts the subject keys were actually hashed with — which
   * is the question section 7 asks it: a re-run of an old day can then say whether its
   * de-duplication is comparable to the original or merely looks like it. It used to record
   * the SCHEMA's id as the content hash, which answers a different question nobody asked, and
   * the salt ids profiling had in its hand were thrown away.
   *
   * A run may span days and the row is one per kind, so `identifier` names the days and the
   * hash covers their salt ids in order — a run using the same salts reproduces the hash, one
   * that had to mint a new salt for any day does not.
   */
  const days = ctx.sql.query<{ day: string }>(
    'SELECT DISTINCT substr(occurred_at, 1, 10) AS day FROM tock_rows WHERE run_id = ? ORDER BY day',
    [run.id],
  ).map((d) => d.day);
  const saltIds = days.map(
    (day) =>
      ctx.sql.query<{ salt_id: string }>('SELECT salt_id FROM tock_salts WHERE day = ?', [day])[0]?.salt_id ??
      // The salt was destroyed after this run was profiled: the subject keys stand, and what
      // is gone is the ability to reproduce them. Recorded as that rather than as a gap.
      `destroyed:${day}`,
  );
  const saltHash = hex(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(saltIds.join(','))),
  );
  /**
   * Which mapping made these numbers, captured beside the other rules.
   *
   * Without it a superseded run's figures are preserved and unaccountable: you can see the old
   * number and the new one and not say what changed between them. The identifier names every
   * mapping version in force, so a re-run under a corrected mapping is explainable rather than
   * merely different — which is the promise the reprocessing design made and could not keep
   * while nothing recorded a mapping at all.
   */
  if (mappings.length > 0) {
    const applied = mappings
      .map((m) => `${m.variant_key || 'envelope'}->${m.output_key}@v${m.version}`)
      .sort()
      .join(', ');
    ctx.sql.exec(
      `INSERT INTO tock_rule_states (id, run_id, rule_kind, identifier, content_hash, captured_at)
         VALUES (?, ?, 'mapping', ?, ?, ?)
       ON CONFLICT(run_id, rule_kind) DO UPDATE SET identifier = excluded.identifier`,
      [
        ulid(),
        run.id,
        applied,
        hex(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(applied))),
        ctx.now(),
      ],
    );
  }

  ctx.sql.exec(
    `INSERT INTO tock_rule_states (id, run_id, rule_kind, identifier, content_hash, captured_at)
       VALUES (?, ?, 'salt', ?, ?, ?)
     ON CONFLICT(run_id, rule_kind) DO UPDATE SET
       identifier = excluded.identifier, content_hash = excluded.content_hash`,
    [ulid(), run.id, days.length === 0 ? 'days:none' : `days:${days[0]}..${days[days.length - 1]}`, saltHash, ctx.now()],
  );

  /**
   * And the rules the caller applied before handing the records over.
   *
   * A bot list is applied upstream of Tock — section 10 keeps fetching and updating the lists
   * themselves out — so the run cannot derive which list it was. It can record what it was
   * told, which is what makes the concept's promise that a superseded run "still names the bot
   * list version it used" true rather than merely written down.
   */
  for (const rule of input.rules ?? []) {
    ctx.sql.exec(
      `INSERT INTO tock_rule_states (id, run_id, rule_kind, identifier, content_hash, captured_at)
         VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, rule_kind) DO UPDATE SET
         identifier = excluded.identifier, content_hash = excluded.content_hash`,
      [ulid(), run.id, rule.kind, rule.identifier, rule.contentHash, ctx.now()],
    );
  }

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
  assertAllowed(await ctx.check(TOCK_PERM.reportRead, runRef(input.runId)));
  return runOrThrow(ctx, input.runId);
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

const runRulesOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/run-rules']>,
  HandlerOutput<(typeof tockOperations)['tock/run-rules']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead, runRef(input.runId)));
  const run = runOrThrow(ctx, input.runId);
  // Ordered by kind so two runs' rule sets can be read side by side without sorting first,
  // which is the comparison this read exists for.
  return {
    entries: ctx.sql.query<RuleStateRow>(
      'SELECT * FROM tock_rule_states WHERE run_id = ? ORDER BY rule_kind',
      [run.id],
    ),
  };
};

const listObservationsOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/list-observations']>,
  HandlerOutput<(typeof tockOperations)['tock/list-observations']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead, runRef(input.runId)));
  const run = runOrThrow(ctx, input.runId);
  // `run_id` is supplied rather than read off the input, so a caller cannot widen the read to
  // another run — and it is spread LAST for that reason. The declared filter travels beside
  // it, stored as 0/1: only when asked for, since an absent one must not become a
  // `WHERE declared IS NULL` that quietly returns nothing.
  return ctx.page<ObservationRow>('observation', {
    ...input,
    filters: {
      ...(input.declared === undefined ? {} : { declared: input.declared ? 1 : 0 }),
      ...(input.variantKey === undefined ? {} : { variant_key: input.variantKey }),
      run_id: run.id,
    },
  });
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
    // Each observation's `inferred_type` is itself a comma-separated set, so GROUP_CONCAT
    // over runs can repeat a type. Deduped here rather than reported twice in one message.
    const types = [...new Set((o.types ?? '').split(','))].filter((t) => t && t !== TYPE_UNKNOWN);
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

  /**
   * Records that matched no declared kind.
   *
   * The counterpart of an undeclared FIELD, one level up, and reported the same way: the data
   * was kept and this says so. A stream whose producer ships a new event name shows up here
   * rather than as a number that quietly stopped adding up.
   */
  const unmatched = ctx.sql.query<{ n: number; runs: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT w.run_id) AS runs
       FROM tock_rows w JOIN tock_runs r ON r.id = w.run_id
      WHERE r.source_key = ? AND w.variant_key = ''`,
    [input.sourceKey],
  )[0];
  const declaredKinds = ctx.sql.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM tock_variants WHERE source_key = ?',
    [input.sourceKey],
  )[0];
  // Only a finding once kinds exist: with none declared, every row is unmatched by
  // construction and reporting it would be noise about a decision nobody has taken.
  if ((declaredKinds?.n ?? 0) > 0 && (unmatched?.n ?? 0) > 0) {
    const discriminators = discriminatorsOf(ctx, input.sourceKey);
    findings.push({
      kind: 'unmatched_records',
      field: discriminators.join(' / ') || '(no discriminators)',
      detail: `${unmatched!.n} record(s) across ${unmatched!.runs} run(s) matched no declared kind — kept and counted under the envelope, never dropped`,
      firstSeen: null,
      lastSeen: null,
      runs: unmatched!.runs,
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

/**
 * The truth about a field's history, for the screen that refuses to ask for a default.
 *
 * Every number here is counted rather than estimated, and `rowsBefore` is the one that
 * matters: records that already existed when the field did not. A default would fill those
 * with an invented value, and the argument against doing that is far easier to make with the
 * number on screen than in prose.
 */
const fieldCoverageOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/field-coverage']>,
  HandlerOutput<(typeof tockOperations)['tock/field-coverage']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.reportRead));
  sourceOrThrow(ctx, input.sourceKey);

  const seen = ctx.sql.query<{ first: string | null; last: string | null; n: number | null }>(
    'SELECT MIN(first_seen) AS first, MAX(last_seen) AS last, SUM(n) AS n FROM tock_field_history WHERE source_key = ? AND field = ?',
    [input.sourceKey, input.field],
  )[0];
  const earliest = ctx.sql.query<{ at: string | null }>(
    'SELECT MIN(w.occurred_at) AS at FROM tock_rows w JOIN tock_runs r ON r.id = w.run_id WHERE r.source_key = ?',
    [input.sourceKey],
  )[0];

  const firstSeen = seen?.first ?? null;
  // Rows OLDER than the field's first appearance. With no first appearance there is nothing
  // to be older than, and calling every row "before" would be a lie of a different kind.
  const before = firstSeen
    ? ctx.sql.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tock_rows w JOIN tock_runs r ON r.id = w.run_id
          WHERE r.source_key = ? AND w.occurred_at < ?`,
        [input.sourceKey, firstSeen],
      )[0]
    : undefined;
  const runsBefore = firstSeen
    ? ctx.sql.query<{ id: string; filename: string; period_from: string }>(
        `SELECT DISTINCT r.id, r.filename, r.period_from FROM tock_runs r
           JOIN tock_rows w ON w.run_id = r.id
          WHERE r.source_key = ? AND w.occurred_at < ?
          ORDER BY r.period_from`,
        [input.sourceKey, firstSeen],
      )
    : [];

  return {
    field: input.field,
    firstSeen,
    lastSeen: seen?.last ?? null,
    rowsWith: seen?.n ?? 0,
    rowsBefore: before?.n ?? 0,
    earliest: earliest?.at ?? null,
    runsBefore: runsBefore.map((r) => ({ id: r.id, filename: r.filename, periodFrom: r.period_from })),
  };
};

const listRowsOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/list-rows']>,
  HandlerOutput<(typeof tockOperations)['tock/list-rows']>
> = async (ctx, input) => {
  assertAllowed(await ctx.check(TOCK_PERM.rowRead, runRef(input.runId)));
  const run = runOrThrow(ctx, input.runId);
  return ctx.page<RowRow>('row', { ...input, filters: { run_id: run.id } });
};

const readSourceFileOp: OperationHandler<
  HandlerInput<(typeof tockOperations)['tock/read-source-file']>,
  HandlerOutput<(typeof tockOperations)['tock/read-source-file']>
> = async (ctx, input) => {
  // `row:read`, not `report:read` — the file IS raw rows, so guarding it with the reporting
  // permission would be a way around the whole permission table.
  assertAllowed(await ctx.check(TOCK_PERM.rowRead, runRef(input.runId)));
  const run = runOrThrow(ctx, input.runId);
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

  /**
   * The dimensions this grouping names, in slot order — `episode_id+country` is `dim1` then
   * `dim2`. The label join has to use THESE and not `dim_set` itself: on a pair the set is
   * `episode_id+country`, which is nothing any label row was captured under, so every label
   * on a two-dimension report came back null.
   */
  const dims = dimsOfSet(input.dimSet);

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
       LEFT JOIN tock_labels l1 ON l1.run_id = ro.run_id AND l1.dim = ? AND l1.value = ro.dim1
       LEFT JOIN tock_labels l2 ON l2.run_id = ro.run_id AND l2.dim = ? AND l2.value = ro.dim2
      WHERE ro.source_key = ? AND ro.output_key = ? AND ro.grain = ? AND ro.dim_set = ?
        AND ro.period_start >= ? AND ro.period_start < ?
        AND ro.run_id = (
              -- The run that is CURRENT for this bucket, as exactly one row.
              --
              -- This used to compare against MAX(counted_at), which is not a unique ordering
              -- token: two runs counted inside the same millisecond — which a frozen test
              -- clock guarantees, and a fast machine can produce for real — were both equal
              -- to the maximum, and the report returned the superseded number alongside the
              -- current one. Ordering and taking one row cannot tie. The id breaks a
              -- same-instant tie by receive order, ULIDs being chronological.
              SELECT ro2.run_id FROM tock_rollups ro2
                JOIN tock_runs r2 ON r2.id = ro2.run_id
               WHERE ro2.source_key = ro.source_key AND ro2.output_key = ro.output_key
                 AND ro2.grain = ro.grain
                 AND ro2.dim_set = ro.dim_set AND ro2.period_start = ro.period_start
               ORDER BY r2.counted_at DESC, r2.id DESC
               LIMIT 1
            )
      ORDER BY ro.period_start, ro.dim1, ro.dim2`,
    [dims[0] ?? '', dims[1] ?? '', input.sourceKey, input.outputKey, input.grain, input.dimSet, input.from, input.to],
  );

  // Unknown is an empty value in a slot the grouping USES; an empty value in a slot it does
  // not use is simply that slot being absent, and hiding those would hide every total.
  const used = dims.length;
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
  'tock/declare-variants': declareVariantsOp,
  'tock/save-output-schema': saveOutputSchemaOp,
  'tock/list-output-schemas': listOutputSchemasOp,
  'tock/save-mapping': saveMappingOp,
  'tock/list-mappings': listMappingsOp,
  'tock/list-variants': listVariantsOp,
  'tock/list-sources': listSourcesOp,
  'tock/save-schema': saveSchemaOp,
  'tock/list-schemas': listSchemasOp,
  'tock/receive-run': receiveRunOp,
  'tock/profile-run': profileRunOp,
  'tock/map-run': mapRunOp,
  'tock/count-run': countRunOp,
  'tock/get-run': getRunOp,
  'tock/list-runs': listRunsOp,
  'tock/run-rules': runRulesOp,
  'tock/list-observations': listObservationsOp,
  'tock/deviations': deviationsOp,
  'tock/field-history': fieldHistoryOp,
  'tock/field-coverage': fieldCoverageOp,
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
