/**
 * Live QA for the channel-folder half of this connector (#2101), against a real Microsoft 365
 * TEST tenant. Run by a person, by hand, following `RUNBOOK.md`. CI never runs it: it is not a
 * vitest file and no script names it.
 *
 * It builds the same world as `test/files.test.ts` (a pure-SQLite scope host, a small documents
 * module that lands changes and emits writes, the write dispatch registered on the host), with the
 * real `fetch` and the person's own app registration in place of the stand-in drive. What it
 * checks is what the stand-in cannot: that Microsoft accepts these requests and answers in the
 * shapes the connector reads.
 *
 * Credentials come from the environment and are only handed to the local host, which seals them in
 * a temporary directory that is removed at the end. Nothing here prints a credential, a token, a
 * tenant or site, or a file or folder name. The paste-back block holds check names, PASS/FAIL,
 * counts, change kinds and timings. Error details go to stderr, marked as not for pasting.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  connectionId,
  moduleManifest,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  type ConnectionId,
} from '@substrat-run/contracts';
import { assertAllowed, globalFetch, ulid, webCryptoSecretBox, type FetchLike, type OperationHandler } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { testOperations } from '@substrat-run/contract-tests';
import {
  GraphError,
  MICROSOFT365_FILES_EVENT,
  bindMicrosoft365Scope,
  listMicrosoft365Bindings,
  microsoft365ChannelChange,
  registerMicrosoft365FilesConnector,
  syncMicrosoft365Scope,
  type Microsoft365Binding,
  type Microsoft365ChannelChange,
  type Microsoft365FilesRequested,
} from '../src/index.js';
import { signedInGraphWith } from '../src/connection.js';
import { GRAPH_BASE, microsoft365Secret } from '../src/credential.js';
import { childrenPage, contentOf, itemUnder, type DriveItem, type GraphClient } from '../src/graph.js';
import { QuickXorHash } from '../src/quickxor.js';

// ── configuration ────────────────────────────────────────────────────────────

const env = (name: string, required = true): string => {
  const value = process.env[name]?.trim() ?? '';
  if (required && !value) {
    console.warn(`missing ${name}: see RUNBOOK.md, step 4`);
    process.exit(2);
  }
  return value;
};
const secret = microsoft365Secret.parse({
  tenantId: env('M365_QA_DIRECTORY_ID'),
  clientId: env('M365_QA_CLIENT_ID'),
  clientSecret: env('M365_QA_CLIENT_SECRET'),
  siteUrl: env('M365_QA_SITE_URL'),
  // Required by the connection's schema; this run never sends mail.
  senders: 'qa@example.invalid',
});
const FOLDER = env('M365_QA_FOLDER');
const DECOY = env('M365_QA_DECOY_NAME', false);
/** How long to wait for a change made in Teams to show in the change feed. */
const WAIT_MS = Number(process.env.M365_QA_WAIT_SECONDS ?? 180) * 1000;

// ── the fetch every request goes through: counted, and able to drop one answer ──

let calls = 0;
/** When set, the first successful request it matches has its answer dropped after Microsoft acted on it. */
let dropAnswer: ((url: string, init?: Parameters<FetchLike>[1]) => boolean) | null = null;
const fetchImpl: FetchLike = async (input, init) => {
  calls += 1;
  const res = await globalFetch(input, init);
  if (dropAnswer && res.ok && dropAnswer(input, init)) {
    dropAnswer = null;
    await res.arrayBuffer().catch(() => undefined);
    throw new Error('qa: the answer to this upload was dropped on purpose');
  }
  return res;
};
const isSimplePut = (url: string, init?: Parameters<FetchLike>[1]) =>
  init?.method === 'PUT' && url.includes('/content?@microsoft.graph.conflictBehavior=');
const isLastChunk = (_url: string, init?: Parameters<FetchLike>[1]) => {
  const range = /^bytes \d+-(\d+)\/(\d+)$/.exec(init?.headers?.['content-range'] ?? '');
  return init?.method === 'PUT' && range !== null && Number(range[1]) === Number(range[2]) - 1;
};

// ── the world ────────────────────────────────────────────────────────────────

const LAND = permissionKey.parse('docs:land');
const ATTACH = permissionKey.parse('docs:attach');
const READ = permissionKey.parse('docs:read');
const SEND = permissionKey.parse('docs:send');
const VERTICAL = 'docs';

