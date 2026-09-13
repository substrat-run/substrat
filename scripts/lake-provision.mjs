#!/usr/bin/env node
/**
 * The Tier-2 Iceberg lake, declared once and provisioned idempotently.
 *
 * `wrangler pipelines setup` is an interactive wizard: ~15 prompts, a pasted catalog
 * token, and nothing written down afterwards. That is fine for the first one and wrong
 * for every one after it — a restore, or simply answering "what is the roll interval in
 * prod" means clicking through it again and trusting that the same answers were given.
 * Every prompt it asks becomes a field of one request to the Pipelines API, so the whole
 * shape can live here instead, in a file a reviewer reads and a diff shows.
 *
 *   node scripts/lake-provision.mjs --dry-run          # compare, print what would run
 *   node scripts/lake-provision.mjs                    # create whatever is missing
 *   node scripts/lake-provision.mjs --recreate         # only while the lake is EMPTY
 *   node scripts/lake-provision.mjs --file <env file>  # default secrets/platform.prod.env
 *
 * It speaks to the REST API wrangler wraps (`/accounts/<id>/pipelines/v1/…`, `/r2/…`,
 * `/r2-catalog/…`) rather than to wrangler, for three reasons that are each a review
 * finding on the wrangler version of this file:
 *
 *   - the catalog token travels in a request body over TLS. Wrangler's only transport
 *     for it is `--catalog-token <value>`, which is a child process's argv — redacting the
 *     LOG does not take it out of `ps`.
 *   - the account is in every URL, so nothing depends on which of several Cloudflare
 *     accounts a login happens to resolve to. The Iceberg catalog calls were already
 *     pinned that way; the wrangler half was not.
 *   - `list` returns the resource as JSON. Wrangler prints a table, which answers "is
 *     there something by this name" and nothing else, so an existing stream with the
 *     wrong schema read as healthy.
 *
 * Idempotent by listing first, and a check by COMPARING: an existing stream, sink or
 * pipeline is fetched and every declared field is held against it — schema fields, HTTP
 * auth, format, compression, rolling policy, namespace, table, SQL. A match is left alone.
 * A mismatch is DRIFT: reported, never changed, and the run exits non-zero so a green
 * `pnpm lake:check` means the account matches this file. The resolution is a human's,
 * because Cloudflare has no update for a stream's schema or a sink's rolling policy, and
 * a delete-and-recreate would orphan the Iceberg table the sink is committing to.
 *
 * `--recreate` is the one exception, and it is gated on the only condition that makes a
 * teardown free: the Iceberg table holding ZERO snapshots. Iceberg commits data only
 * under a snapshot, so a table with none has never received a row — whatever the bucket
 * holds (creating a table writes its metadata JSON, so one object beside an empty table
 * is the normal state of a lake nothing has shipped to; gating on the object count refused
 * the first real recreate this script was asked to do). The gate is read TWICE: once up
 * front, so a lake with history is refused before anything is touched, and again after the
 * pipeline and sink are gone — the moment nothing can commit any more — because a roll in
 * flight between the first read and the teardown would otherwise be dropped with the
 * table. Both reads fail CLOSED: metadata that cannot be parsed is a refusal, not zero.
 *
 * It has to drop the TABLE too, not just the three pipelines resources. Deleting a sink
 * leaves the catalog table it was committing to, and creating a sink then refuses with
 * "writing to existing Catalog tables is not yet supported" — so a recreate that skipped
 * this step tore the lake down and could not build it back. That drop goes through the
 * Iceberg REST catalog (a different host, authenticated with the R2 catalog token), which
 * needs a `/v1/config?warehouse=…` handshake first to learn the path prefix.
 *
 * There is no `--env`. The control plane has `-test` twins of its resources; the lake has
 * none, and a second lake is a decision — its own bucket, its own bucket-scoped catalog
 * token, a naming scheme — not a flag. Until it is made, an `--env test` that only changed
 * the secrets filename would inspect and reuse the production lake, which is worse than
 * refusing. `--file` is for a different ACCOUNT, where the same names are the right names.
 *
 * Credentials come from the secrets file, never from argv: `CF_API_TOKEN` for the account
 * API (needs Workers Pipelines read for a check, write to provision, plus Workers R2
 * Storage write and R2 Data Catalog write for the bucket half) and `R2_LAKE_CATALOG_TOKEN`
 * for the sink and the Iceberg catalog — see secrets/README.md for why that key is
 * store-only: its real home is the sink config this script writes it into.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The lake, as declared. Changing a value here does NOT migrate an account that already
 * has the old one — it makes `lake:check` red until a human resolves it. Treat these as
 * the append-only kind of constant.
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
};

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const flag = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = has('dry-run');
const recreate = has('recreate');
const secretsFile = flag('file') ?? 'secrets/platform.prod.env';

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Same flat-env parse as scripts/secrets.mjs — KEY=VALUE, `#` comments, quotes. */
function readSecret(key) {
  let text;
  try {
    text = readFileSync(resolve(ROOT, secretsFile), 'utf8');
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

const account = readSecret('CF_ACCOUNT_ID');
if (!account) fail(`CF_ACCOUNT_ID blank in ${secretsFile}.`);
const apiToken = readSecret('CF_API_TOKEN');
if (!apiToken) fail(`CF_API_TOKEN blank in ${secretsFile} — the account API needs it (see the header).`);
const catalogToken = readSecret('R2_LAKE_CATALOG_TOKEN');
// A dry run needs it only to READ the snapshot gate, which a dry-run recreate still does.
if (!catalogToken && (!dryRun || recreate)) {
  fail(
    `R2_LAKE_CATALOG_TOKEN blank in ${secretsFile}.\n` +
      '  Create it: R2 Object Storage → Manage API tokens → Create Account API token,\n' +
      '  permission "Admin Read & Write", scoped to this bucket. NOT "Object Read & Write":\n' +
      '  that one is S3-API-only, so the sink is created fine and fails at its first commit.',
  );
}

console.log(`Lake: ${LAKE.bucket} → ${LAKE.namespace}.${LAKE.table}  (account ${account})${dryRun ? '  [dry-run]' : ''}\n`);

/**
 * One call to the account API. Returns the envelope's `result` plus enough to say why a
 * call did not succeed — the API answers `success: false` inside a 2xx as well as with a
 * 4xx, and a caller deciding "absent" versus "could not tell" needs the error code.
 */
async function cf(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  return {
    ok: res.ok && json?.success !== false,
    status: res.status,
    result: json?.result,
    errors,
    codes: new Set(errors.map((e) => e?.code)),
    why: errors.map((e) => `${e?.code ?? '?'} ${e?.message ?? ''}`.trim()).join('; ') || `HTTP ${res.status}`,
  };
}

/** A 401/403 or an auth error code names the token, since that is what it always is. */
const authHint = (r) =>
  r.status === 401 || r.status === 403 || r.codes.has(10000) || r.codes.has(9109)
    ? '\n  CF_API_TOKEN lacks a permission this needs — see the header for the list.'
    : '';

/** Values never printed: a dry run has to be safe to paste into a ticket. */
const redact = (v) =>
  JSON.stringify(v, (k, x) => (/token|secret|key/i.test(k) && typeof x === 'string' ? '********' : x));

// ── The declared shape, as the requests wrangler would have sent ────────────────────
//
// Field for field what `wrangler pipelines streams|sinks create` and `pipelines create`
// build from their flags (wrangler-dist/cli.js, `streamConfig` / `sinkConfig` /
// `pipelineConfig`), so the CLI docs still read as documentation of this file.

const schema = JSON.parse(readFileSync(join(ROOT, LAKE.schemaFile), 'utf8'));

const DECLARED = {
  stream: {
    name: LAKE.stream,
    format: { type: 'json' },
    // Authenticated because the lake is append-only: a forged write becomes history
    // that nothing can retract. The shipper does not use this endpoint at all — it
    // reaches the stream through a [[pipelines]] binding, which carries no credential.
    // No cors: a browser never posts here, and CORS is not an access control.
    http: { enabled: true, authentication: true },
    worker_binding: { enabled: true },
    schema,
  },
  sink: {
    name: LAKE.sink,
    type: 'r2_data_catalog',
    format: { type: 'parquet', compression: LAKE.compression },
    config: {
      bucket: LAKE.bucket,
      namespace: LAKE.namespace,
      table_name: LAKE.table,
      rolling_policy: {
        file_size_bytes: LAKE.rollSizeMb * 1024 * 1024,
        interval_seconds: LAKE.rollIntervalSeconds,
      },
      // No credentials: left out, R2 credentials are created automatically. The S3 key
      // pair an R2 token also hands you is for the S3-compatible API, which nothing on
      // this path speaks. No partitioning: that is an r2 sink's field. A Data Catalog
      // sink has no partitioning control, so query pruning comes from Iceberg's own
      // per-file min/max statistics on occurred_at — one more reason the roll settings
      // matter.
      token: catalogToken ?? 'DRY-RUN',
    },
  },
  pipeline: { name: LAKE.pipeline, sql: LAKE.sql(LAKE) },
};

// ── Existence and drift ──────────────────────────────────────────────────────────────

/** The pipelines resource of this kind and exact name, or null. Failing to LIST is fatal. */
async function find(kind, name) {
  const r = await cf('GET', `/pipelines/v1/${kind}?name=${encodeURIComponent(name)}&per_page=50`);
  if (!r.ok) fail(`list ${kind} — ${r.why}${authHint(r)}`);
  const items = Array.isArray(r.result) ? r.result : [];
  return items.find((x) => x?.name === name) ?? null;
}

/** One stream field as a comparable line; the API may echo keys we do not declare. */
const fieldLine = (f) => `${f.name}: ${f.type}${f.unit ? `(${f.unit})` : ''}${f.required ? ' required' : ''}`;

/**
 * Every declared fact about a resource, held against the live one. The keys are the ones
 * `wrangler … get` displays, so a line here can be confirmed with the CLI. Only what is
 * DECLARED is compared — the API adds ids, timestamps and defaults, none of which are
 * drift. Returns the mismatches, empty for a match.
 */
function drift(kind, live) {
  const d = DECLARED[kind];
  const lines = [];
  const same = (label, want, got) => {
    if (want !== got) lines.push(`${label}: declared ${JSON.stringify(want)}, live ${JSON.stringify(got)}`);
  };
  if (kind === 'stream') {
    same('format.type', d.format.type, live.format?.type);
    same('http.enabled', d.http.enabled, Boolean(live.http?.enabled));
    same('http.authentication', d.http.authentication, Boolean(live.http?.authentication));
    // The binding is how the shipper reaches the stream at all: a stream with it off
    // still lists as healthy and `env.SUBSTRAT_OUTBOX_STREAM.send()` fails at runtime.
    same('worker_binding.enabled', d.worker_binding.enabled, Boolean(live.worker_binding?.enabled));
    const want = new Map(d.schema.fields.map((f) => [f.name, fieldLine(f)]));
    const got = new Map((live.schema?.fields ?? []).map((f) => [f.name, fieldLine(f)]));
    for (const [name, line] of want) {
      if (!got.has(name)) lines.push(`schema: declared field missing live — ${line}`);
      else if (got.get(name) !== line) lines.push(`schema: declared ${line}; live ${got.get(name)}`);
    }
    for (const [name, line] of got) if (!want.has(name)) lines.push(`schema: live field not declared — ${line}`);
  } else if (kind === 'sink') {
    same('type', d.type, live.type);
    same('format.type', d.format.type, live.format?.type);
    same('format.compression', d.format.compression, live.format?.compression);
    same('config.bucket', d.config.bucket, live.config?.bucket);
    same('config.namespace', d.config.namespace, live.config?.namespace);
    same('config.table_name', d.config.table_name, live.config?.table_name);
    same('rolling_policy.file_size_bytes', d.config.rolling_policy.file_size_bytes, live.config?.rolling_policy?.file_size_bytes);
    same('rolling_policy.interval_seconds', d.config.rolling_policy.interval_seconds, live.config?.rolling_policy?.interval_seconds);
    // The token is write-only on the API and could not be compared if it were not.
  } else if (kind === 'pipeline') {
    // Whitespace is the one thing the API may reformat; a different token is drift.
    const sql = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
    same('sql', sql(d.sql), sql(live.sql));
    if (live.status === 'failed') lines.push(`status: failed — ${live.failure_reason ?? 'no reason given'}`);
  }
  return lines;
}

const drifted = [];

/**
 * Create a resource unless it exists; when it exists, compare. `existing` is the live
 * resource or null, `path` and `body` are the POST that would create it.
 */
async function ensure(kind, existing, path, body) {
  if (existing) {
    const lines = drift(kind, existing);
    if (lines.length === 0) {
      console.log(`· ${kind}: exists and matches — left alone`);
      return;
    }
    drifted.push(kind);
    console.log(`! ${kind}: exists and DIFFERS — left alone\n${lines.map((l) => `    ${l}`).join('\n')}`);
    return;
  }
  console.log(`● ${kind}: POST ${path} ${redact(body)}`);
  if (dryRun) return;
  const r = await cf('POST', path, body);
  if (!r.ok) fail(`create ${kind} — ${r.why}${authHint(r)}`);
}

// ── The Iceberg catalog, for the table itself ────────────────────────────────────────

/**
 * The Iceberg REST catalog, resolved once: base URL and path prefix.
 *
 * Cloudflare's catalog speaks the Iceberg REST spec, which means every real path is
 * `/v1/{prefix}/…` and the prefix is only discoverable by asking
 * `/v1/config?warehouse=<warehouse>` first. The warehouse name is `<account>_<bucket>`
 * and the base URL embeds both again — both facts are on the bucket's Settings → R2 Data
 * Catalog panel, and are derived here so nothing has to be pasted. Authenticated with the
 * R2 catalog token, not the account API token: a different host, a different credential.
 */
async function catalog() {
  const base = `https://catalog.cloudflarestorage.com/${account}/${LAKE.bucket}`;
  const warehouse = `${account}_${LAKE.bucket}`;
  const res = await fetch(`${base}/v1/config?warehouse=${encodeURIComponent(warehouse)}`, {
    headers: { authorization: `Bearer ${catalogToken}` },
  });
  if (!res.ok) return null;
  const prefix = (await res.json())?.overrides?.prefix;
  return prefix ? { base, prefix } : null;
}

const tableUrl = (c) =>
  `${c.base}/v1/${c.prefix}/namespaces/${encodeURIComponent(LAKE.namespace)}/tables/${encodeURIComponent(LAKE.table)}`;

/**
 * Snapshots on the lake table: a number, `'absent'` if there is no such table, or null if
 * the question could not be answered. Callers treat null as "not empty" — the only safe
 * direction, since the next step drops the table.
 *
 * The key is OMITTED, not empty, on a table nothing has ever written to — so an absent
 * `snapshots` IS the number zero. A `snapshots` that is PRESENT and not an array is
 * something else: a changed or corrupted response, and reading it as zero would let the
 * fail-closed gate authorize a drop. Only the omitted key is zero; anything present that
 * is not a list is null.
 */
async function tableSnapshotCount() {
  const c = await catalog();
  if (!c) return null;
  const res = await fetch(tableUrl(c), { headers: { authorization: `Bearer ${catalogToken}` } });
  if (res.status === 404) return 'absent';
  if (!res.ok) return null;
  const meta = (await res.json())?.metadata;
  if (!meta || typeof meta !== 'object') return null;
  if (!('snapshots' in meta)) return 0;
  return Array.isArray(meta.snapshots) ? meta.snapshots.length : null;
}

/** Refuse unless the table has never received a row. `when` names which read this is. */
function assertNoSnapshots(snapshots, when) {
  if (snapshots === 0 || snapshots === 'absent') return;
  fail(
    snapshots === null
      ? `could not read ${LAKE.namespace}.${LAKE.table}'s snapshots (${when}) — refusing to recreate.\n` +
          '  "could not tell" is not "empty", and the next step would drop the table.'
      : `${LAKE.namespace}.${LAKE.table} has ${snapshots} snapshot(s) (${when}) — refusing to recreate.\n` +
          '  Data has been committed to this table. Dropping it destroys history, which is\n' +
          '  what this tier exists not to do. A schema change here is an Iceberg schema\n' +
          '  evolution, by hand.',
  );
}

/**
 * Drop the lake table so a fresh sink can create it with the current schema.
 *
 * `purgeRequested=true` asks the catalog to remove the data files too. Only ever reached
 * behind the snapshot guard, so there are none — but a drop that leaves files behind is
 * how a bucket accumulates objects no table references.
 */
async function dropTable() {
  const label = `delete table ${LAKE.namespace}.${LAKE.table}`;
  const c = await catalog();
  if (!c) fail(`${label}: could not reach the Iceberg catalog (token? bucket catalog enabled?)`);
  console.log(`● ${label}: DELETE ${LAKE.namespace}.${LAKE.table}?purgeRequested=true`);
  if (dryRun) return;
  const res = await fetch(`${tableUrl(c)}?purgeRequested=true`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${catalogToken}` },
  });
  // 404 is success here: the table is gone, which is the whole point.
  if (!res.ok && res.status !== 404) fail(`${label} failed — HTTP ${res.status} ${await res.text()}`);
}

// ── Recreate ─────────────────────────────────────────────────────────────────────────

if (recreate) {
  if (dryRun) {
    console.log('● recreate [dry-run]: the snapshot gate is read for real; nothing is deleted\n');
  }
  assertNoSnapshots(await tableSnapshotCount(), 'before teardown');
  console.log(`● recreate: ${LAKE.namespace}.${LAKE.table} has no snapshots — nothing committed`);
  console.log('  tearing down pipeline, sink, stream, then the table\n');
  // Reverse dependency order: the pipeline references the sink and the stream, so it
  // goes first. The bucket and its catalog stay — nothing is wrong with them.
  for (const kind of ['pipelines', 'sinks', 'streams']) {
    const name = { pipelines: LAKE.pipeline, sinks: LAKE.sink, streams: LAKE.stream }[kind];
    const live = await find(kind, name);
    if (!live) {
      console.log(`· delete ${kind.slice(0, -1)} ${name}: not present — nothing to do`);
      continue;
    }
    console.log(`● delete ${kind.slice(0, -1)} ${name}: DELETE /pipelines/v1/${kind}/${live.id}`);
    if (dryRun) continue;
    const r = await cf('DELETE', `/pipelines/v1/${kind}/${live.id}`);
    if (!r.ok) fail(`delete ${kind.slice(0, -1)} ${name} — ${r.why}${authHint(r)}`);
  }
  // Read the gate AGAIN, now that the pipeline and sink are gone and nothing can commit:
  // a roll in flight during the first read could have landed a first snapshot since. If
  // it did, the table and its history are intact and stay so — only the three pipelines
  // resources are gone, and putting a sink back onto a table with data is a human's call
  // (Cloudflare refuses to create a sink onto an existing table, so it is an Iceberg
  // schema evolution plus a new table, or a restore of the old sink by hand).
  assertNoSnapshots(await tableSnapshotCount(), 'after teardown — the table was NOT dropped');
  // Last, because the sink must be gone before its table is: the reverse order would drop
  // a table something is still registered to commit to.
  await dropTable();
  console.log();
}

// ── Provision ────────────────────────────────────────────────────────────────────────

// The bucket and its catalog first — the sink needs both. Neither create is a no-op on
// something that already exists, so both are existence-checked like the pipelines
// resources, and for the same reason: re-running this script has to be how you VERIFY an
// account, which means a fully-provisioned account must run clean.
{
  const r = await cf('GET', `/r2/buckets/${LAKE.bucket}`);
  // 10006 is R2's "no such bucket"; anything else that is not success is not "absent".
  const absent = !r.ok && (r.status === 404 || r.codes.has(10006));
  if (!r.ok && !absent) fail(`read bucket ${LAKE.bucket} — ${r.why}${authHint(r)}`);
  if (!absent) console.log(`· bucket: exists — left alone`);
  else {
    console.log(`● bucket: POST /r2/buckets {"name":"${LAKE.bucket}"}`);
    if (!dryRun) {
      const c = await cf('POST', '/r2/buckets', { name: LAKE.bucket });
      if (!c.ok) fail(`create bucket — ${c.why}${authHint(c)}`);
    }
  }
}
{
  // `status: active` once enabled; 40401 is "no catalog on this bucket" (which a bucket
  // that does not exist yet reports too — the answer that orders the create steps right).
  const r = await cf('GET', `/r2-catalog/${LAKE.bucket}`);
  const active = r.ok && r.result?.status === 'active';
  if (!r.ok && r.status !== 404 && !r.codes.has(40401)) fail(`read catalog — ${r.why}${authHint(r)}`);
  if (active) console.log(`· catalog: active — left alone`);
  else {
    console.log(`● catalog: POST /r2-catalog/${LAKE.bucket}/enable`);
    if (!dryRun) {
      const c = await cf('POST', `/r2-catalog/${LAKE.bucket}/enable`);
      if (!c.ok) fail(`enable catalog — ${c.why}${authHint(c)}`);
    }
  }
}

// After a recreate the three are known gone, and a dry-run recreate must still print
// the creates it would run rather than "exists" — so the lookup is skipped, not repeated.
const lookup = (kind, name) => (recreate ? null : find(kind, name));
await ensure('stream', await lookup('streams', LAKE.stream), '/pipelines/v1/streams', DECLARED.stream);
await ensure('sink', await lookup('sinks', LAKE.sink), '/pipelines/v1/sinks', DECLARED.sink);
await ensure('pipeline', await lookup('pipelines', LAKE.pipeline), '/pipelines/v1/pipelines', DECLARED.pipeline);

if (drifted.length > 0) {
  fail(
    `${drifted.join(', ')} differ${drifted.length === 1 ? 's' : ''} from the declaration above — reported, not changed.\n` +
      '  Cloudflare has no update for these, and delete-and-recreate orphans the table the sink\n' +
      '  commits to. Either the declaration is wrong (fix it here) or the account is (--recreate\n' +
      '  while the table has no snapshots; an Iceberg schema evolution by hand once it does).',
  );
}

console.log(`
Bind it in a worker that ships to the lake (the stream id is in
\`wrangler pipelines streams list\`):

  "pipelines": [{ "stream": "<stream id>", "binding": "SUBSTRAT_OUTBOX_STREAM" }]

then \`await env.SUBSTRAT_OUTBOX_STREAM.send(rows)\`. Prefer the binding over the HTTP
endpoint wherever the sender is a Worker: it cannot leak, expire, or be rotated out.`);
