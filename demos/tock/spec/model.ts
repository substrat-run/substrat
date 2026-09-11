/**
 * Tock's model — what exists, declared once.
 *
 * The concept is approved (`spec/concept.md`); this is its entity and operation
 * surface, and everything downstream derives from it: the migrations, the route
 * table, the permission registry, the API document.
 *
 * This vertical composes **no engine**, and section 3 of the concept says why rather
 * than leaving the absence to be read as an oversight: the nearest candidate is the
 * usage-metering engine, whose one-row-per-observation ledger is the wrong shape at
 * log volume and whose closed-period floor forbids exactly the re-run this app exists
 * to perform. An absent `engines` argument is a fact about the app.
 *
 * Two shapes here are load-bearing and easy to "tidy" into something wrong:
 *
 * 1. **A run carries no `superseded_by`.** A counted run is immutable, so it cannot
 *    hold a field a later run has to write. Which run is current for a period is
 *    derived — the latest counted one covering it.
 * 2. **A label is keyed by the run that captured it**, not by source with a timestamp.
 *    A rollup row already names its run, so an old report joins to the labels that run
 *    captured and shows the title as it was.
 */
import { defineEntities, defineOperations, emitModel, z } from '@substrat-run/contracts';

/** The lifecycle, in one place. `failed` is reachable from any of the first three. */
export const RUN_STATUSES = ['received', 'profiled', 'mapped', 'counted', 'failed'] as const;

/**
 * What a captured rule is. `salt` is here because a re-run's de-duplication is only
 * comparable to the original if it used the same salt, and that is a fact about the run.
 */
export const RULE_KINDS = ['bot_list', 'threshold', 'dedup_window', 'salt', 'mapping'] as const;

/**
 * Two dimension slots, and the schema editor refuses a third (concept section 7). A limit
 * that is declared is a save-time refusal naming the reason; one that is merely true is a
 * grouping that silently does nothing.
 */
export const MAX_GROUPING_DIMENSIONS = 2;

/**
 * The cap on one field-history read. Bounded by fields times days, so it grows slowly and
 * predictably — but it does grow, and an unbounded read of it would be a screen that gets
 * slower every day nobody notices.
 */
export const FIELD_HISTORY_MAX = 500;

/**
 * `dim1`/`dim2` are never null, because a NULL inside a composite primary key does not compare
 * equal to itself in SQLite and the rollup's uniqueness would quietly stop holding. So an
 * absent value is the empty string — and there is exactly ONE token rather than two, because
 * `dim_set` already says which slots a grouping uses.
 *
 * A slot the grouping does not use is empty. A slot it DOES use, holding empty, is a value the
 * source row did not have — the unknown bucket a report hides by default and reveals on ask.
 * Position disambiguates them, so nothing has to be encoded into the value itself.
 *
 * The first attempt did encode it, as a reserved token beginning with NUL. SQLite terminates a
 * TEXT value at a NUL byte, so it was stored as the empty string and the unknown bucket came
 * back indistinguishable from an unused slot. A sentinel that the database can silently
 * rewrite is not a sentinel.
 */
export const DIM_NONE = '';

/** The dimensions a grouping names, in slot order. `total` names none. */
export function dimsOfSet(dimSet: string): string[] {
  return dimSet === 'total' ? [] : dimSet.split('+');
}