const landed: Microsoft365ChannelChange[] = [];
const docsModule = {
  manifest: moduleManifest.parse({
    id: '@qa/docs',
    version: '1.0.0',
    kernelContract: '^0.0.1',
    permissions: [
      { key: 'docs:land', description: 'land a channel change' },
      { key: 'docs:attach', description: 'attach bytes to a doc' },
      { key: 'docs:read', description: 'read a doc and its attachments' },
      { key: 'docs:send', description: 'put a doc in the channel' },
    ],
    events: {
      emits: [
        { type: 'attachment.added', schemaVersion: 1 },
        { type: 'attachment.removed', schemaVersion: 1 },
        { type: MICROSOFT365_FILES_EVENT, schemaVersion: 1 },
      ],
      consumes: [],
    },
    migrations: { journalDir: './migrations', compatibleFrom: '1.0.0' },
    attachmentTargets: [{ entityType: 'doc', readPermission: 'docs:read', writePermission: 'docs:attach' }],
    entitlementKey: VERTICAL,
  }),
  ...testOperations({
    'docs/land': (async (ctx, input: unknown) => {
      assertAllowed(await ctx.check(LAND));
      const change = microsoft365ChannelChange.parse(input);
      landed.push(change);
      if (change.change === 'upsert' && change.content === 'follows') {
        return { entity: { entityType: 'doc', entityId: `d-${change.itemId}` } };
      }
      return { ok: true };
    }) as OperationHandler<never, unknown>,
    'docs/send': (async (ctx, input: Microsoft365FilesRequested) => {
      assertAllowed(await ctx.check(SEND));
      ctx.emit({ type: MICROSOFT365_FILES_EVENT, schemaVersion: 1, entity: { entityType: 'doc', entityId: 'd1' }, piiClass: 'none', payload: input });
      return { ok: true };
    }) as OperationHandler<never, unknown>,
  }),
};

const dir = mkdtempSync(join(tmpdir(), 'substrat-m365-qa-'));
const key = crypto.getRandomValues(new Uint8Array(32));
const options = { fetch: fetchImpl };
// One line per delivery would bury the checks; the checks read the outcome from the ledger instead.
const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('qa', key), fetch: fetchImpl, invocationLineSink: () => {} });
host.registerModule(docsModule);
registerMicrosoft365FilesConnector(host, { ...options, retry: { maxAttempts: 3, baseDelayMs: 0 } });

const staff = platformActorId.parse(ulid());
const t = tenantId.parse(ulid());
const s = scopeId.parse(ulid());
const author = principalId.parse(ulid());
const conn: ConnectionId = connectionId.parse(ulid());
/** This run's own directory under the channel folder: every file it writes goes there. */
const RUN_DIR = `substrat-qa-${ulid().slice(-6).toLowerCase()}`;

// ── reporting ────────────────────────────────────────────────────────────────

const results: string[] = [];
const local = (line: string) => console.warn(`  (local only, do not paste) ${line}`);
const describeError = (e: unknown) =>
  e instanceof GraphError ? `GraphError ${e.status}${e.code ? ` ${e.code}` : ''}` : e instanceof Error ? e.name : typeof e;

async function check(name: string, fn: () => Promise<string>): Promise<boolean> {
  const started = Date.now();
  try {
    const detail = await fn();
    const line = `[${name}] PASS ${detail} (${Date.now() - started} ms)`;
    results.push(line);
    console.log(line);
    return true;
  } catch (e) {
    const line = `[${name}] FAIL ${describeError(e)} (${Date.now() - started} ms)`;
    results.push(line);
    console.log(line);
    local(e instanceof Error ? e.message : String(e));
    return false;
  }
}

function expect(ok: boolean, what: string): asserts ok {
  if (!ok) throw new Error(what);
}

// ── helpers over the live drive ──────────────────────────────────────────────

