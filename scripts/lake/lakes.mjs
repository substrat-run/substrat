/**
 * The Tier-2 lakes, declared once (`scripts/lake-provision.mjs` creates and checks them;
 * `scripts/env-provision.mjs` runs that for an environment and records each stream's id).
 * Kept apart from the provisioning script so both can import it: that script runs on import.
 */
/**
 * The lake, as declared. Changing a value here does NOT migrate an account that already
 * has the old one — it makes `lake:check` red until a human resolves it. Treat these as
 * the append-only kind of constant.
 *
 * Names use underscores because Cloudflare's pipeline names reject hyphens; the bucket
 * is the opposite (R2 takes lowercase, digits and hyphens only), which is why the two
 * halves of the same lake are spelled differently.
 */
export const LAKES = {
 events: {
  bucket: 'substrat-lake',
  namespace: 'kernel',
  table: 'events',
  stream: 'substrat_outbox_stream',
  sink: 'substrat_outbox_sink',
  pipeline: 'substrat_outbox',
  // GENERATED from the outbox DDL by tools/lake-schema-emit.mjs (`pnpm lint:lake-schema`).
  schemaFile: 'scripts/lake/outbox-stream-schema.generated.json',
  // parquet + zstd: the table is written once and scanned rarely, so ratio matters and
  // compression speed does not. zstd decompresses at about snappy's speed anyway.
  compression: 'zstd',
  // A CEILING, not a target — files roll on size OR interval, whichever comes first.
  // 100 sits just under the bucket's 128MB compaction target, so compaction has little
  // to do (it bills per GB and per object processed).
  rollSizeMb: 100,
  // The one that actually binds at low volume: at the outbox's real rate the timer
  // always fires before 100MB. 60 is the floor and the wrong choice — it would make
  // ~1440 tiny files a day, paying catalog operations and compaction on a table whose
  // whole content fits in one file, and R2 SQL scans get slower as per-file overhead
  // starts to dominate. The cost of 300 is that history is queryable ~5 minutes late,
  // which is what Tier 1 is for.
  rollIntervalSeconds: 300,
  // Exact history, so no transformation: the lake is fed by the stream and nothing
  // reshapes it on the way in (kernel-design §5.3). A WHERE clause here would be an
  // ungated filter on the audit spine, living in a Cloudflare config rather than in a
  // reviewed diff — if something must be dropped, the shipper is where that belongs.
  // `SELECT *` on purpose: an envelope field added later should flow through or fail
  // loudly, not be silently omitted from a record whose job is completeness. (This is
  // why boundary-lint R8's star-read ban does not transfer — R8 protects a published
  // surface from drifting with a physical table; here the lake IS the record.)
  sql: (l) => `INSERT INTO ${l.sink} SELECT * FROM ${l.stream}`,
  // The repository variable and secrets-file key the control plane's binding is spliced from.
  idVar: 'CF_PIPELINE_OUTBOX_STREAM_ID',
 },
 // K-70 (tenants × time data leaves the objects): the directory's own logs and meters, shipped
 // through its outbox (packages/kernel/src/directory-lake.ts). Same bucket, namespace, format and
 // roll settings as the events lake, for the same reasons; its own stream, sink, pipeline and
 // table, because a stream has one schema. `--lake directory` selects it.
 directory: {
  bucket: 'substrat-lake',
  namespace: 'kernel',
  table: 'directory',
  stream: 'substrat_directory_stream',
  sink: 'substrat_directory_sink',
  pipeline: 'substrat_directory',
  // GENERATED from the directory outbox DDL by tools/lake-schema-emit.mjs (`pnpm lint:lake-schema`).
  schemaFile: 'scripts/lake/directory-stream-schema.generated.json',
  compression: 'zstd',
  rollSizeMb: 100,
  rollIntervalSeconds: 300,
  // The same pass-through statement, for the same reason: the lake is fed whole, never reshaped.
  sql: (l) => LAKES.events.sql(l),
  idVar: 'CF_PIPELINE_DIRECTORY_STREAM_ID',
 },
};
