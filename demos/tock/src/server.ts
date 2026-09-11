/**
 * The boot harness — node-only imports live HERE and never in module code.
 *
 * The host is built ONCE, on a persistent directory: a per-request or in-memory host answers
 * every request from an empty world, which every test that bypasses HTTP would fail to notice.
 *
 * Authentication is an ordinary OIDC round-trip against whatever `OIDC_ISSUER` names — locally
 * `@substrat-run/dev-issuer`, a real provider you sign into by picking a name. There is no dev
 * auth branch, so the local login IS the production round-trip.
 *
 * ## The two routes that are not operations
 *
 * Upload and profile are HOST routes because they touch bytes, which module code cannot. They
 * are the whole reason `tock/profile-run` declares no `http`: the parsing happens here, on the
 * server, over bytes this process stored — never over records a client supplied.
 */
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { platformActorId } from '@substrat-run/contracts';
import { devLogin } from '@substrat-run/dev-issuer';
import { API_DOCUMENT } from './api.js';
import { contentHashOf, PROFILE_BATCH, parseDeliveredFile, sniffDelimiter, sniffFormat, type ReadPlan } from './ingest.js';
import { DEV_PROVIDER } from './personas.js';
import { mountApi } from './routes.js';
import { buildHost, linkDevPersonas, seed, type World } from './seed.js';

const DATA = process.env.DATA_DIR ?? '.data';
const FILES = join(DATA, 'files');
const CAST = join(DATA, 'cast.json');

interface Run {
  id: string;
  status: string;
  row_count: number | null;
  complete?: boolean;
}

/**
 * The plan the old code hardcoded, for a run recorded before the mapping was stored.
 *
 * A null `format` on a run is not missing data: it says this run predates the mapping being
 * recorded, and every such run was read exactly this way. Reading it back through this
 * constant is how an old run stays profilable without any row being rewritten to claim a
 * choice nobody made.
 */
const LEGACY_PLAN: ReadPlan = { format: 'csv', delimiter: ',', timeField: 'occurred_at', subjectField: 'subject' };

