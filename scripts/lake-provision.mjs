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
 *   node scripts/lake-provision.mjs --recreate         # only while the lake is EMPTY
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
 * `--recreate` is the one exception, and it is gated on the only condition that makes a
 * teardown free: the Iceberg table holding ZERO snapshots. Not the bucket's object count —
 * creating a table writes its metadata JSON, so one object beside an empty table is the
 * normal state of a lake nothing has shipped to, and gating on that refused the first real
 * recreate this script was ever asked to perform.
 *
 * It has to drop the TABLE too, not just the three pipelines resources. Deleting a sink
 * leaves the catalog table it was committing to, and `sinks create` then refuses with
 * "writing to existing Catalog tables is not yet supported" — so a recreate that skipped
 * this step tore the lake down and could not build it back. Wrangler has no command for
 * it either (`r2 bucket catalog` does enable/disable/get/compaction/snapshot-expiration
 * and nothing else), so the drop goes through the Iceberg REST catalog directly, which
 * needs a `/v1/config?warehouse=…` handshake first to learn the path prefix.
 *
 * An empty bucket is NOT evidence that the table is absent: the table is registered when
 * the sink is created and holds no data files until the first roll, so `object_count: 0`
 * and a live table are the normal state of a lake nothing has shipped to yet. An empty lake has no rows, no Iceberg
 * metadata, and nothing referencing it, so tearing it down costs nothing and a schema
 * mistake is repairable for as long as that stays true. One object in, and the same
 * command refuses — because from then on it would be deleting history, which is the one
 * thing this tier exists not to do. The check fails CLOSED: an object count it cannot
 * parse is a refusal, not an assumption.
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
const recreate = has('recreate');
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

/**
 * The Iceberg REST catalog, resolved once: base URL, path prefix and account id.
 *
 * Cloudflare's catalog speaks the Iceberg REST spec, which means every real path is
 * `/v1/{prefix}/…` and the prefix is only discoverable by asking
 * `/v1/config?warehouse=<warehouse>` first. The warehouse name is `<account>_<bucket>`
 * and the base URL embeds both again — both facts are on the bucket's Settings → R2 Data
 * Catalog panel, and are derived here so nothing has to be pasted.
 */
async function catalog() {
  const account = readSecret('CF_ACCOUNT_ID');
  if (!account) fail(`CF_ACCOUNT_ID blank in ${secretsFile} — needed to address the catalog.`);
  const token = catalogToken;
  const base = `https://catalog.cloudflarestorage.com/${account}/${LAKE.bucket}`;
  const warehouse = `${account}_${LAKE.bucket}`;
  const res = await fetch(`${base}/v1/config?warehouse=${encodeURIComponent(warehouse)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const prefix = (await res.json())?.overrides?.prefix;
  return prefix ? { base, prefix, token } : null;
}

const tableUrl = (c) =>
  `${c.base}/v1/${c.prefix}/namespaces/${encodeURIComponent(LAKE.namespace)}/tables/${encodeURIComponent(LAKE.table)}`;

/**
 * Snapshots on the lake table: a number, `'absent'` if there is no such table, or null if
 * the question could not be answered. Callers treat null as "not empty" — the only safe
 * direction, since the next step drops the table.
 */
async function tableSnapshotCount() {
  const c = await catalog();
  if (!c) return null;
  const res = await fetch(tableUrl(c), { headers: { authorization: `Bearer ${c.token}` } });
  if (res.status === 404) return 'absent';
  if (!res.ok) return null;
  const meta = (await res.json())?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  // The key is OMITTED, not empty, on a table nothing has ever written to — so an absent
  // `snapshots` IS the number zero, and only metadata that will not parse is "unknown".
  // Reading the two as the same thing made this refuse on exactly the table it is meant
  // to be able to drop, which is the right direction to be wrong in and still wrong.
  return Array.isArray(meta.snapshots) ? meta.snapshots.length : 0;
}

/**
 * Drop the lake table so a fresh sink can create it with the current schema.
 *
 * `purgeRequested=true` asks the catalog to remove the data files too. Only ever reached
 * behind the snapshot guard above, so there are none — but a drop that leaves files behind
 * is how a bucket accumulates objects no table references.
 */
async function dropTable() {
  const label = `delete table ${LAKE.namespace}.${LAKE.table}`;
  const c = await catalog();
  if (!c) fail(`${label}: could not reach the Iceberg catalog (token? bucket catalog enabled?)`);
  console.log(`● ${label}: DELETE ${LAKE.namespace}.${LAKE.table}?purgeRequested=true`);
  if (dryRun) return;
  const res = await fetch(`${tableUrl(c)}?purgeRequested=true`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${c.token}` },
  });
  // 404 is success here: the table is gone, which is the whole point.
  if (!res.ok && res.status !== 404) fail(`${label} failed — HTTP ${res.status} ${await res.text()}`);
}

/** Whether the lake bucket exists at all — `bucket info` exits non-zero when it does not. */
function bucketExists() {
  return wrangler(['r2', 'bucket', 'info', LAKE.bucket], { capture: true }).status === 0;
}

