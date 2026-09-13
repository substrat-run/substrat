#!/usr/bin/env node
/**
 * The Tier-2 Iceberg lake, declared once and provisioned idempotently.
 *
 * `wrangler pipelines setup` is an interactive wizard: ~15 prompts, a pasted catalog
 * token, and nothing written down afterwards. That is fine for the first one and wrong
 * for every one after it — a second environment, a restore, or simply answering "what
 * is the roll interval in prod" means clicking through it again and trusting that the
 * same answers were given. Every prompt it asks maps to a flag, so the whole shape can
 * live here instead, in a file a reviewer reads and a diff shows.
 *
 *   node scripts/lake-provision.mjs --dry-run          # print the commands, token redacted
 *   node scripts/lake-provision.mjs                    # create whatever is missing
 *   node scripts/lake-provision.mjs --env test
 *
 * Idempotent by listing first: an existing stream/sink/pipeline is reported and left
 * alone, never recreated. So this is safe to re-run, and re-running it is how you find
 * out whether an account matches the declaration.
 *
 * What it deliberately does NOT do: change anything that already exists. Wrangler has
 * no update for a stream's schema or a sink's rolling policy, and a delete-and-recreate
 * would orphan the Iceberg table the sink is committing to. A drifted account is
 * reported for a human to resolve, because the resolution is never mechanical.
 *
 * The catalog token comes from secrets/platform.<env>.env (R2_LAKE_CATALOG_TOKEN), never
 * from argv — an argument lands in shell history and in the process list. See
 * secrets/README.md for why that key is store-only: the token's real home is the sink
 * config this script writes it into.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The lake, as declared. Changing a value here does NOT migrate an account that already
 * has the old one — see the header. Treat these as the append-only kind of constant.
 *
 * Names use underscores because Cloudflare's pipeline names reject hyphens; the bucket
 * is the opposite (R2 takes lowercase, digits and hyphens only), which is why the two
 * halves of the same lake are spelled differently.
 */
const LAKE = {
  bucket: 'substrat-lake',
  namespace: 'kernel',
  table: 'events',
  stream: 'substrat_outbox_stream',
  sink: 'substrat_outbox_sink',
  pipeline: 'substrat_outbox',
  schemaFile: 'scripts/lake/outbox-stream-schema.json',
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
};

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = has('dry-run');
const env = flag('env') ?? 'prod';
const secretsFile = flag('file') ?? `secrets/platform.${env}.env`;

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Same flat-env parse as scripts/secrets.mjs — KEY=VALUE, `#` comments, quotes. */
function readSecret(key) {
  let text;
  try {
    text = readFileSync(join(ROOT, secretsFile), 'utf8');
  } catch {
    fail(`env file not found: ${secretsFile}\n  cp ${secretsFile}.example ${secretsFile}`);
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    let v = line.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    return v === '' ? undefined : v;
  }
  return undefined;
}

/** Values never printed: a dry run has to be safe to paste into a ticket. */
const SECRET_FLAGS = new Set(['--catalog-token', '--secret-access-key', '--access-key-id']);
const redact = (args) => args.map((a, i) => (SECRET_FLAGS.has(args[i - 1]) ? '********' : a));

function wrangler(args, { capture = false } = {}) {
  const res = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : ['inherit', 'inherit', 'inherit'],
  });
  return res;
}

/**
 * Whether a named pipelines resource already exists.
 *
 * The `list` commands print a table, not JSON, so this matches the name inside a table
 * cell rather than parsing columns — deliberately loose, because the alternative is
 * parsing box-drawing characters and the only question being asked is presence. A
 * false positive would skip a create and print "exists"; `get` is how you confirm.
 */
function exists(kind, name) {
  const res = wrangler(['pipelines', ...kind, 'list'], { capture: true });
  if (res.status !== 0) fail(`wrangler pipelines ${kind.join(' ')} list failed — logged in?\n${res.stderr ?? ''}`);
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(res.stdout);
}

function step(label, { skip, args }) {
  if (skip) {
    console.log(`· ${label}: already exists — left alone`);
    return;
  }
  console.log(`● ${label}: wrangler ${redact(args).join(' ')}`);
  if (dryRun) return;
  const res = wrangler(args);
  if (res.status !== 0) fail(`${label} failed (exit ${res.status})`);
}

console.log(`Lake: ${LAKE.bucket} → ${LAKE.namespace}.${LAKE.table}  (env: ${env})${dryRun ? '  [dry-run]' : ''}\n`);

const catalogToken = readSecret('R2_LAKE_CATALOG_TOKEN');
if (!catalogToken && !dryRun) {
  fail(
    `R2_LAKE_CATALOG_TOKEN blank in ${secretsFile}.\n` +
      '  Create it: R2 Object Storage → Manage API tokens → Create Account API token,\n' +
      '  permission "Admin Read & Write", scoped to this bucket. NOT "Object Read & Write":\n' +
      '  that one is S3-API-only, so the sink is created fine and fails at its first commit.',
  );
}

// The bucket and its catalog first — `sinks create` needs both, and both are safely
// re-runnable (each command is a no-op on something that already exists).
step('bucket', { args: ['r2', 'bucket', 'create', LAKE.bucket], skip: false });
step('catalog', { args: ['r2', 'bucket', 'catalog', 'enable', LAKE.bucket], skip: false });

step('stream', {
  skip: exists(['streams'], LAKE.stream),
  args: [
    'pipelines', 'streams', 'create', LAKE.stream,
    '--schema-file', LAKE.schemaFile,
    '--http-enabled', 'true',
    // Authenticated because the lake is append-only: a forged write becomes history
    // that nothing can retract. The shipper does not use this endpoint at all — it
    // reaches the stream through a [[pipelines]] binding, which carries no credential.
    '--http-auth', 'true',
    // No --cors-origin: a browser never posts here, and CORS is not an access control.
  ],
});

step('sink', {
  skip: exists(['sinks'], LAKE.sink),
  args: [
    'pipelines', 'sinks', 'create', LAKE.sink,
    '--type', 'r2-data-catalog',
    '--bucket', LAKE.bucket,
    '--namespace', LAKE.namespace,
    '--table', LAKE.table,
    '--format', 'parquet',
    '--compression', LAKE.compression,
    '--roll-size', String(LAKE.rollSizeMb),
    '--roll-interval', String(LAKE.rollIntervalSeconds),
    '--catalog-token', catalogToken ?? 'DRY-RUN',
    // No --access-key-id/--secret-access-key: left empty, R2 credentials are created
    // automatically. The S3 key pair an R2 token also hands you is for the
    // S3-compatible API, which nothing on this path speaks.
    // No --partitioning: that flag is r2 sinks only. A Data Catalog sink has no
    // partitioning control, so query pruning comes from Iceberg's own per-file
    // min/max statistics on occurred_at — one more reason the roll settings matter.
  ],
});

step('pipeline', {
  skip: exists([], LAKE.pipeline),
  args: ['pipelines', 'create', LAKE.pipeline, '--sql', LAKE.sql(LAKE)],
});

console.log(`
Bind it in a worker that ships to the lake (the stream id is printed by
\`wrangler pipelines streams list\`):

  "pipelines": [{ "stream": "<stream id>", "binding": "SUBSTRAT_OUTBOX_STREAM" }]

then \`await env.SUBSTRAT_OUTBOX_STREAM.send(rows)\`. Prefer the binding over the HTTP
endpoint wherever the sender is a Worker: it cannot leak, expire, or be rotated out.`);