export const tockEntities = defineEntities({
  /**
   * A named stream of files. Keyed by `key` rather than a ULID for the reason a meter is:
   * `fjord-cdn` is the same source every time it is referred to, and a run naming it should
   * not have to resolve an id first.
   */
  source: {
    table: 'tock_sources',
    fields: z.object({
      key: z.string(),
      title: z.string(),
      expected_cadence: z.string(),
      /**
       * The ordered field paths whose values tell record kinds apart, as JSON — `["type",
       * "event"]` for a stream that splits twice, `[]` for one that holds a single shape.
       *
       * Null is the older fact: this source predates variants. It is read as `[]`, so a
       * stream declared before any of this existed keeps behaving exactly as it did.
       */
      discriminators: z.string().nullable(),
      created_at: z.string(),
    }),
    primaryKey: ['key'],
  },

  /**
   * One record kind — a PREFIX of the source's discriminator values.
   *
   * `selector` is the ordered list, as JSON: `["page"]` stops at one level because a page
   * record carries no `event`; `["track","scroll"]` goes to two. A record belongs to the
   * LONGEST variant whose values all hold, which is why a prefix and not a full tuple: the
   * levels a kind does not reach are absent rather than null.
   *
   * A source with no discriminators has exactly one variant with an empty selector, so a
   * single-shape stream is the simple case rather than a special case.
   *
   * Keyed by `(source_key, key)` with a ULID id so it stays pointable — the variant is what
   * a schema, an observation and a row all name.
   */
  variant: {
    table: 'tock_variants',
    fields: z.object({
      id: z.string(),
      source_key: z.string(),
      /** Readable and stable: `track/scroll`, derived from the selector when declared. */
      key: z.string(),
      selector: z.string(),
      created_at: z.string(),
    }),
    parents: ['source'],
    key: ['source_key', 'key'],
  },

  /**
   * One **version** of a source's declared shape. Saving never edits a version; it writes
   * the next one, which is what makes "which shape was this run counted under" answerable.
   * `fields_json` holds, per field: its type, whether it is a dimension, a measure or
   * ignored, and whether it is required.
   *
   * It carries a ULID `id` as well as the natural key so it stays pointable — a
   * composite-keyed entity cannot be the subject of an event, and `tock.schema-saved` is one.
   */
  schema: {
    table: 'tock_schemas',
    fields: z.object({
      id: z.string(),
      source_key: z.string(),
      /**
       * Which kind this shape describes. The EMPTY STRING is the envelope every record
       * carries, and it is a real value rather than a null: a source always has a root
       * schema, even when it has no variants at all.
       *
       * A record's effective shape is the union along its path — envelope, then its kind,
       * then its sub-kind. Declaring the envelope once is the point; fourteen variants
       * repeating sixteen identical fields would be fourteen places for them to drift.
       */
      variant_key: z.string(),
      version: z.number(),
      fields_json: z.string(),
      created_by: z.string(),
      created_at: z.string(),
    }),
    parents: ['source'],
    key: ['source_key', 'variant_key', 'version'],
  },

  /**
   * One delivered file taken through the lifecycle. `id` is what "which run produced this
   * number" points at.
   *
   * `schema_version` is null until the run is mapped and `counted_at` until it is counted —
   * both are the honest absence, not a default. There is deliberately no `superseded_by`;
   * see the header.
   */
  run: {
    table: 'tock_runs',
    fields: z.object({
      id: z.string(),
      source_key: z.string(),
      schema_version: z.number().nullable(),
      filename: z.string(),
      byte_size: z.number(),
      content_hash: z.string(),
      /**
       * How this file was read, and which of its columns carry the two structural facts.
       *
       * They are on the RUN rather than in the schema, and the lifecycle is why. Profiling
       * comes before mapping — mapping an unread file is guessing with the evidence unread —
       * and profiling already needs the instant, to derive the period and to reach the day's
       * salt. A time column declared in the schema would therefore have to be read before the
       * schema was chosen, which inverts the order the whole design rests on.
       *
       * So: structural mapping travels with the file, decided when it is sent and informed by
       * the preview. Meaning-mapping — dimension, measure, ignored — stays in the schema.
       *
       * `subject_field` is nullable and that is a real option, not an omission: a file with
       * nothing to de-duplicate on is legitimate, and the honest consequence is that every
       * row counts once. A run says which it was rather than leaving a reader to infer it.
       *
       * **A null `format` is the older fact: this run predates the mapping being recorded.**
       * SQLite cannot add a required column to a table that may hold rows, and the choice
       * offered — nullable, or a default — is not a tie. A default would make every earlier
       * run claim a mapping nobody chose, indistinguishable from one that was. Null says what
       * is true, exactly as a null `authorization` does on the spine, and it disambiguates the
       * whole group: the host reads a null `format` as the plan the old code hardcoded, so
       * `subject_field` null keeps meaning "no subject" for every run that recorded one.
       */
      format: z.enum(['csv', 'jsonl']).nullable(),
      delimiter: z.string().nullable(),
      time_field: z.string().nullable(),
      subject_field: z.string().nullable(),
      status: z.enum(RUN_STATUSES),
      period_from: z.string(),
      period_to: z.string(),
      row_count: z.number().nullable(),
      rejected_count: z.number().nullable(),
      received_at: z.string(),
      received_by: z.string(),
      counted_at: z.string().nullable(),
    }),
    parents: ['source'],
  },

  /**
   * The delivered bytes. One per run, so the run's id is the key.
   *
   * This table is why `row:read` covers more than `tock_rows`: the file IS raw rows, and a
   * source file anyone could download would be a way around the whole of section 4.
   */
  source_file: {
    table: 'tock_source_files',
    fields: z.object({
      run_id: z.string(),
      content_hash: z.string(),
      byte_size: z.number(),
      storage_key: z.string(),
      stored_at: z.string(),
      purge_after: z.string(),
    }),
    primaryKey: ['run_id'],
    parents: ['run'],
  },

  /**
   * The rules in force when a run was counted.
   *
   * `content_hash` is the field that actually holds. A bot list called `2026-03` can be
   * edited upstream without its name changing, so `identifier` records which list we *meant*
   * and the hash records which rules we *applied*. A re-run that reproduces the hash
   * reproduces the numbers; one that cannot is telling you something true.
   */
  rule_state: {
    table: 'tock_rule_states',
    fields: z.object({
      id: z.string(),
      run_id: z.string(),
      rule_kind: z.enum(RULE_KINDS),
      identifier: z.string(),
      content_hash: z.string(),
      captured_at: z.string(),
    }),
    parents: ['run'],
    key: ['run_id', 'rule_kind'],
  },

  /**
   * The day's salt behind every `subject_key`.
   *
   * Destroying `secret` is the erasure section 9 leans on: the subject keys of that day stop
   * being linkable to anyone, us included. `destroyed_at` is the tombstone, and the row
   * survives it so a re-run can tell "the salt is gone" from "there was never one".
   *
   * `secret` must never reach an event payload. Nothing below carries it, and nothing should:
   * a salt in the outbox would undo every erasure that ever ran.
   */
  salt: {
    table: 'tock_salts',
    fields: z.object({
      day: z.string(),
      salt_id: z.string(),
      secret: z.string().nullable(),
      created_at: z.string(),
      destroyed_at: z.string().nullable(),
    }),
    primaryKey: ['day'],
  },

  /**
   * What actually arrived, per run per field — recorded whether or not the field is declared.
   * The undeclared ones are the point: a field nobody modelled is a finding, not an error.
   */
  observation: {
    table: 'tock_observations',
    fields: z.object({
      id: z.string(),
      run_id: z.string(),
      /** Which kind these counts are for. Empty string = records that matched no variant. */
      variant_key: z.string(),
      field: z.string(),
      present_count: z.number(),
      null_count: z.number(),
      inferred_type: z.string(),
      distinct_estimate: z.number(),
      declared: z.number(),
    }),
    parents: ['run'],
    key: ['run_id', 'variant_key', 'field'],
  },

  /**
   * The same facts rolled up per source and kept **longer than the runs themselves** — its
   * entire job is to answer questions about March after March's rows are gone, which it
   * cannot do if it expires with them.
   *
   * Field names and counts only, never sample values: a sample column is extremely useful
   * while someone is identifying an unknown field and extremely uncomfortable when it turns
   * out to hold email addresses from data deleted two years ago.
   *
   * Composite-keyed, so it is not pointable — nothing refers to one of these rows, and an
   * `EntityRef` to one day of one field's history would name nothing anyone means.
   */
  field_history: {
    table: 'tock_field_history',
    fields: z.object({
      source_key: z.string(),
      field: z.string(),
      day: z.string(),
      first_seen: z.string(),
      last_seen: z.string(),
      n: z.number(),
    }),
    primaryKey: ['source_key', 'field', 'day'],
  },

  /**
   * The mapped rows a run produced — the personal-data table, and the one `row:read` guards.
   *
   * `subject_key` is the day-salted hash, never a raw identifier. It is `erasable`, which
   * besides making it redactable also makes it **uncarryable by any event** — the property
   * that matters more here, since the outbox is the copy we cannot rewrite.
   */
  row: {
    table: 'tock_rows',
    fields: z.object({
      id: z.string(),
      run_id: z.string(),
      /**
       * The variant this record matched, or the empty string when it matched none.
       *
       * Unmatched is a CLASSIFICATION, never a rejection: a producer shipping a kind nobody
       * declared must not cost the data. The findings view reports the value and the count,
       * and a person decides whether it is a variant worth declaring.
       */
      variant_key: z.string(),
      occurred_at: z.string(),
      subject_key: z.string(),
      dims_json: z.string(),
      metrics_json: z.string(),
    }),
    parents: ['run'],
    erasable: ['subject_key'],
  },

  /**
   * The counts.
   *
   * **`source_key` is in the key, and that is correctness rather than convenience.** Without
   * it two sources sharing a grain, grouping, dimension pair and period collide on the
   * primary key and one silently overwrites the other. It is also the report's own first
   * filter, so its absence would have made every report join back through the runs table to
   * find out which source a count belonged to.
   *
   * **`period_start` sits ahead of the dimensions**, which is the opposite of how the columns
   * read. The report asks for one source, one grain, one grouping and a *date range* across
   * whatever dimension values exist — so the range has to be a key prefix. With the
   * dimensions ahead of it the range is not a prefix at all and the read degrades to a scan
   * of the whole grouping. The key order follows the query, not the sentence.
   *
   * **`run_id` is the last key column, and leaving it out was a bug that defeated the whole
   * design.** As a plain column, a corrected run's UPSERT overwrites the run it displaces and
   * the earlier number is *gone* — while the concept promises the first run stays readable
   * and still shows what it originally reported. In the key, both runs keep their rows; which
   * one is current is still derived from the runs table, and the report resolves that first
   * and filters. Last rather than earlier so the date range stays a prefix.
   *
   * `period_start` is **ISO-8601 text like every other instant here**, not an epoch integer.
   * A fixed-width ISO string sorts lexicographically in chronological order, so the range
   * scan is unaffected, and the alternative would have put two representations of time in one
   * reporting API beside this model's own `period_from`/`period_to`. It is named `_start`
   * rather than `_ts` because `_ts` reads as a number and would invite the next person to
   * treat it as one.
   *
   * `measure` is nullable and never zero when absent: a missing amount that becomes 0 is
   * invisible in a sum and silently wrong, while a null is skipped by SUM, which is correct.
   */
  /**
   * A stable shape counts are built over, and the thing that reaches a long-term store.
   *
   * Variants describe what ARRIVES, and what arrives drifts — a producer renames a field,
   * splits one event into two. Counting over variants directly would make every such change
   * a break in the numbers, which is the opposite of what a durable archive is for. So the
   * shape counted is declared separately and a mapping absorbs the movement between them.
   *
   * Versioned and **additive only**, by the same rule the rest of this design runs on: a
   * field never changes meaning, because a field that does turns every historical number
   * into a silent lie.
   */
  output_schema: {
    table: 'tock_output_schemas',
    fields: z.object({
      id: z.string(),
      source_key: z.string(),
      key: z.string(),
      version: z.number(),
      fields_json: z.string(),
      created_by: z.string(),
      created_at: z.string(),
    }),
    parents: ['source'],
    key: ['source_key', 'key', 'version'],
  },

  /**
   * How one kind becomes one output shape.
   *
   * `rules_json` is a list of correspondences — a source field, an output field, and nothing
   * else. **It holds no expressions, and that is the design rather than a limitation.** Every
   * rule is a datum a person can read in a table and check against the file; admit arithmetic
   * and there is a programming language inside a schema editor, untested against anything but
   * itself. A value that needs computing belongs in the producer, where it can be tested.
   *
   * Versioned, and which version a run used is captured beside its other rules — so a
   * corrected number is explained by the mapping that made it and not merely by its file.
   */
  mapping: {
    table: 'tock_mappings',
    fields: z.object({
      id: z.string(),
      source_key: z.string(),
      /** The kind this reads. Empty string maps every record the envelope describes. */
      variant_key: z.string(),
      output_key: z.string(),
      version: z.number(),
      rules_json: z.string(),
      created_by: z.string(),
      created_at: z.string(),
    }),
    parents: ['source'],
    key: ['source_key', 'variant_key', 'output_key', 'version'],
  },

  rollup: {
    table: 'tock_rollups',
    fields: z.object({
      source_key: z.string(),
      /**
       * Which output shape these counts belong to. Empty string is the older fact: counted
       * before outputs existed, against the envelope directly.
       *
       * In the key because two outputs can legitimately share a grain, a grouping and a
       * period — `engagement` and `commerce` both counted by country on the same day — and
       * without it one would overwrite the other.
       */
      output_key: z.string(),
      grain: z.string(),
      dim_set: z.string(),
      period_start: z.string(),
      dim1: z.string(),
      dim2: z.string(),
      run_id: z.string(),
      events: z.number(),
      measure: z.string().nullable(),
      unit: z.string().nullable(),
    }),
    primaryKey: ['source_key', 'output_key', 'grain', 'dim_set', 'period_start', 'dim1', 'dim2', 'run_id'],
  },

  /**
   * The display name for a dimension value, pinned to the run that captured it.
   *
   * The report promises "Episode 114 — Harbour Lights" and ids are opaque, so that string
   * needs a source table. `run_id` in the key is what makes the promise true: keyed by source
   * and disambiguated by timestamp, an old report would quietly pick up a later rename — the
   * exact failure this table exists to prevent.
   */
  label: {
    table: 'tock_labels',
    fields: z.object({
      run_id: z.string(),
      dim: z.string(),
      value: z.string(),
      label: z.string(),
      captured_at: z.string(),
    }),
    primaryKey: ['run_id', 'dim', 'value'],
  },
});