let client: GraphClient | undefined;
const graphClient = async () => (client ??= await signedInGraphWith(fetchImpl, secret, options));
const binding = async (): Promise<Microsoft365Binding> => {
  const [b] = await listMicrosoft365Bindings(host, conn);
  if (!b) throw new Error('no binding');
  return b;
};
/** The files in this run's directory, by name. */
async function runFiles(): Promise<DriveItem[]> {
  const b = await binding();
  const c = await graphClient();
  const runDir = await itemUnder(c, b.driveId, b.folderItemId, [RUN_DIR]);
  const items: DriveItem[] = [];
  let next: string | null = null;
  do {
    const p = await childrenPage(c, b.driveId, runDir.id, next);
    items.push(...p.items);
    next = p.next;
  } while (next);
  return items.filter((i) => i.file);
}
const quickXor = (bytes: Uint8Array) => {
  const h = new QuickXorHash();
  h.update(bytes);
  return h.digest();
};
const bytesOf = (n: number, seed: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
};
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

let stub: Awaited<ReturnType<typeof host.getScope>>;
let attachments: Awaited<ReturnType<typeof host.attachments>>;
const attach = (filename: string, body: Uint8Array) =>
  attachments.upload({ entity: { entityType: 'doc', entityId: 'd1' }, filename, contentType: 'application/octet-stream', visibility: 'internal', body });
const ledgerKeys = async () => new Set((await host.admin.listConnectorState(conn, 'microsoft365:write:')).map((r) => r.key));

/** Run passes until one completes. Returns the changes landed. */
async function syncToEnd(): Promise<{ changes: number; pages: number; full: boolean }> {
  let changes = 0;
  let pages = 0;
  for (let i = 0; i < 100; i += 1) {
    const r = await syncMicrosoft365Scope(host, conn, await binding(), options);
    changes += r.changes;
    pages += r.pages;
    if (r.complete) return { changes, pages, full: r.full };
  }
  throw new Error('the sync did not complete in 100 calls');
}