/**
 * Whether the bucket's Data Catalog is already serving.
 *
 * `catalog get` prints `Status: active` once enabled. A bucket that does not exist yet
 * reports nothing of the sort, so this is false for it too — which is the answer that
 * makes the create step run in the right order.
 */
function catalogActive() {
  const res = wrangler(['r2', 'bucket', 'catalog', 'get', LAKE.bucket], { capture: true });
  return res.status === 0 && /Status:\s*active/.test(res.stdout ?? '');
}

/**
 * Objects currently in the lake bucket, or null if that could not be established.
 *
 * `bucket info` prints `object_count: N`. Anything else — a changed format, a failed
 * call, an unparseable number — returns null, and every caller treats null as "not
 * empty". The asymmetry is deliberate: guessing "empty" wrongly deletes history.
 */
function bucketObjectCount() {
  const res = wrangler(['r2', 'bucket', 'info', LAKE.bucket], { capture: true });
  if (res.status !== 0) return null;
  const m = /object_count:\s*(\d+)/.exec(res.stdout ?? '');
  return m ? Number(m[1]) : null;
}

if (recreate) {
  // SNAPSHOTS are the gate, and the bucket's object count deliberately is NOT.
  //
  // Iceberg commits data only under a snapshot, so a table with none has never received a
  // row — whatever is in the bucket. The object count cannot answer the same question,
  // because creating a table writes its metadata JSON: `object_count: 1` beside an empty
  // table is the NORMAL state of a lake nothing has shipped to, and gating on it refused
  // the first real recreate this script was ever asked to do. Snapshot expiry always keeps
  // the current snapshot, so "no snapshots and no current snapshot" cannot be a table whose
  // history was merely aged out.
  const snapshots = await tableSnapshotCount();
  if (snapshots !== 0 && snapshots !== 'absent') {
    fail(
      snapshots === null
        ? `could not read ${LAKE.namespace}.${LAKE.table}'s snapshots — refusing to recreate.\n` +
            '  "could not tell" is not "empty", and this step would drop the table.'
        : `${LAKE.namespace}.${LAKE.table} has ${snapshots} snapshot(s) — refusing to recreate.\n` +
            '  Data has been committed to this table. Dropping it destroys history, which is\n' +
            '  what this tier exists not to do. A schema change here is an Iceberg schema\n' +
            '  evolution, by hand.',
    );
  }
  // Reported, never gating: useful for noticing objects the table does not account for.
  const objects = bucketObjectCount();
  console.log(
    `● recreate: ${LAKE.namespace}.${LAKE.table} has no snapshots — nothing committed` +
      `${objects === null ? '' : ` (${objects} object(s) in the bucket: table metadata)`}`,
  );
  console.log('  tearing down pipeline, sink, stream, table\n');
  // Reverse dependency order: the pipeline references the sink and the stream, so it
  // goes first. The bucket and its catalog stay — nothing is wrong with them, and an
  // empty bucket has no table metadata to orphan.
  for (const [label, kind, name] of [
    ['pipeline', [], LAKE.pipeline],
    ['sink', ['sinks'], LAKE.sink],
    ['stream', ['streams'], LAKE.stream],
  ]) {
    if (!exists(kind, name)) {
      console.log(`· delete ${label}: not present — nothing to do`);
      continue;
    }
    step(`delete ${label}`, { args: ['pipelines', ...kind, 'delete', name, '--force'], skip: false });
  }
  // Last, because the sink must be gone before its table is: the reverse order would drop
  // a table something is still registered to commit to.
  await dropTable();
  console.log();
}

// The bucket and its catalog first — `sinks create` needs both.
//
// Neither create command is a no-op on something that already exists: `r2 bucket create`
// fails with "already exists, and you own it" (10004), which would abort the whole run on
// the second pass. So both are existence-checked like the pipelines resources, and for the
// same reason: re-running this script has to be how you VERIFY an account, which means a
// fully-provisioned account must run clean.
step('bucket', { args: ['r2', 'bucket', 'create', LAKE.bucket], skip: bucketExists() });
step('catalog', { args: ['r2', 'bucket', 'catalog', 'enable', LAKE.bucket], skip: catalogActive() });

step('stream', {
  skip: recreate ? false : exists(['streams'], LAKE.stream),
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
  skip: recreate ? false : exists(['sinks'], LAKE.sink),
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
  skip: recreate ? false : exists([], LAKE.pipeline),
  args: ['pipelines', 'create', LAKE.pipeline, '--sql', LAKE.sql(LAKE)],
});

console.log(`
Bind it in a worker that ships to the lake (the stream id is printed by
\`wrangler pipelines streams list\`):

  "pipelines": [{ "stream": "<stream id>", "binding": "SUBSTRAT_OUTBOX_STREAM" }]

then \`await env.SUBSTRAT_OUTBOX_STREAM.send(rows)\`. Prefer the binding over the HTTP
endpoint wherever the sender is a Worker: it cannot leak, expire, or be rotated out.`);