async function boot() {
  mkdirSync(FILES, { recursive: true });
  const host = buildHost(DATA);

  let world: World;
  if (existsSync(CAST)) {
    world = JSON.parse(readFileSync(CAST, 'utf8')) as World;
  } else {
    world = await seed(host);
    writeFileSync(CAST, JSON.stringify(world, null, 2));
  }

  // Re-branded on the way in: everything loaded from JSON crossed a serialization boundary,
  // so `world.staff` is a plain string until parsed.
  const staff = platformActorId.parse(world.staff);
  await linkDevPersonas(host, { ...world, staff });

  const app = new Hono();
  const login = devLogin({ directory: host.admin, actor: staff, provider: DEV_PROVIDER });

  /** The scope stub for whoever is signed in, or a 401. */
  const scopeOf = async (headers: Headers) => {
    const caller = await login.caller(headers);
    if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
    return host.getScope(caller.principal, caller.tenantId, caller.scopeId);
  };

  app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

  app.get('/api/me', async (c) => {
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ principal: caller.principal, display: caller.display });
  });

  app.get('/openapi.json', (c) => c.json(API_DOCUMENT));

  /**
   * Upload a delivered file and open a run over it.
   *
   * The body is the file. The server hashes it, stores it, reads the period out of it, and
   * calls `tock/receive-run` — so the content hash and the period a run claims are things this
   * process derived rather than things a caller asserted.
   *
   * The permission is still the operation's: this route mints no authority, it just carries
   * bytes to a place `receive-run` can name. An analyst may upload; a viewer gets the
   * operation's own 403.
   */
  app.post('/api/sources/:key/upload', async (c) => {
    const scope = await scopeOf(c.req.raw.headers);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength === 0) return c.json({ error: 'the upload is empty' }, 400);

    const text = new TextDecoder().decode(bytes);

    /**
     * The caller says which columns are structural; the server still decides the FORMAT.
     *
     * Shape is a property of the bytes and is therefore the server's to read, while which
     * column means "when" is a judgement only a person looking at the file can make. Taking
     * the format on trust would let a caller claim `jsonl` for a semicolon CSV and get a file
     * of unreadable lines instead of an error naming the real problem.
     */
    const format = sniffFormat(text);
    const delimiter = format === 'csv' ? sniffDelimiter(text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '') : null;
    const timeField = c.req.query('timeField');
    if (!timeField) return c.json({ error: 'name the column carrying the instant (timeField)' }, 400);
    const subjectField = c.req.query('subjectField') || null;
    const plan: ReadPlan = { format, delimiter, timeField, subjectField };

    let parsed;
    try {
      parsed = parseDeliveredFile(text, plan);
    } catch (e) {
      // A file we cannot read is a 400 naming why, never a run left half-open.
      return c.json({ error: (e as Error).message }, 400);
    }

    const contentHash = await contentHashOf(bytes);
    const storageKey = `files/${contentHash.replace(':', '-')}`;
    writeFileSync(join(DATA, storageKey), bytes);

    const run = await scope.invoke<Run>('tock/receive-run', {
      sourceKey: c.req.param('key'),
      filename: c.req.query('filename') ?? 'upload.csv',
      byteSize: bytes.byteLength,
      contentHash,
      storageKey,
      format,
      delimiter,
      timeField,
      subjectField,
      periodFrom: parsed.periodFrom,
      periodTo: parsed.periodTo,
    });
    return c.json({ run, records: parsed.records.length, malformed: parsed.malformed }, 201);
  });

  /**
   * Read the stored bytes back and profile the run from them.
   *
   * Re-reads from disk rather than reusing anything from the upload request: the claim this
   * design makes is that the numbers come from the file the server holds, and holding onto a
   * parse from an earlier request would quietly weaken it to "the numbers come from whatever
   * arrived that one time".
   *
   * Batched, and the last batch says so — that is what moves the run to `profiled`.
   */
  app.post('/api/runs/:runId/profile', async (c) => {
    const scope = await scopeOf(c.req.raw.headers);
    const runId = c.req.param('runId');

    // `read-source-file` is `row:read`, and deliberately so: the bytes ARE raw rows. A caller
    // who may not read the rows may not drive this either.
    const stored = await scope.invoke<{ storage_key: string; content_hash: string }>('tock/read-source-file', { runId });
    const opened = await scope.invoke<{
      format: 'csv' | 'jsonl' | null;
      delimiter: string | null;
      time_field: string | null;
      subject_field: string | null;
    }>('tock/get-run', { runId });

    /**
     * The stored key becomes a PATH, so it is checked before it is used.
     *
     * `receive-run` takes `storageKey` from its caller, and a caller holding `run:manage`
     * could record `../../../etc/passwd`. The declared input now refuses that shape at the
     * boundary, and this refuses it again at the point of use — the row could predate the
     * constraint, or a future writer could reach the table another way, and a path check is
     * cheap next to reading an arbitrary file off the host.
     */
    const filePath = resolve(DATA, stored.storage_key);
    const filesRoot = resolve(FILES);
    if (filePath === filesRoot || !filePath.startsWith(`${filesRoot}${sep}`))
      return c.json({ error: 'the run names a stored file outside this workspace' }, 400);

    const bytes = new Uint8Array(readFileSync(filePath));
    const seen = await contentHashOf(bytes);
    if (seen !== stored.content_hash)
      // The stored bytes are not the bytes the run was opened over. Counting them would put a
      // number under a provenance that does not describe it.
      //
      // Neither digest is echoed: this response is reachable by a caller who chose the path,
      // so printing what was found there would turn a mismatch into a way to fingerprint a
      // file the caller cannot otherwise read.
      return c.json({ error: "the stored file does not match this run's content hash" }, 409);

    // The run's own plan, or the legacy one when it recorded none.
    const plan: ReadPlan =
      opened.format === null
        ? LEGACY_PLAN
        : {
            format: opened.format,
            delimiter: opened.delimiter,
            timeField: opened.time_field ?? '',
            subjectField: opened.subject_field,
          };
    const parsed = parseDeliveredFile(new TextDecoder().decode(bytes), plan);
    let run: Run | undefined;
    for (let i = 0; i < parsed.records.length; i += PROFILE_BATCH) {
      const batch = parsed.records.slice(i, i + PROFILE_BATCH);
      run = await scope.invoke<Run>('tock/profile-run', {
        runId,
        batch,
        final: i + PROFILE_BATCH >= parsed.records.length,
      });
    }
    return c.json({ run, records: parsed.records.length, malformed: parsed.malformed });
  });

  mountApi(app, async (c) => scopeOf(c.req.raw.headers));

  const port = Number(process.env.PORT ?? 8880);
  serve({ fetch: app.fetch, port });
  process.stdout.write(`tock api on :${port} — auth: OIDC · ${login.issuer}\n`);
}

void boot();