/** Sync until `found` sees what it waits for in the changes landed since `from`, or the wait runs out. */
async function syncUntil<T>(from: number, found: (since: Microsoft365ChannelChange[]) => T | undefined): Promise<{ value: T; seconds: number }> {
  const started = Date.now();
  for (;;) {
    await syncToEnd();
    const value = found(landed.slice(from));
    if (value !== undefined) return { value, seconds: Math.round((Date.now() - started) / 1000) };
    if (Date.now() - started > WAIT_MS) throw new Error(`nothing matching within ${WAIT_MS / 1000} s`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

/**
 * Write one file through the host's dispatch, exactly as a vertical's event would. Returns a read of
 * that event's own ledger row (`pending` until a delivery finishes, then `done`).
 */
async function write(name: string, body: Uint8Array, conflict: 'replace' | 'rename' | 'fail') {
  const before = await ledgerKeys();
  const a = await attach(name, body);
  await stub.invoke('docs/send', { directory: RUN_DIR, files: [{ attachmentId: a.id, size: a.size }], conflict });
  const key = [...(await ledgerKeys())].find((k) => !before.has(k));
  if (!key) throw new Error('the write left no ledger row');
  return async () => ((await host.admin.getConnectorState(conn, key)) as { status: string }).status;
}

// ── the run ──────────────────────────────────────────────────────────────────

const prompt = createInterface({ input: process.stdin, output: process.stderr });
const ask = async (what: string) => {
  await prompt.question(`\n>>> ${what}\n    Press Enter when done. `);
};

async function main() {
  await host.admin.createTenant(staff, { id: t, slug: 'qa', name: 'QA' });
  await host.admin.grantEntitlement(staff, t, VERTICAL);
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: VERTICAL });
  await host.admin.activateScope(staff, t, s);
  await host.admin.defineRole(staff, t, { key: 'author', permissions: [READ, ATTACH, SEND], source: 'vertical' });
  await host.admin.assignRole(staff, { principalId: author, roleKey: 'author', node: { tenantId: t, scopeId: s } });
  await host.provisionBlobStore(staff, { tenantId: t, vertical: VERTICAL, binding: 'ATTACHMENTS' });
  await host.admin.createConnection(staff, { id: conn, tenantId: t, vertical: VERTICAL, provider: 'microsoft365', label: 'QA', secret });
  for (const permission of [LAND, ATTACH]) {
    await host.admin.grantToConnection(staff, { connectionId: conn, permission, node: { tenantId: t, scopeId: s }, grantedBy: staff });
  }
  stub = await host.getScope(author, t, s);
  attachments = await host.attachments(author, t, s);
  const bind = (folder: string) =>
    bindMicrosoft365Scope(host, { connectionId: conn, tenantId: t, scopeId: s, vertical: VERTICAL, operation: 'docs/land', permission: 'docs:land', folder }, options);

  console.log(`\nRunning against the channel folder. This run's files go in a folder named ${RUN_DIR} inside it.\n`);

  // 1. The fence on bind, then the bind itself.
  await check('fence-bind', async () => {
    const before = calls;
    const refused = await bind(`${FOLDER}/../x`).then(() => false, () => true);
    expect(refused, 'a dot segment was bound');
    expect(calls === before, `${calls - before} requests were sent`);
    return '0 requests';
  });
  if (!(await check('bind', async () => {
    const b = await bind(FOLDER);
    expect(b.folderItemId.length > 0 && b.driveId.length > 0, 'no folder id');
    return 'folder resolved by its drive path';
  }))) return;

  // 2. The first, full pass over what the channel holds today.
  await check('sync-first', async () => {
    const r = await syncToEnd();
    expect(r.full, 'the first pass was not a full enumeration');
    return `${r.changes} changes, ${r.pages} pages`;
  });

  // 3. Writes: one simple PUT, one upload session. Each is checked on the drive itself.
  const small = bytesOf(64 * 1024, 1);
  const large = bytesOf(6 * 1024 * 1024 + 123, 2);
  for (const [label, name, body] of [['write-put', 'small.bin', small], ['write-session', 'large.bin', large]] as const) {
    await check(label, async () => {
      const status = await write(name, body, 'fail');
      expect((await status()) === 'done', 'the ledger row is not done');
      const item = (await runFiles()).find((i) => i.name === name);
      expect(item !== undefined, 'the file is not in the folder');
      expect(item.size === body.byteLength, 'the size differs');
      expect(item.createdBy?.application?.id === secret.clientId, 'createdBy.application is not this app');
      expect(item.file?.hashes?.quickXorHash === quickXor(body), "SharePoint's quickXorHash differs from ours");
      const b = await binding();
      expect(sameBytes(await contentOf(await graphClient(), b.driveId, item.id, body.byteLength), body), 'the bytes differ');
      return `${body.byteLength} bytes, hash and app match`;
    });
  }

  // 4. Retry: Microsoft writes the file and its answer is lost. The redelivery must adopt it.
  for (const [label, name, body, match] of [
    ['retry-put', 'retry-small.bin', bytesOf(32 * 1024, 3), isSimplePut],
    ['retry-session', 'retry-large.bin', bytesOf(5 * 1024 * 1024 + 7, 4), isLastChunk],
  ] as const) {
    await check(label, async () => {
      dropAnswer = match;
      const status = await write(name, body, 'fail');
      expect(dropAnswer === null, 'no request matched the answer to drop');
      expect((await status()) === 'pending', 'the first delivery did not fail');
      await host.drainDue(t, s);
      expect((await status()) === 'done', 'the redelivery did not finish');
      const copies = (await runFiles()).filter((i) => i.name?.startsWith(name.replace('.bin', ''))).length;
      expect(copies === 1, `${copies} copies`);
      return '1 copy after a redelivery';
    });
  }

  // 5. Collisions with the app's own file from another event.
  await check('conflict-fail', async () => {
    const status = await write('small.bin', bytesOf(1000, 9), 'fail');
    await host.drainDue(t, s);
    expect((await status()) === 'pending', 'a conflicting write finished');
    const files = await runFiles();
    expect(files.filter((i) => i.name === 'small.bin').length === 1 && files.find((i) => i.name === 'small.bin')?.size === small.byteLength, 'the existing file changed');
    return 'refused, existing file kept';
  });
  await check('conflict-rename', async () => {
    const before = (await runFiles()).length;
    const status = await write('small.bin', bytesOf(2000, 10), 'rename');
    expect((await status()) === 'done', 'the ledger row is not done');
    const files = await runFiles();
    expect(files.length === before + 1, `${files.length - before} new files`);
    expect(files.some((i) => /^small \([0-9a-f]{8}\)\.bin$/.test(i.name ?? '')), 'no suffixed name');
    return 'written beside it under a suffixed name';
  });
  await check('conflict-replace', async () => {
    const before = (await runFiles()).length;
    const body = bytesOf(3000, 11);
    await write('small.bin', body, 'replace');
    const files = await runFiles();
    expect(files.length === before, 'the file count changed');
    expect(files.find((i) => i.name === 'small.bin')?.file?.hashes?.quickXorHash === quickXor(body), 'not replaced');
    return 'replaced in place';
  });

  // 6. The sync sees the app's own writes, under the run's directory.
  await check('sync-own-writes', async () => {
    const from = landed.length;
    const { seconds } = await syncUntil(from, (since) => {
      // small, large, the two retried files and the renamed copy.
      const ours = new Set(since.filter((c) => c.change === 'upsert' && c.kind === 'file' && c.path.startsWith(`${RUN_DIR}/`)).map((c) => c.itemId));
      return ours.size >= 5 ? ours.size : undefined;
    });
    return `the run's files arrived within ${seconds} s`;
  });

  // 7. A person's changes in Teams: add, rename, move, delete — each through the sync.
  const fromAdd = landed.length;
  await ask('In Teams, open the channel\'s Files tab and upload one small file (a text file or a PDF) to the channel folder itself.');
  let personal: string | undefined;
  await check('teams-add', async () => {
    const { value, seconds } = await syncUntil(fromAdd, (since) => {
      const content = since.find((c) => c.change === 'content' && !c.path.startsWith(`${RUN_DIR}/`));
      return content?.itemId;
    });
    personal = value;
    return `arrived with its contents within ${seconds} s`;
  });
  if (personal) {
    const id = personal;
    const steps: [string, string, (c: Microsoft365ChannelChange) => boolean][] = [
      ['teams-rename', 'Rename that file in Teams (keep it in the same folder).', (c) => c.change === 'upsert' && c.itemId === id && c.previousPath !== null && !c.path.startsWith(`${RUN_DIR}/`)],
      ['teams-move', `Move that file into the folder named ${RUN_DIR}.`, (c) => c.change === 'upsert' && c.itemId === id && c.previousPath !== null && c.path.startsWith(`${RUN_DIR}/`)],
      ['teams-delete', 'Delete that file in Teams.', (c) => c.change === 'delete' && c.itemId === id],
    ];
    for (const [label, instruction, matches] of steps) {
      const from = landed.length;
      await ask(instruction);
      await check(label, async () => {
        const { value, seconds } = await syncUntil(from, (since) => since.find(matches));
        const kind = value.change === 'delete' ? `reason=${value.reason}` : value.change === 'upsert' ? `content=${value.content}` : 'content';
        return `${value.change} (${kind}) within ${seconds} s`;
      });
    }
  }

  // 8. Nothing from outside the folder.
  if (DECOY) {
    await check('decoy-unseen', async () => {
      expect(!landed.some((c) => c.name === DECOY || c.path.split('/').includes(DECOY)), 'a change named the decoy');
      expect(!JSON.stringify(await host.admin.listConnectorState(conn)).includes(DECOY), "the connector's state names the decoy");
      return `none of ${landed.length} changes, and no stored state`;
    });
  }

  // 9. The fence on a write: refused before any request.
  await check('fence-write', async () => {
    // The refused conflict above is still being retried: let it run out first, so only this event is counted.
    for (let i = 0; i < 3; i += 1) await host.drainDue(t, s);
    const before = calls;
    const a = await attach('fenced.bin', bytesOf(10, 12));
    await stub.invoke('docs/send', { directory: '../outside', files: [{ attachmentId: a.id, size: a.size }], conflict: 'fail' });
    await host.drainDue(t, s);
    expect(calls === before, `${calls - before} requests were sent`);
    return '0 requests';
  });

  // 10. Remove what this run wrote.
  await check('cleanup', async () => {
    const b = await binding();
    const c = await graphClient();
    const runDir = await itemUnder(c, b.driveId, b.folderItemId, [RUN_DIR]);
    const res = await c.fetch(`${GRAPH_BASE}/v1.0/drives/${encodeURIComponent(b.driveId)}/items/${encodeURIComponent(runDir.id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${c.accessToken}` },
    });
    expect(res.status === 204, `DELETE answered ${res.status}`);
    return "the run's folder is in the site's recycle bin";
  });
}

try {
  await main();
} finally {
  prompt.close();
  rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((l) => l.includes('] FAIL ')).length;
  console.log('\n==== PASTE BACK FROM HERE ====');
  console.log(`microsoft365 channel-folder QA · ${results.length} checks, ${failed} failed · ${calls} requests`);
  for (const line of results) console.log(line);
  console.log('==== PASTE BACK TO HERE ====');
}