/**
 * Four keys, and the splits are section 4 exactly.
 *
 * - `report:read` is the counts, the schemas, the runs and the findings — held by everyone,
 *   because a report nobody can open is not a report.
 * - `row:read` is the raw rows **and the source file**, which are the same data in two
 *   shapes. This is the line a viewer does not cross: the rows carry a pseudonymous subject
 *   key and the source bytes carry the addresses it was derived from.
 * - `run:manage` is the whole lifecycle — upload, profile, map, count — and re-running a
 *   corrected period is the same key again, because a correction is an ordinary run.
 *   Splitting it would imply a two-person review step, and there isn't one.
 * - `schema:manage` is writing a schema version. Mapping a run *selects* one; only this
 *   writes one.
 *
 * "Manage people" from section 4's matrix is deliberately **not** here: membership is the
 * platform's invite surface, not an operation of this vertical, and a permission key no
 * operation checks would be a claim the registry cannot back.
 */
export const TOCK_PERMISSIONS = ['report:read', 'row:read', 'run:manage', 'schema:manage'] as const;

export const tockOperations = defineOperations(tockEntities, TOCK_PERMISSIONS)({
  'tock/declare-source': {
    summary: 'Declare a named stream of files',
    permission: 'schema:manage',
    input: z.object({
      key: z.string().regex(/^[a-z][a-z0-9-]*$/, 'a source key is lower-kebab, starting with a letter'),
      title: z.string().min(1),
      expectedCadence: z.string().min(1),
    }),
    output: tockEntities.source.fields,
    http: { method: 'POST', path: '/sources' },
    emits: {
      entity: 'source',
      entityIdFrom: 'key',
      type: 'tock.source-declared',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['key', 'title', 'expected_cadence'],
    },
  },

  /**
   * Declare which fields tell record kinds apart, and the kinds themselves.
   *
   * Both in one act because they are one decision: a discriminator with no variants
   * classifies nothing, and a variant whose selector names an undeclared discriminator is
   * meaningless. Saving replaces the set — a source has one answer to "what kinds are
   * these", not a version history of it, because a variant that stopped existing would
   * leave rows pointing at a kind no longer declared.
   *
   * Refused once a run has been counted: variants decide how rows were classified, so
   * changing them after the fact would make a counted run's classification unreproducible
   * while its numbers still claimed to be current.
   */
  'tock/declare-variants': {
    summary: 'Declare the fields that tell record kinds apart, and the kinds',
    permission: 'schema:manage',
    input: z.object({
      sourceKey: z.string(),
      /** Ordered. `["type","event"]` splits twice; `[]` is a stream of one shape. */
      discriminators: z.array(z.string().min(1)).max(4),
      /**
       * Each selector is a PREFIX of the discriminator values, shortest first.
       *
       * A component may carry no `/` and may not be empty, because the selector is joined
       * with `/` into the variant key and that key is then read back as a PATH — every
       * prefix of it is a schema level a record inherits from. A value like `ui/click`
       * would make a one-level kind look two levels deep and inherit from a `ui` nobody
       * declared; an empty value would join to `''`, which IS the envelope's key, making
       * the kind indistinguishable from an unclassified record. Refused here, where the
       * person can fix it, rather than silently mis-shaping every row of that kind.
       */
      variants: z.array(
        z.object({
          selector: z
            .array(
              z
                .string()
                .min(1, 'a selector value may not be empty')
                .refine((v) => !v.includes('/'), 'a selector value may not contain "/"'),
            )
            .min(1),
        }),
      ),
    }),
    output: z.object({
      sourceKey: z.string(),
      discriminators: z.array(z.string()),
      variants: z.array(tockEntities.variant.fields),
    }),
    http: { method: 'POST', path: '/sources/{sourceKey}/variants' },
    emits: {
      entity: 'source',
      entityIdFrom: 'sourceKey',
      type: 'tock.variants-declared',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['sourceKey'],
    },
  },

  'tock/list-variants': {
    summary: 'The record kinds declared for a source',
    permission: 'report:read',
    input: z.object({ sourceKey: z.string() }),
    output: z.object({
      discriminators: z.array(z.string()),
      variants: z.array(tockEntities.variant.fields),
    }),
    http: { method: 'GET', path: '/sources/{sourceKey}/variants' },
  },

  'tock/list-sources': {
    summary: 'The sources in this workspace',
    permission: 'report:read',
    output: tockEntities.source.fields,
    paged: { over: { entity: 'source', sortable: ['created_at', 'key'] } },
    http: { method: 'GET', path: '/sources' },
  },

  /**
   * Save a schema version. Never edits one — every save writes `version + 1`, so a run
   * counted under version 2 stays explainable after version 3 exists.
   *
   * The declared-dimension cap is enforced here at save time rather than discovered at count
   * time: a schema naming a third grouping dimension is refused with that reason.
   */
  'tock/save-schema': {
    summary: 'Save the next version of a source shape',
    permission: 'schema:manage',
    input: z.object({
      sourceKey: z.string(),
      /**
       * Which kind this shape describes. Omitted means the ENVELOPE — the fields every
       * record carries, whatever its kind. That default is what keeps a single-shape
       * source unchanged by any of this.
       */
      variantKey: z.string().default(''),
      fields: z.record(
        /**
         * A field name is whatever the FILE called the column, and almost nothing is refused.
         *
         * This used to demand lower-camel or snake, which is a shape only a file written for
         * this app would have. A real export arrives with `Joined on`, and a flattened JSON
         * path arrives as `customer.billing.city` — both were rejected, so a schema could not
         * be written for either. Constraining the name was the same assumption the reader used
         * to make about `occurred_at`: that the file would be shaped to suit us.
         *
         * What is still refused is a name that could not have come from a column — empty,
         * absurdly long, or carrying control characters that would make a rendered table lie
         * about what it contains.
         */
        z
          .string()
          .min(1)
          .max(200)
          // eslint-disable-next-line no-control-regex
          .refine((n) => !/[\u0000-\u001f\u007f]/.test(n), 'a field name may not contain control characters'),
        z.object({
          type: z.enum(['text', 'int', 'decimal', 'timestamp', 'bool']),
          role: z.enum(['dimension', 'measure', 'ignored']),
          required: z.boolean().optional(),
          /**
           * For a dimension: another field carrying its human-readable name.
           *
           * `episode_id` groups the counts and `episode_title` is what a person reads. The
           * label is captured per run at count time, which is what makes an old report show
           * the title as it was rather than as it has since been renamed — and it is the
           * only thing that writes `tock_labels`, so without this a dimension shows its
           * raw value and nothing is lost but legibility.
           */
          labelField: z.string().optional(),
        }),
      ),
    }),
    output: tockEntities.schema.fields,
    http: { method: 'POST', path: '/sources/{sourceKey}/schemas' },
    emits: {
      entity: 'schema',
      entityIdFrom: 'id',
      type: 'tock.schema-saved',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'source_key', 'version'],
    },
  },

  /**
   * Declare a stable shape counts are built over.
   *
   * Versioned like an input schema and **additive only**: a later version may add fields and
   * may not remove or repurpose one, because a field that changes meaning turns every number
   * already counted under it into a silent lie. The refusal is at save time, naming the field.
   */
  'tock/save-output-schema': {
    summary: 'Declare a stable shape that counts are built over',
    permission: 'schema:manage',
    input: z.object({
      sourceKey: z.string(),
      key: z.string().regex(/^[a-z][a-z0-9-]*$/, 'an output key is lower-kebab, starting with a letter'),
      fields: z.record(
        z.string().min(1).max(200),
        z.object({
          type: z.enum(['text', 'int', 'decimal', 'timestamp', 'bool']),
          role: z.enum(['dimension', 'measure', 'ignored']),
        }),
      ),
    }),
    output: tockEntities.output_schema.fields,
    http: { method: 'POST', path: '/sources/{sourceKey}/outputs' },
    emits: {
      entity: 'source',
      entityIdFrom: 'source_key',
      type: 'tock.output-schema-saved',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['source_key', 'key', 'version'],
    },
  },

  'tock/list-output-schemas': {
    summary: 'The stable shapes declared for a source',
    permission: 'report:read',
    input: z.object({ sourceKey: z.string() }),
    output: tockEntities.output_schema.fields,
    paged: { over: { entity: 'output_schema', sortable: ['key', 'version'], filterable: ['source_key', 'key'] } },
    http: { method: 'GET', path: '/sources/{sourceKey}/outputs' },
  },

  /**
   * Map one kind into one output shape.
   *
   * Rules are **correspondences and nothing else** — a field over here is a field over there.
   * No arithmetic, no conditionals, no reference to a second field. That bound is what keeps
   * the mapping a table a reviewer can check against the file, and it is why a value that
   * needs computing belongs in the producer where it can be tested.
   *
   * Two kinds may map to the same output, which is the point: the collapse that makes eleven
   * arriving event names into the handful of things anyone counts.
   */
  'tock/save-mapping': {
    summary: 'Map one record kind into one output shape',
    permission: 'schema:manage',
    input: z.object({
      sourceKey: z.string(),
      variantKey: z.string().default(''),
      outputKey: z.string(),
      rules: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })),
    }),
    output: tockEntities.mapping.fields,
    http: { method: 'POST', path: '/sources/{sourceKey}/mappings' },
    emits: {
      entity: 'source',
      entityIdFrom: 'source_key',
      type: 'tock.mapping-saved',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['source_key', 'variant_key', 'output_key', 'version'],
    },
  },

  'tock/list-mappings': {
    summary: 'How each kind becomes an output shape',
    permission: 'report:read',
    input: z.object({ sourceKey: z.string() }),
    output: tockEntities.mapping.fields,
    paged: { over: { entity: 'mapping', sortable: ['variant_key', 'output_key', 'version'], filterable: ['source_key'] } },
    http: { method: 'GET', path: '/sources/{sourceKey}/mappings' },
  },

  'tock/list-schemas': {
    summary: 'Every version of a source shape',
    permission: 'report:read',
    input: z.object({ sourceKey: z.string(), variantKey: z.string().optional() }),
    output: tockEntities.schema.fields,
    paged: { over: { entity: 'schema', sortable: ['version'], filterable: ['source_key', 'variant_key'] } },
    http: { method: 'GET', path: '/sources/{sourceKey}/schemas' },
  },

  /**
   * Record a delivered file. The bytes are already stored by the host before this runs —
   * module code cannot touch a blob binding — so what crosses the boundary is the identity
   * of what was stored, and `content_hash` is what every later step re-derives against.
   */
  'tock/receive-run': {
    summary: 'Record a delivered file and open a run over it',
    permission: 'run:manage',
    input: z.object({
      sourceKey: z.string(),
      filename: z.string().min(1),
      byteSize: z.number().int().positive(),
      /** How the host read it, and which columns carry the instant and the subject. */
      format: z.enum(['csv', 'jsonl']),
      /** The character between CSV cells. Null for `jsonl`, which has none. */
      delimiter: z.string().min(1).max(1).nullable(),
      timeField: z.string().min(1),
      subjectField: z.string().min(1).nullable(),
      /**
       * Both are shape-constrained, and it is a security boundary rather than tidiness.
       *
       * A caller supplies these and the host later turns one of them into a FILE PATH. Left
       * as free strings, a caller holding `run:manage` could record `../../../etc/passwd`
       * and have the profile route read it. The host checks containment too — defence at the
       * point of use — but refusing the shape here means the bad value never reaches a row.
       */
      /**
       * Deliberately NOT format-constrained, unlike `storageKey` below.
       *
       * It is compared and never resolved — nothing turns it into a path or a query — so a
       * regex here would defend against nothing while making test fixtures unreadable and
       * pinning the module to one digest algorithm it has no reason to care about. The
       * module never sees the bytes, so it could not verify the digest anyway; what it can
       * do is refuse a value that would be DANGEROUS, and this one cannot be.
       */
      contentHash: z.string().min(1),
      /**
       * A RELATIVE path with no way out of wherever the host keeps its files.
       *
       * A caller supplies this and the host later joins it to a directory, so left free a
       * caller holding `run:manage` could record `../../../etc/passwd` and have the profile
       * route read it. What is refused here is the dangerous SHAPE — an absolute path, an
       * empty segment, a `..` — and not a particular layout: the module has no business
       * knowing whether the host names blobs `files/sha256-…` or an R2 object key, and a
       * regex encoding one host's scheme would be this layer asserting a fact about another.
       *
       * The host checks containment again at the point of use. Neither check makes the other
       * redundant: this one keeps a bad value out of the row, that one assumes the row may
       * already hold one.
       */
      storageKey: z
        .string()
        .min(1)
        .max(512)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'a storage key is a relative path')
        .refine(
          (k) => !k.split('/').some((seg) => seg === '..' || seg === ''),
          'a storage key may not contain an empty or ".." segment',
        ),
      periodFrom: z.string(),
      periodTo: z.string(),
    }),
    output: tockEntities.run.fields,
    http: { method: 'POST', path: '/sources/{sourceKey}/runs' },
    emits: {
      entity: 'run',
      entityIdFrom: 'id',
      type: 'tock.run-received',
      schemaVersion: 1,
      piiClass: 'none',
      payload: [
        'id', 'source_key', 'filename', 'byte_size', 'content_hash',
        'period_from', 'period_to', 'format', 'time_field', 'subject_field',
      ],
    },
  },

  /**
   * Record what a batch of the delivered file actually contained.
   *
   * **This operation carries no `http`, and that absence is the trust boundary.** The bytes
   * live in a blob store, which module code cannot reach — capabilities come from `ctx`, and
   * `ctx` has no blob. So the host reads the file and hands the parsed records in. If that
   * same operation were mounted at a public path, a browser could hand them in too, and every
   * count would be a claim by whoever submitted it rather than something the server read.
   * Host code owns `POST /runs/{runId}/profile`, reads the blob, parses, and invokes this.
   *
   * It writes the ROWS as well as the observations — one pass over the file, while the day's
   * salt is at hand to hash each subject. Counting afterwards is then pure SQL over stored
   * rows and needs the file not at all.
   *
   * `subject` arrives raw and is never stored: it is hashed against the day's salt on the way
   * in, and only the hash lands in `tock_rows`. The salt lives in this scope, so the hashing
   * has to happen here rather than in the host.
   *
   * Large files arrive across several invocations. `final` says a batch is the last one, and
   * only then does the run become `profiled` — so `complete` is a fact the caller is told
   * rather than one it assumes.
   */
  'tock/profile-run': {
    summary: 'Record what a batch of the delivered file contained',
    permission: { key: 'run:manage', entity: 'run', idFrom: 'runId' },
    input: z.object({
      runId: z.string(),
      batch: z.array(
        z.object({
          occurredAt: z.string(),
          /** Raw, hashed against the day's salt on the way in, never stored. */
          subject: z.string(),
          fields: z.record(z.string(), z.string().nullable()),
        }),
      ),
      final: z.boolean().default(false),
    }),
    // The run row itself, plus the one fact it cannot carry. `complete` is false while a
    // large file is still being read: the status has not moved yet, and a caller that
    // assumed it had would map a half-profiled run. Everything else a caller wants —
    // `row_count`, `status` — is already the run's own, and restating it here would be a
    // second description of the same number.
    output: tockEntities.run.fields.extend({ complete: z.boolean() }),
    emits: {
      entity: 'run',
      entityIdFrom: 'id',
      type: 'tock.run-profiled',
      schemaVersion: 1,
      piiClass: 'none',
      // Emitted for EVERY batch, not only the last: a non-final batch writes rows,
      // observations and field history, and a mutation with no entry on the spine is the one
      // thing the event rule exists to prevent. `complete` is how a consumer tells the batch
      // that finished profiling from one that merely advanced it.
      payload: ['id', 'source_key', 'row_count', 'status', 'complete'],
    },
  },

  /**
   * Bind a profiled run to a schema version. Refused before profiling — mapping an unread
   * file is guessing with the evidence sitting right there unread.
   */
  'tock/map-run': {
    summary: 'Bind a profiled run to a schema version',
    permission: { key: 'run:manage', entity: 'run', idFrom: 'runId' },
    input: z.object({ runId: z.string(), schemaVersion: z.number().int().positive() }),
    output: tockEntities.run.fields,
    http: { method: 'POST', path: '/runs/{runId}/map' },
    emits: {
      entity: 'run',
      entityIdFrom: 'id',
      type: 'tock.run-mapped',
      schemaVersion: 1,
      piiClass: 'none',
      payload: ['id', 'source_key', 'schema_version'],
    },
  },

  /**
   * Write the rows, the rollups, the captured rules and the labels — and freeze the run.
   *
   * Counting is what makes this run the latest for its period, and nothing is written to the
   * run it displaces: which run is current is derived at read time. Each run's rollup rows
   * carry its own id, written in the transaction that counts it, so a report never reads half
   * of one run's numbers beside half of another's.
   *
   * Chunked like `profile-run`, for the same reason and with the same `complete` answer.
   */
  'tock/count-run': {
    summary: 'Count a mapped run and freeze it',
    permission: { key: 'run:manage', entity: 'run', idFrom: 'runId' },
    input: z.object({
      runId: z.string(),
      /**
       * The rules the caller applied before handing the records over, recorded as
       * `tock_rule_state` rows beside the salt this run hashed with.
       *
       * A bot list is applied upstream — section 10 keeps fetching the lists themselves out
       * of scope — so a run cannot derive which list it was and can only record what it was
       * told. Without this the concept's promise that a superseded run "still names the bot
       * list version it used" had nothing behind it: a correction was indistinguishable from
       * a re-run of the same rules.
       *
       * Optional, and absent means the same as it always did: only the salt is captured.
       */
      rules: z
        .array(
          z.object({
            kind: z.enum(RULE_KINDS),
            /** Which list we MEANT — a name that can be edited upstream without changing. */
            identifier: z.string().min(1),
            /** Which rules we APPLIED. This is the half that actually holds. */
            contentHash: z.string().min(1),
          }),
        )
        .optional(),
    }),
    output: tockEntities.run.fields.extend({ complete: z.boolean() }),
    http: { method: 'POST', path: '/runs/{runId}/count' },
    emits: {
      entity: 'run',
      entityIdFrom: 'id',
      type: 'tock.run-counted',
      schemaVersion: 1,
      piiClass: 'none',
      // Fat: a consumer deciding what a corrected period means must never need a read back.
      payload: [
        'id',
        'source_key',
        'schema_version',
        'period_from',
        'period_to',
        'row_count',
        'rejected_count',
        'counted_at',
      ],
    },
  },

  'tock/get-run': {
    summary: 'One run, and how it got where it is',
    permission: { key: 'report:read', entity: 'run', idFrom: 'runId' },
    input: z.object({ runId: z.string() }),
    output: tockEntities.run.fields,
    http: { method: 'GET', path: '/runs/{runId}' },
  },

  'tock/list-runs': {
    summary: 'The runs over a source, newest first',
    permission: 'report:read',
    input: z.object({ sourceKey: z.string() }),
    output: tockEntities.run.fields,
    paged: {
      over: { entity: 'run', sortable: ['received_at', 'period_from'], filterable: ['source_key', 'status'] },
      total: true,
    },
    http: { method: 'GET', path: '/sources/{sourceKey}/runs' },
  },

  /**
   * The rules a run was counted under, read back.
   *
   * Section 1's whole complaint is that "nobody can say six months later which bot list
   * produced March's figure". `tock_rule_state` was being written and had no read path at
   * all, which answers that complaint on paper and not in the product — a superseded run
   * could hold its rules and no one could ask it for them.
   *
   * Narrowed on the run like every other per-run read, and `report:read` rather than
   * `row:read`: a rule state names a list and a hash, never a person.
   */
  'tock/run-rules': {
    summary: 'The rules in force when a run was counted',
    permission: { key: 'report:read', entity: 'run', idFrom: 'runId' },
    input: z.object({ runId: z.string() }),
    output: z.object({ entries: z.array(tockEntities.rule_state.fields) }),
    http: { method: 'GET', path: '/runs/{runId}/rules' },
  },

  'tock/list-observations': {
    summary: 'What arrived in one run, field by field',
    permission: { key: 'report:read', entity: 'run', idFrom: 'runId' },
    input: z.object({
      runId: z.string(),
      /**
       * The modelling screen's own question: show me what this schema does not account for.
       *
       * `declared` was named `filterable` — so it is a documented query parameter — while no
       * input field carried it and the handler forced the filter map to `run_id` alone. The
       * parameter therefore did nothing at all: every ask came back with every field.
       */
      declared: z.boolean().optional(),
      /**
       * Which kind's fields to show. `variant_key` was named `filterable` with no input
       * field to carry it and no handler to apply it — the same defect `declared` had
       * directly above, arriving again in the same place. An empty string is meaningful
       * rather than absent: it is the ENVELOPE, the fields every record carries.
       */
      variantKey: z.string().optional(),
    }),
    output: tockEntities.observation.fields,
    paged: {
      over: { entity: 'observation', sortable: ['field'], filterable: ['run_id', 'declared', 'variant_key'] },
    },
    http: { method: 'GET', path: '/runs/{runId}/observations' },
  },

  /**
   * Where the declaration and the data disagree — the screen this whole app is for.
   *
   * Four findings, and the first is the one no vendor can produce from sampled telemetry: a
   * field that arrived and nobody declared. Absence of evidence is invisible to a sampler;
   * here the declaration is a fact and the observation is a fact, so a disagreement is too.
   */
  'tock/deviations': {
    summary: 'Where a source declared shape and its data disagree',
    permission: 'report:read',
    input: z.object({ sourceKey: z.string(), schemaVersion: z.number().int().positive().optional() }),
    output: z.object({
      sourceKey: z.string(),
      schemaVersion: z.number().int(),
      findings: z.array(
        z.object({
          kind: z.enum([
            'undeclared_field',
            'declared_never_arrived',
            'type_mismatch',
            'cardinality_spike',
            /** Records whose discriminator values match no declared kind. Kept, not dropped. */
            'unmatched_records',
          ]),
          field: z.string(),
          detail: z.string(),
          firstSeen: z.string().nullable(),
          lastSeen: z.string().nullable(),
          runs: z.number().int(),
        }),
      ),
    }),
    http: { method: 'GET', path: '/sources/{sourceKey}/deviations' },
  },

  /**
   * A field's history across the source, kept past the runs it came from.
   *
   * This is what answers "was this field present before we started using it", and that honest
   * answer is what the back-fill affordance shows instead of asking someone to invent a
   * default.
   */
  'tock/field-history': {
    summary: 'When a field first and last arrived, across every run',
    permission: 'report:read',
    input: z.object({
      sourceKey: z.string(),
      field: z.string().optional(),
      limit: z.number().int().positive().max(FIELD_HISTORY_MAX).optional(),
    }),
    // Not paged, because this entity is composite-keyed and has no single sort key to walk.
    // A capped read has to SAY it was capped, or a screen shows the first N days of a
    // field's history as though that were the whole of it.
    output: z.object({
      entries: z.array(tockEntities.field_history.fields),
      limit: z.number().int(),
      capped: z.boolean(),
    }),
    http: { method: 'GET', path: '/sources/{sourceKey}/fields' },
  },

  /** The rows one run produced. `row:read`, and the reason the role list has four entries. */
  'tock/list-rows': {
    summary: 'The mapped rows of one run',
    permission: { key: 'row:read', entity: 'run', idFrom: 'runId' },
    input: z.object({ runId: z.string() }),
    output: tockEntities.row.fields,
    // `over` rather than a bare `sortKey`: the declared filter is what makes the kernel
    // compose an index behind it. Sorted by id, which is a ULID and therefore already
    // creation-ordered — the order rows were read out of the file.
    paged: { over: { entity: 'row', sortable: ['occurred_at'], filterable: ['run_id'] } },
    http: { method: 'GET', path: '/runs/{runId}/rows' },
  },

  /**
   * The delivered bytes, back out again.
   *
   * `row:read` and not `report:read`, because the file is raw rows in their original shape —
   * a download guarded by the reporting permission would be a way around the whole of
   * section 4.
   */
  'tock/read-source-file': {
    summary: 'Download the file a run was made from',
    permission: { key: 'row:read', entity: 'run', idFrom: 'runId' },
    input: z.object({ runId: z.string() }),
    output: tockEntities.source_file.fields,
    http: { method: 'GET', path: '/runs/{runId}/file' },
  },

  /**
   * The report: counts for one grain and one grouping over a date range.
   *
   * Bounded on purpose. The grouping is one of the sets the schema declared, the grain is one
   * of three, and there is no free-form predicate — arbitrary querying by end users is a
   * different product, and section 10 says so.
   *
   * `runId` on every row is not decoration: it is how a number is traced back to the file and
   * the rules that produced it, and it is what a superseded number is read through.
   */
  'tock/report': {
    summary: 'Counts for one grain and grouping over a period',
    permission: 'report:read',
    input: z.object({
      sourceKey: z.string(),
      /** Which stable shape to read. Omitted is the envelope — what a source counts before
       *  any output is declared, and what every run counted before outputs existed. */
      outputKey: z.string().default(''),
      grain: z.enum(['hour', 'day', 'month']),
      dimSet: z.string(),
      from: z.string(),
      to: z.string(),
      includeUnknown: z.boolean().optional(),
    }),
    output: z.object({
      rows: z.array(
        z.object({
          periodStart: z.string(),
          dim1: z.string(),
          dim2: z.string(),
          label1: z.string().nullable(),
          label2: z.string().nullable(),
          events: z.number().int(),
          measure: z.string().nullable(),
          unit: z.string().nullable(),
          runId: z.string(),
        }),
      ),
      grain: z.enum(['hour', 'day', 'month']),
      dimSet: z.string(),
    }),
    http: { method: 'GET', path: '/sources/{sourceKey}/report' },
  },
});

export const tockModel = emitModel(tockEntities);
