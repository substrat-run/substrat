import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
import { assertAllowed, ulid, webCryptoSecretBox, type OperationHandler } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { testOperations } from '@substrat-run/contract-tests';
import {
  MAX_FILE_BYTES,
  MICROSOFT365_FILES_EVENT,
  bindMicrosoft365Scope,
  listMicrosoft365Bindings,
  unbindMicrosoft365Scope,
  SYNC_TIMEOUT_MS,
  microsoft365ChannelChange,
  microsoft365FilesRequested,
  registerMicrosoft365FilesConnector,
  syncMicrosoft365Scope,
  sweepMicrosoft365Files,
  withSuffix,
  type Microsoft365ChannelChange,
  type Microsoft365FilesRequested,
} from '../src/index.js';
import { APP_ID, FakeDrive, GRAPH, LOGIN } from './fake-drive.js';

/**
 * One Teams channel's folder, end to end on the pure adapter (#2101): a real scope with a vertical
 * module, a real connection and its grants, the dispatch run by the host, and the sync landing
 * through the vertical's own operation — against `FakeDrive`, a stand-in for Graph and one
 * document library. No network: the drive is the only fetch either side has.
 */

const LAND = permissionKey.parse('docs:land');
const ATTACH = permissionKey.parse('docs:attach');
const READ = permissionKey.parse('docs:read');
const SEND = permissionKey.parse('docs:send');

/** Words that live only OUTSIDE the bound folder: none may reach state, a payload or a log. */
const OUTSIDE_NAMES = ['Board-salaries.xlsx', 'Leadership', 'Moved-away-secret.docx'];

/** The paths a vertical holds after applying `changes` in order to `start`, by item id. */
function mirror(start: Map<string, string>, changes: Microsoft365ChannelChange[]): Map<string, string> {
  const held = new Map(start);
  for (const c of changes) {
    if (c.change === 'upsert') held.set(c.itemId, c.path);
    if (c.change === 'delete') held.delete(c.itemId);
  }
  return held;
}

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});

async function world(opts: { grantLand?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'substrat-m365-files-'));
  const drive = new FakeDrive();
  const general = drive.mkdir('root', 'General');
  const leadership = drive.mkdir('root', 'Leadership');
  drive.put(leadership, 'Board-salaries.xlsx', 'not for this binding');

  const landed: Microsoft365ChannelChange[] = [];
  /** Throw from the landing operation for the item whose name matches, once. */
  const failOn = { name: null as string | null };
  const docsMod = {
    manifest: moduleManifest.parse({
      id: '@test/docs',
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
      entitlementKey: 'docs',
    }),
    ...testOperations({
      'docs/land': (async (ctx, input: unknown) => {
        assertAllowed(await ctx.check(LAND));
        const change = microsoft365ChannelChange.parse(input);
        if (failOn.name && change.name === failOn.name) {
          failOn.name = null;
          throw new Error('landing failed once');
        }
        landed.push(change);
        if (change.change === 'upsert' && change.content === 'follows') {
          return { entity: { entityType: 'doc', entityId: `d-${change.itemId}` } };
        }
        return { ok: true };
      }) as OperationHandler<never, unknown>,
      'docs/send': (async (ctx, input: Microsoft365FilesRequested) => {
        assertAllowed(await ctx.check(SEND));
        ctx.emit({
          type: MICROSOFT365_FILES_EVENT,
          schemaVersion: 1,
          entity: { entityType: 'doc', entityId: 'd1' },
          piiClass: 'none',
          payload: input,
        });
        return { ok: true };
      }) as OperationHandler<never, unknown>,
    }),
  };

  const options = { fetch: drive.fetch, loginBase: LOGIN, graphBase: GRAPH, now: () => drive.now };
  const host = new SqliteScopeHost({ dir, secretBox: webCryptoSecretBox('k', new Uint8Array(32).fill(5)), fetch: drive.fetch });
  host.registerModule(docsMod);
  registerMicrosoft365FilesConnector(host, { ...options, retry: { maxAttempts: 5, baseDelayMs: 0 } });

  const staff = platformActorId.parse(ulid());
  const t = tenantId.parse(ulid());
  const s = scopeId.parse(ulid());
  const author = principalId.parse(ulid());
  await host.admin.createTenant(staff, { id: t, slug: 'acme', name: 'Acme' });
  await host.admin.grantEntitlement(staff, t, 'docs');
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'docs' });
  await host.admin.activateScope(staff, t, s);
  await host.admin.defineRole(staff, t, { key: 'author', permissions: [READ, ATTACH, SEND], source: 'vertical' });
  await host.admin.assignRole(staff, { principalId: author, roleKey: 'author', node: { tenantId: t, scopeId: s } });
  await host.provisionBlobStore(staff, { tenantId: t, vertical: 'docs', binding: 'ATTACHMENTS' });

  const conn: ConnectionId = connectionId.parse(ulid());
  await host.admin.createConnection(staff, {
    id: conn,
    tenantId: t,
    vertical: 'docs',
    provider: 'microsoft365',
    label: 'Acme Microsoft 365',
    secret: {
      tenantId: '11111111-2222-3333-4444-555555555555',
      clientId: APP_ID,
      senders: 'office@acme.example',
      siteUrl: 'https://acme.sharepoint.com/sites/Team',
      clientSecret: 'test-client-secret-value',
    },
  });
  const grant = (permission: typeof LAND) =>
    host.admin.grantToConnection(staff, { connectionId: conn, permission, node: { tenantId: t, scopeId: s }, grantedBy: staff });
  if (opts.grantLand !== false) {
    await grant(LAND);
    await grant(ATTACH);
  }

  const stub = await host.getScope(author, t, s);
  const attachments = await host.attachments(author, t, s);
  const attach = async (filename: string, body: string | Uint8Array) =>
    attachments.upload({
      entity: { entityType: 'doc', entityId: 'd1' },
      filename,
      contentType: 'text/plain',
      visibility: 'internal',
      body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
    });

  const bind = (folder = 'General') =>
    bindMicrosoft365Scope(
      host,
      { connectionId: conn, tenantId: t, scopeId: s, vertical: 'docs', operation: 'docs/land', permission: 'docs:land', folder },
      options,
    );
  const sync = async (maxPages?: number, maxVerify?: number) => {
    const [binding] = await listMicrosoft365Bindings(host, conn);
    return syncMicrosoft365Scope(host, conn, binding!, { ...options, ...(maxPages ? { maxPages } : {}), ...(maxVerify ? { maxVerify } : {}) });
  };
  const send = (payload: Microsoft365FilesRequested) => stub.invoke('docs/send', payload);
  const state = async () => JSON.stringify(await host.admin.listConnectorState(conn));
  const ledgers = async () =>
    (await host.admin.listConnectorState(conn, 'microsoft365:write:')).map((r) => r.value as { status: string; files: unknown[] });

  return { host, drive, general, leadership, landed, failOn, staff, t, s, conn, grant, stub, attachments, bind, sync, send, state, ledgers, attach, options };
}

describe('binding a channel folder', () => {
  it('resolves the folder by its drive path and keeps its id', async () => {
    const w = await world();
    const binding = await w.bind('/General/');
    expect(binding).toMatchObject({ folder: 'General', driveId: 'drive-1', folderItemId: w.general, operation: 'docs/land' });
  });

  it('refuses a missing grant before calling Graph', async () => {
    const w = await world({ grantLand: false });
    await expect(w.bind()).rejects.toThrow(/does not hold 'docs:land'/);
    expect(w.drive.calls).toEqual([]);
  });

  it('refuses the library root, a file, a missing folder and a path outside the grammar', async () => {
    const w = await world();
    w.drive.put(w.general, 'notes.txt', 'x');
    await expect(w.bind('/')).rejects.toThrow(/library root is not one/);
    await expect(w.bind('General/notes.txt')).rejects.toThrow(/is not a folder/);
    await expect(w.bind('Nope')).rejects.toThrow(/no folder at 'Nope'/);
    const before = w.drive.graphCalls().length;
    await expect(w.bind('General/../Leadership')).rejects.toThrow(/dot segment/);
    expect(w.drive.graphCalls().length).toBe(before);
    expect(await listMicrosoft365Bindings(w.host, w.conn)).toEqual([]);
  });
});

describe('writes: a vertical puts files in the channel', () => {
  it('uploads the attachments the event names into the folder', async () => {
    const w = await world();
    await w.bind();
    const a = await w.attach('offer.pdf', 'the offer');
    const b = await w.attach('terms.txt', 'the terms');
    await w.send({ directory: 'Offers/2026', files: [{ attachmentId: a.id, size: a.size }, { attachmentId: b.id, size: b.size, name: 'Terms.txt' }], conflict: 'fail' });
    const offers = w.drive.childrenNamed(w.general);
    expect(offers).toEqual(['Offers']);
    expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'done', files: expect.arrayContaining([expect.anything(), expect.anything()]) })]);
    // Addressed under the folder's id, never by a path from the library root.
    const puts = w.drive.graphCalls().filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    for (const p of puts) expect(p.url).toContain(`/drives/drive-1/items/${w.general}:/Offers/2026/`);
  });

  it.each(['replace', 'rename', 'fail'] as const)(
    'a redelivery after the upload but before the ledger write leaves one copy (%s)',
    async (conflict) => {
      const w = await world();
      await w.bind();
      const a = await w.attach('report.pdf', 'v1');
      // Graph writes the file and the answer is lost: the window between the upload and the
      // ledger row that records it.
      w.drive.lostAnswers.push({ when: (c) => c.method === 'PUT', once: true });
      await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict });
      expect(w.drive.childrenNamed(w.general)).toEqual(['report.pdf']);
      expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'pending', files: [] })]);
      await w.host.drainDue(w.t, w.s);
      expect(w.drive.childrenNamed(w.general)).toEqual(['report.pdf']);
      expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'done' })]);
    },
  );

  it("rename never overwrites a person's file, and its second name is stable across a redelivery", async () => {
    const w = await world();
    await w.bind();
    w.drive.put(w.general, 'report.pdf', "a person's report");
    const a = await w.attach('report.pdf', 'ours');
    // The suffixed write lands and its answer is lost.
    w.drive.lostAnswers.push({ when: (c) => c.method === 'PUT' && c.url.includes('report%20('), once: true });
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'rename' });
    await w.host.drainDue(w.t, w.s);
    const names = w.drive.childrenNamed(w.general);
    expect(names).toHaveLength(2);
    expect(names).toContain('report.pdf');
    const ours = names.find((n) => n !== 'report.pdf')!;
    expect(ours).toMatch(/^report \([0-9a-f]{8}\)\.pdf$/);
    expect(w.drive.text(w.general, 'report.pdf')).toBe("a person's report");
    expect(w.drive.text(w.general, ours)).toBe('ours');
    expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'done' })]);
  });

  it("fail refuses a person's file of the same name, and never adopts it", async () => {
    const w = await world();
    await w.bind();
    w.drive.put(w.general, 'report.pdf', "a person's report");
    const a = await w.attach('report.pdf', 'ours');
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'fail' });
    await w.host.drainDue(w.t, w.s);
    expect(w.drive.text(w.general, 'report.pdf')).toBe("a person's report");
    expect(w.drive.childrenNamed(w.general)).toEqual(['report.pdf']);
    expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'pending', files: [] })]);
  });

  // r1 blocker: the app's OWN earlier file, from another event, is not this event's lost upload.
  it("fail keeps refusing the app's own earlier file from another event, on every redelivery", async () => {
    const w = await world();
    await w.bind();
    const a = await w.attach('report.pdf', 'from event A');
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'fail' });
    const b = await w.attach('report.pdf', 'from event B');
    await w.send({ files: [{ attachmentId: b.id, size: b.size }], conflict: 'fail' });
    await w.host.drainDue(w.t, w.s);
    await w.host.drainDue(w.t, w.s);
    expect(w.drive.childrenNamed(w.general)).toEqual(['report.pdf']);
    expect(w.drive.text(w.general, 'report.pdf')).toBe('from event A');
    const statuses = (await w.ledgers()).map((l) => l.status).sort();
    expect(statuses).toEqual(['done', 'pending']);
  });

  it("rename writes its own copy after a throttled retry, never adopting the app's earlier file", async () => {
    const w = await world();
    await w.bind();
    const a = await w.attach('report.pdf', 'from event A');
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'rename' });
    const b = await w.attach('report.pdf', 'from event B');
    // B's suffixed PUT is throttled once: no write happens, and the retry must still write B.
    w.drive.failures.push({ when: (c) => c.method === 'PUT' && c.url.includes('report%20('), status: 503, once: true });
    await w.send({ files: [{ attachmentId: b.id, size: b.size }], conflict: 'rename' });
    await w.host.drainDue(w.t, w.s);
    const names = w.drive.childrenNamed(w.general);
    expect(names).toHaveLength(2);
    const second = names.find((n) => n !== 'report.pdf')!;
    expect(w.drive.text(w.general, 'report.pdf')).toBe('from event A');
    expect(w.drive.text(w.general, second)).toBe('from event B');
    expect((await w.ledgers()).map((l) => l.status)).toEqual(['done', 'done']);
  });

  it('a redelivery whose lost upload came back changed is a conflict, not adopted (fail)', async () => {
    const w = await world();
    await w.bind();
    const a = await w.attach('report.pdf', 'as sent');
    w.drive.lostAnswers.push({ when: (c) => c.method === 'PUT', once: true });
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'fail' });
    // As SharePoint does to an Office document: the stored bytes are no longer the sent ones.
    w.drive.tamper(w.general, 'report.pdf', 'as stored');
    await w.host.drainDue(w.t, w.s);
    expect(w.drive.childrenNamed(w.general)).toEqual(['report.pdf']);
    expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'pending', files: [] })]);
  });

  it('replace overwrites, and says so in the event', async () => {
    const w = await world();
    await w.bind();
    w.drive.put(w.general, 'report.pdf', 'old');
    const a = await w.attach('report.pdf', 'new');
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'replace' });
    expect(w.drive.text(w.general, 'report.pdf')).toBe('new');
  });

  it('sends a file over 4 MB by upload session, without the token on the upload URL', async () => {
    const w = await world();
    await w.bind();
    const big = new Uint8Array(5 * 1024 * 1024).fill(7);
    const a = await w.attach('drawing.bin', big);
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'fail' });
    const chunks = w.drive.calls.filter((c) => c.url.startsWith('https://upload.example/'));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.headers.authorization).toBeUndefined();
    expect(w.drive.childrenNamed(w.general)).toEqual(['drawing.bin']);
  });

  it('cancels a failed upload session and starts a fresh one on the redelivery', async () => {
    const w = await world();
    await w.bind();
    const a = await w.attach('drawing.bin', new Uint8Array(5 * 1024 * 1024).fill(9));
    w.drive.failures.push({ when: (c) => c.url.startsWith('https://upload.example/') && c.method === 'PUT' && c.headers['content-range']?.startsWith('bytes 3276800-') === true, status: 503, once: true });
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'fail' });
    expect(w.drive.calls.some((c) => c.method === 'DELETE' && c.url.startsWith('https://upload.example/'))).toBe(true);
    expect(w.drive.openSessions()).toBe(0);
    expect(w.drive.childrenNamed(w.general)).toEqual([]);
    await w.host.drainDue(w.t, w.s);
    expect(w.drive.childrenNamed(w.general)).toEqual(['drawing.bin']);
  });

  it('refuses a file over the size cap before Graph is called', async () => {
    const w = await world();
    await w.bind();
    const a = await w.attach('huge.bin', new Uint8Array(MAX_FILE_BYTES + 1));
    const before = w.drive.calls.length;
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'fail' });
    expect(w.drive.calls.length).toBe(before);
    expect(await w.ledgers()).toEqual([]);
  });

  it('refuses an attachment owned by an entity the event does not name', async () => {
    const w = await world();
    await w.bind();
    const elsewhere = await w.attachments.upload({
      entity: { entityType: 'doc', entityId: 'd2' },
      filename: 'elsewhere.txt',
      contentType: 'text/plain',
      visibility: 'internal',
      body: new TextEncoder().encode('x'),
    });
    // The event names doc d1; the delivery is authority for d1's attachments only.
    await w.send({ files: [{ attachmentId: elsewhere.id, size: elsewhere.size }], conflict: 'fail' });
    expect(w.drive.graphCalls().filter((c) => c.method === 'PUT')).toEqual([]);
    expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'pending', files: [] })]);
  });

  describe('the fence refuses before Graph is called', () => {
    const outside: [string, { directory?: string; name?: string }][] = [
      ['a dot-dot directory', { directory: '..' }],
      ['dot-dot inside the directory', { directory: 'Offers/../../Leadership' }],
      ['an encoded dot-dot', { directory: '%2e%2e' }],
      ['an absolute directory', { directory: '/Leadership' }],
      ['a backslash', { directory: 'Offers\\..\\Leadership' }],
      ['an empty segment', { directory: 'Offers//2026' }],
      ['a trailing slash', { directory: 'Offers/' }],
      ['a fullwidth solidus', { directory: '..／Leadership' }],
      ['fullwidth dots', { directory: '．．' }],
      ['a two-dot leader', { directory: '‥' }],
      ['a division slash', { directory: 'a∕b' }],
      ['a trailing dot', { directory: 'Offers.' }],
      ['a trailing space', { directory: 'Offers ' }],
      ['a name that is not NFC', { directory: 'Café' }],
      ['a dot-dot file name', { name: '..' }],
      ['a file name with a slash', { name: '../secret.txt' }],
      ['a reserved device name', { name: 'CON.txt' }],
      ['a file name with a colon', { name: 'a:b.txt' }],
    ];
    it.each(outside)('%s', async (_label, over) => {
      const w = await world();
      await w.bind();
      const a = await w.attach('ok.txt', 'x');
      const before = w.drive.calls.length;
      await w.send({
        ...(over.directory === undefined ? {} : { directory: over.directory }),
        files: [{ attachmentId: a.id, size: a.size, ...(over.name === undefined ? {} : { name: over.name }) }],
        conflict: 'replace',
      });
      expect(w.drive.calls.length).toBe(before);
      expect(await w.ledgers()).toEqual([]);
      expect(w.drive.childrenNamed('root')).toEqual(['General', 'Leadership']);
    });

    it('admits an NFC name with accents and a directory under the folder (the positive twin)', async () => {
      const w = await world();
      await w.bind();
      const a = await w.attach('Café menu.txt', 'x');
      await w.send({ directory: 'Kök/2026', files: [{ attachmentId: a.id, size: a.size }], conflict: 'fail' });
      expect(w.drive.childrenNamed(w.general)).toEqual(['Kök']);
    });
  });

  it('refuses a write when no folder is bound', async () => {
    const w = await world();
    const a = await w.attach('ok.txt', 'x');
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'fail' });
    expect(w.drive.graphCalls().filter((c) => c.method === 'PUT')).toEqual([]);
  });
});

describe('reads: the sync lands what is in the folder', () => {
  it('lands the folder and its files, with bytes, and nothing from outside it', async () => {
    const w = await world();
    const sub = w.drive.mkdir(w.general, 'Minutes');
    w.drive.put(w.general, 'agenda.txt', 'agenda');
    w.drive.put(sub, 'm1.txt', 'minutes one');
    await w.bind();
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const r = await w.sync();
    expect(r).toMatchObject({ changes: 3, full: true });
    expect(w.landed.filter((c) => c.change === 'upsert').map((c) => c.path).sort()).toEqual(['Minutes', 'Minutes/m1.txt', 'agenda.txt']);
    const contents = w.landed.filter((c) => c.change === 'content');
    expect(contents.map((c) => c.path).sort()).toEqual(['Minutes/m1.txt', 'agenda.txt']);
    const opened = await w.attachments.list({ entityType: 'doc', entityId: `d-${contents[0]!.itemId}` });
    expect(opened).toHaveLength(1);

    // Outside the folder: in no landed change, no connector-state row, no log line.
    const everything = JSON.stringify(w.landed) + (await w.state()) + JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    for (const name of OUTSIDE_NAMES) expect(everything).not.toContain(name);
    expect(everything).not.toContain(w.leadership);
  });

  it('follows adds, edits, renames, moves and deletes from Teams', async () => {
    const w = await world();
    const sub = w.drive.mkdir(w.general, 'Minutes');
    const agenda = w.drive.put(w.general, 'agenda.txt', 'agenda');
    const m1 = w.drive.put(sub, 'm1.txt', 'minutes one');
    const leaving = w.drive.put(w.general, 'Moved-away-secret.docx', 'leaving');
    const incoming = w.drive.mkdir(w.leadership, 'Shared-plans');
    w.drive.put(incoming, 'plan.txt', 'the plan');
    await w.bind();
    await w.sync();
    const before = mirror(new Map(), w.landed);
    w.landed.length = 0;

    w.drive.put(w.general, 'new.txt', 'new');
    w.drive.edit(agenda, 'agenda v2');
    w.drive.rename(sub, 'Meeting minutes');
    w.drive.remove(m1);
    w.drive.move(leaving, w.leadership);
    w.drive.move(incoming, w.general);
    const r = await w.sync();
    expect(r.full).toBe(false);

    // What the vertical holds once it has applied every change in order — the oracle, since a pass
    // landed page by page may say a renamed folder's child moved before it says the child is gone.
    expect([...mirror(before, w.landed).values()].sort()).toEqual(['Meeting minutes', 'Shared-plans', 'Shared-plans/plan.txt', 'agenda.txt', 'new.txt']);
    const deletes = w.landed.filter((c) => c.change === 'delete');
    expect(deletes.map((c) => c.itemId).sort()).toEqual([leaving, m1].sort());
    expect(deletes.find((c) => c.itemId === leaving)).toMatchObject({ reason: 'moved-out' });
    expect(deletes.find((c) => c.itemId === m1)).toMatchObject({ reason: 'deleted' });
    expect(w.landed.find((c) => c.change === 'upsert' && c.path === 'Meeting minutes')).toMatchObject({ previousPath: 'Minutes' });
    expect(w.landed.find((c) => c.change === 'upsert' && c.path === 'agenda.txt')).toMatchObject({ content: 'follows' });
    const edited = w.landed.find((c) => c.change === 'content' && c.path === 'agenda.txt');
    expect(edited).toMatchObject({ replaces: expect.any(String) });

    // Where the moved file went is not the binding's to say.
    const everything = JSON.stringify(w.landed) + (await w.state());
    expect(everything).not.toContain('Leadership');
  });

  it('a folder delete lands its held children as deleted', async () => {
    const w = await world();
    const sub = w.drive.mkdir(w.general, 'Minutes');
    w.drive.put(sub, 'm1.txt', 'one');
    await w.bind();
    await w.sync();
    w.landed.length = 0;
    w.drive.remove(sub);
    await w.sync();
    expect(w.landed.map((c) => [c.change, c.path, c.change === 'delete' ? c.reason : null])).toEqual([
      ['delete', 'Minutes/m1.txt', 'deleted'],
      ['delete', 'Minutes', 'deleted'],
    ]);
  });

  it('an unchanged folder lands nothing on the next pass', async () => {
    const w = await world();
    w.drive.put(w.general, 'agenda.txt', 'agenda');
    await w.bind();
    await w.sync();
    w.landed.length = 0;
    expect(await w.sync()).toMatchObject({ changes: 0 });
    expect(w.landed).toEqual([]);
  });

  it('a pass that fails part-way is read again, and lands nothing twice', async () => {
    const w = await world();
    w.drive.put(w.general, 'a.txt', 'a');
    w.drive.put(w.general, 'b.txt', 'b');
    w.drive.put(w.general, 'c.txt', 'c');
    await w.bind();
    w.failOn.name = 'b.txt';
    await expect(w.sync()).rejects.toThrow(/landing failed once/);
    expect((await listMicrosoft365Bindings(w.host, w.conn))[0]!.deltaLink).toBeUndefined();
    await w.sync();
    const upserts = w.landed.filter((c) => c.change === 'upsert').map((c) => c.name).sort();
    expect(upserts).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });

  describe('a pass is landed page by page', () => {
    const upsertsByItem = (landed: Microsoft365ChannelChange[]) => {
      const counts = new Map<string, number>();
      for (const c of landed) if (c.change === 'upsert') counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
      return counts;
    };

    it('a pass over its page budget resumes where it stopped, landing each item once', async () => {
      const w = await world();
      for (let i = 0; i < 8; i += 1) w.drive.put(w.general, `f${i}.txt`, `file ${i}`);
      await w.bind();
      const calls: boolean[] = [];
      for (let n = 0; n < 20; n += 1) {
        const r = await w.sync(1);
        calls.push(r.complete);
        if (r.complete) break;
        // Between calls the binding holds where to resume, and nothing about outside items.
        const [binding] = await listMicrosoft365Bindings(w.host, w.conn);
        expect(binding!.pass?.next).toEqual(expect.stringContaining('/root/delta'));
        expect(binding!.deltaLink).toBeUndefined();
        for (const name of OUTSIDE_NAMES) expect(await w.state()).not.toContain(name);
      }
      expect(calls.length).toBeGreaterThan(2);
      expect(calls.at(-1)).toBe(true);
      const counts = upsertsByItem(w.landed);
      expect([...counts.keys()].sort()).toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'f6.txt', 'f7.txt']);
      expect([...counts.values()].every((n) => n === 1)).toBe(true);
      expect(w.landed.filter((c) => c.change === 'content')).toHaveLength(8);
      expect(w.landed.some((c) => c.change === 'delete')).toBe(false);
    });

    it('a pass that crashes mid-way resumes from the last landed page, not the start', async () => {
      const w = await world();
      for (let i = 0; i < 8; i += 1) w.drive.put(w.general, `f${i}.txt`, `file ${i}`);
      await w.bind();
      w.failOn.name = 'f5.txt';
      await expect(w.sync()).rejects.toThrow(/landing failed once/);
      const [binding] = await listMicrosoft365Bindings(w.host, w.conn);
      expect(binding!.pass?.next).toEqual(expect.stringContaining('skip='));
      const firstPageReads = () => w.drive.calls.filter((c) => c.url.includes('/root/delta') && !c.url.includes('skip=')).length;
      expect(firstPageReads()).toBe(1);
      expect(await w.sync()).toMatchObject({ complete: true });
      expect(firstPageReads()).toBe(1);
      const counts = upsertsByItem(w.landed);
      expect(counts.size).toBe(8);
      expect([...counts.values()].every((n) => n === 1)).toBe(true);
    });

    it('a resync lands what it never saw as deleted only once the whole enumeration has been read', async () => {
      const w = await world();
      const keep = w.drive.put(w.general, 'keep.txt', 'keep');
      for (let i = 0; i < 6; i += 1) w.drive.put(w.general, `f${i}.txt`, 'x');
      const gone = w.drive.put(w.general, 'gone.txt', 'gone');
      await w.bind();
      await w.sync();
      w.landed.length = 0;
      w.drive.remove(gone);
      w.drive.expiredBefore = Number.MAX_SAFE_INTEGER;
      let r = await w.sync(1);
      expect(r).toMatchObject({ full: true, complete: false });
      expect(w.landed).toEqual([]);
      while (!r.complete) r = await w.sync(1);
      expect(w.landed).toEqual([expect.objectContaining({ change: 'delete', itemId: gone, reason: 'deleted' })]);
      expect(w.landed.some((c) => c.itemId === keep)).toBe(false);
    });

    // CodeRabbit on #2353: a pass in flight must not write back a binding the operator changed.
    it('an unbind while a pass runs stays unbound', async () => {
      const w = await world();
      for (let i = 0; i < 8; i += 1) w.drive.put(w.general, `f${i}.txt`, 'x');
      await w.bind();
      let once = true;
      w.drive.onRequest = async (c) => {
        if (once && c.url.includes('/root/delta') && c.url.includes('skip=')) {
          once = false;
          await unbindMicrosoft365Scope(w.host, w.conn, w.s);
        }
      };
      expect(await w.sync()).toMatchObject({ complete: false, superseded: true });
      expect(await listMicrosoft365Bindings(w.host, w.conn)).toEqual([]);
    });

    it('a re-bind to another folder while a pass runs keeps the new folder', async () => {
      const w = await world();
      for (let i = 0; i < 8; i += 1) w.drive.put(w.general, `f${i}.txt`, 'x');
      const other = w.drive.mkdir('root', 'Other');
      await w.bind();
      let once = true;
      w.drive.onRequest = async (c) => {
        if (once && c.url.includes('/root/delta') && c.url.includes('skip=')) {
          once = false;
          w.drive.onRequest = null;
          await w.bind('Other');
        }
      };
      expect(await w.sync()).toMatchObject({ superseded: true });
      const [binding] = await listMicrosoft365Bindings(w.host, w.conn);
      expect(binding).toMatchObject({ folder: 'Other', folderItemId: other });
      expect(binding!.pass).toBeUndefined();
      expect(binding!.deltaLink).toBeUndefined();
    });

    it('gives a sync request time for a file at the cap, not the connection default', async () => {
      const w = await world();
      w.drive.put(w.general, 'a.txt', 'a');
      await w.bind();
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      await w.sync();
      expect(timeout).toHaveBeenCalled();
      expect(new Set(timeout.mock.calls.map(([ms]) => ms))).toEqual(new Set([SYNC_TIMEOUT_MS]));
    });

    // r2 #1: an enumeration spanning many calls may miss a live item; it is checked, not deleted.
    it('a resync that misses a live item checks it, and does not land it as deleted', async () => {
      const w = await world();
      const ids = ['a', 'b', 'c', 'd', 'e'].map((n) => w.drive.put(w.general, `${n}.txt`, n));
      await w.bind();
      await w.sync();
      w.landed.length = 0;
      w.drive.expiredBefore = Number.MAX_SAFE_INTEGER;
      w.drive.pageSize = 1;
      let calls = 0;
      for (let r = await w.sync(1); !r.complete; r = await w.sync(1)) {
        calls += 1;
        // The enumeration's pages shift under it, as the reviewer showed with the stand-in.
        if (calls === 6) w.drive.rename(ids[0]!, 'a-renamed.txt');
        expect(calls).toBeLessThan(40);
      }
      expect(w.landed.filter((c) => c.change === 'delete')).toEqual([]);
      w.drive.expiredBefore = 0;
      await w.sync();
      expect(w.landed.filter((c) => c.change === 'delete')).toEqual([]);
      expect(w.drive.childrenNamed(w.general)).toContain('c.txt');
    });

    it('a verification that cannot reach the drive stops the pass and deletes nothing', async () => {
      const w = await world();
      const gone = w.drive.put(w.general, 'gone.txt', 'gone');
      w.drive.put(w.general, 'keep.txt', 'keep');
      await w.bind();
      await w.sync();
      w.landed.length = 0;
      w.drive.remove(gone);
      w.drive.expiredBefore = Number.MAX_SAFE_INTEGER;
      w.drive.failures.push({ when: (c) => c.url.includes(`/items/${gone}?`), status: 503, once: true });
      await expect(w.sync()).rejects.toThrow(/injected 503/);
      expect(w.landed).toEqual([]);
      expect((await listMicrosoft365Bindings(w.host, w.conn))[0]!.pass?.verify?.queue).toEqual([gone]);
      expect(await w.sync()).toMatchObject({ complete: true });
      expect(w.landed).toEqual([expect.objectContaining({ change: 'delete', itemId: gone, reason: 'deleted' })]);
    });

    it('a large verification resumes across calls under its budget', async () => {
      const w = await world();
      const gone = [0, 1, 2, 3].map((i) => w.drive.put(w.general, `g${i}.txt`, 'x'));
      await w.bind();
      await w.sync();
      w.landed.length = 0;
      for (const id of gone) w.drive.remove(id);
      w.drive.expiredBefore = Number.MAX_SAFE_INTEGER;
      const results = [];
      for (let r = await w.sync(undefined, 1); ; r = await w.sync(undefined, 1)) {
        results.push(r.complete);
        if (r.complete) break;
      }
      expect(results.length).toBeGreaterThan(3);
      expect(w.landed.map((c) => c.itemId).sort()).toEqual([...gone].sort());
    });

    // r2 #2: a held file moved into a new folder the feed presents on a LATER page.
    it('a held file moved into a folder presented later is moved, never deleted or downloaded again', async () => {
      const w = await world();
      const held = w.drive.put(w.general, 'held.txt', 'held');
      await w.bind();
      await w.sync();
      w.landed.length = 0;
      const fresh = w.drive.mkdir(w.general, 'New');
      w.drive.move(held, fresh);
      // The folder changes after the file, so the feed presents the file first.
      w.drive.rename(fresh, 'New folder');
      w.drive.pageSize = 1;
      const downloadsBefore = w.drive.calls.filter((c) => c.url.includes(`/items/${held}/content`)).length;
      while (!(await w.sync(1)).complete);
      expect(w.landed.filter((c) => c.change === 'delete')).toEqual([]);
      expect(w.landed.find((c) => c.change === 'upsert' && c.itemId === held)).toMatchObject({
        path: 'New folder/held.txt',
        previousPath: 'held.txt',
        content: 'unchanged',
      });
      expect(w.drive.calls.filter((c) => c.url.includes(`/items/${held}/content`)).length).toBe(downloadsBefore);
    });

    it('a held file moved out of the folder lands as moved-out once the pass has checked it', async () => {
      const w = await world();
      const held = w.drive.put(w.general, 'held.txt', 'held');
      await w.bind();
      await w.sync();
      w.landed.length = 0;
      w.drive.move(held, w.leadership);
      await w.sync();
      expect(w.landed).toEqual([expect.objectContaining({ change: 'delete', itemId: held, reason: 'moved-out' })]);
      for (const name of OUTSIDE_NAMES) expect(await w.state()).not.toContain(name);
    });

    // r2 #3: a new folder's subtree is read a page at a time, under the same budget as the feed.
    it('a nested subtree lands a page per call, never the whole tree in one', async () => {
      const w = await world();
      const a = w.drive.mkdir(w.general, 'A');
      const b = w.drive.mkdir(a, 'B');
      for (let i = 0; i < 30; i += 1) w.drive.put(b, `f${i}.txt`, `file ${i}`);
      await w.bind();
      const content = () => w.drive.calls.filter((c) => /\/items\/[^/]+\/content$/.test(new URL(c.url).pathname)).length;
      let calls = 0;
      for (;;) {
        const landedBefore = w.landed.filter((c) => c.change === 'upsert').length;
        const downloadsBefore = content();
        const r = await w.sync(1);
        calls += 1;
        expect(w.landed.filter((c) => c.change === 'upsert').length - landedBefore).toBeLessThanOrEqual(w.drive.pageSize);
        expect(content() - downloadsBefore).toBeLessThanOrEqual(w.drive.pageSize);
        if (r.complete) break;
        expect(calls).toBeLessThan(80);
      }
      const counts = new Map<string, number>();
      for (const c of w.landed) if (c.change === 'upsert') counts.set(c.itemId, (counts.get(c.itemId) ?? 0) + 1);
      expect(counts.size).toBe(32);
      expect([...counts.values()].every((n) => n === 1)).toBe(true);
      expect(w.landed.some((c) => c.change === 'delete')).toBe(false);
    });

    it('a file the feed presents before its folder still lands', async () => {
      const w = await world();
      const late = w.drive.mkdir(w.general, 'Late');
      w.drive.put(late, 'early.txt', 'early');
      // The folder changes after its child, so a full enumeration presents the child first.
      w.drive.rename(late, 'Late folder');
      w.drive.pageSize = 1;
      await w.bind();
      while (!(await w.sync(50)).complete);
      expect([...mirror(new Map(), w.landed).values()].sort()).toEqual(['Late folder', 'Late folder/early.txt']);
    });
  });

  it('an expired cursor resyncs from scratch, landing only what changed', async () => {
    const w = await world();
    const keep = w.drive.put(w.general, 'keep.txt', 'keep');
    const gone = w.drive.put(w.general, 'gone.txt', 'gone');
    await w.bind();
    await w.sync();
    w.landed.length = 0;
    w.drive.remove(gone);
    w.drive.expiredBefore = Number.MAX_SAFE_INTEGER;
    const r = await w.sync();
    expect(r.full).toBe(true);
    expect(w.landed).toEqual([expect.objectContaining({ change: 'delete', itemId: gone, reason: 'deleted' })]);
    expect(w.landed.some((c) => c.itemId === keep)).toBe(false);
  });

  it('lands a file over the cap without its bytes', async () => {
    const w = await world();
    const big = w.drive.put(w.general, 'huge.bin', new Uint8Array(MAX_FILE_BYTES + 1));
    await w.bind();
    await w.sync();
    expect(w.landed).toEqual([expect.objectContaining({ change: 'upsert', itemId: big, content: 'too-large' })]);
    expect(w.drive.calls.some((c) => c.url.includes(`/items/${big}/content`))).toBe(false);
  });

  it('lands a file whose size Graph does not state without its bytes', async () => {
    const w = await world();
    const unknown = w.drive.put(w.general, 'unsized.bin', 'x');
    w.drive.sizeless.add(unknown);
    await w.bind();
    await w.sync();
    expect(w.landed).toEqual([expect.objectContaining({ change: 'upsert', itemId: unknown, size: null, content: 'too-large' })]);
    expect(w.drive.calls.some((c) => c.url.includes(`/items/${unknown}/content`))).toBe(false);
  });

  it('follows the folder by id when it is renamed', async () => {
    const w = await world();
    w.drive.put(w.general, 'agenda.txt', 'agenda');
    await w.bind();
    await w.sync();
    w.landed.length = 0;
    w.drive.rename(w.general, 'Allmänt');
    w.drive.put(w.general, 'after.txt', 'after');
    await w.sync();
    expect(w.landed.filter((c) => c.change === 'upsert').map((c) => c.path)).toEqual(['after.txt']);
  });

  it('a deleted folder makes the binding refuse — never a fall back to the library root', async () => {
    const w = await world();
    w.drive.put(w.general, 'agenda.txt', 'agenda');
    await w.bind();
    await w.sync();
    w.landed.length = 0;
    w.drive.remove(w.general);
    await expect(w.sync()).rejects.toThrow(/no longer exists/);
    const [binding] = await listMicrosoft365Bindings(w.host, w.conn);
    expect(binding!.folderMissing).toBeDefined();
    expect(w.landed).toEqual([]);

    // Later passes do not call Graph at all, and writes refuse.
    const before = w.drive.calls.length;
    const sweep = await sweepMicrosoft365Files(w.host, w.conn, w.options);
    expect(sweep.failed).toEqual([{ scopeId: w.s, error: expect.stringMatching(/no longer exists/) }]);
    expect(w.drive.calls.length).toBe(before);
    const a = await w.attach('ok.txt', 'x');
    await w.send({ files: [{ attachmentId: a.id, size: a.size }], conflict: 'fail' });
    expect(w.drive.calls.length).toBe(before);
  });

  it('a folder moved out of the library to another drive refuses too', async () => {
    const w = await world();
    await w.bind();
    await w.sync();
    // As the fake models a cross-drive move: gone from this drive.
    w.drive.remove(w.general);
    await expect(w.sync()).rejects.toThrow(/no longer exists/);
  });

  it('refuses to send the token to a link outside Graph', async () => {
    const w = await world();
    for (let i = 0; i < 5; i += 1) w.drive.put(w.general, `f${i}.txt`, 'x');
    await w.bind();
    w.drive.nextLinkOverride = 'https://elsewhere.example/v1.0/drives/drive-1/root/delta?skip=3';
    await expect(w.sync()).rejects.toThrow(/outside Graph/);
    expect(w.drive.calls.some((c) => c.url.startsWith('https://elsewhere.example'))).toBe(false);
  });

  it('a sweep syncs every binding and reports failures per scope', async () => {
    const w = await world();
    w.drive.put(w.general, 'agenda.txt', 'agenda');
    await w.bind();
    const r = await sweepMicrosoft365Files(w.host, w.conn, w.options);
    expect(r).toMatchObject({ found: 1, failed: [], synced: [expect.objectContaining({ scopeId: w.s, changes: 1 })] });
  });
});

describe('the public contract', () => {
  it('names the write event', () => {
    expect(MICROSOFT365_FILES_EVENT).toBe('microsoft365.channel-files-requested');
  });
  // A vertical builds the event with this schema and lands changes with that one: both are frozen
  // once shipped, so a change to either is a visible diff here, never a silent reshape.
  it('pins the write event payload', () => {
    expect(z.toJSONSchema(microsoft365FilesRequested, { io: 'input' })).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "properties": {
          "conflict": {
            "enum": [
              "replace",
              "rename",
              "fail",
            ],
            "type": "string",
          },
          "directory": {
            "default": "",
            "type": "string",
          },
          "files": {
            "items": {
              "properties": {
                "attachmentId": {
                  "minLength": 1,
                  "type": "string",
                },
                "name": {
                  "minLength": 1,
                  "type": "string",
                },
                "size": {
                  "maximum": 52428800,
                  "minimum": 0,
                  "type": "integer",
                },
              },
              "required": [
                "attachmentId",
                "size",
              ],
              "type": "object",
            },
            "maxItems": 20,
            "minItems": 1,
            "type": "array",
          },
        },
        "required": [
          "files",
          "conflict",
        ],
        "type": "object",
      }
    `);
  });
  it('pins the change the sync lands', () => {
    expect(z.toJSONSchema(microsoft365ChannelChange)).toMatchInlineSnapshot(`
      {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "oneOf": [
          {
            "additionalProperties": false,
            "properties": {
              "change": {
                "const": "upsert",
                "type": "string",
              },
              "connectionId": {
                "minLength": 1,
                "type": "string",
              },
              "content": {
                "anyOf": [
                  {
                    "enum": [
                      "follows",
                      "unchanged",
                      "too-large",
                    ],
                    "type": "string",
                  },
                  {
                    "type": "null",
                  },
                ],
              },
              "contentType": {
                "anyOf": [
                  {
                    "type": "string",
                  },
                  {
                    "type": "null",
                  },
                ],
              },
              "itemId": {
                "minLength": 1,
                "type": "string",
              },
              "kind": {
                "enum": [
                  "file",
                  "folder",
                ],
                "type": "string",
              },
              "lastModifiedAt": {
                "anyOf": [
                  {
                    "type": "string",
                  },
                  {
                    "type": "null",
                  },
                ],
              },
              "name": {
                "minLength": 1,
                "type": "string",
              },
              "path": {
                "minLength": 1,
                "type": "string",
              },
              "previousPath": {
                "anyOf": [
                  {
                    "type": "string",
                  },
                  {
                    "type": "null",
                  },
                ],
              },
              "size": {
                "anyOf": [
                  {
                    "maximum": 9007199254740991,
                    "minimum": 0,
                    "type": "integer",
                  },
                  {
                    "type": "null",
                  },
                ],
              },
              "webUrl": {
                "anyOf": [
                  {
                    "type": "string",
                  },
                  {
                    "type": "null",
                  },
                ],
              },
            },
            "required": [
              "change",
              "connectionId",
              "itemId",
              "kind",
              "path",
              "name",
              "previousPath",
              "size",
              "contentType",
              "lastModifiedAt",
              "webUrl",
              "content",
            ],
            "type": "object",
          },
          {
            "additionalProperties": false,
            "properties": {
              "attachment": {
                "additionalProperties": false,
                "properties": {
                  "contentType": {
                    "minLength": 1,
                    "type": "string",
                  },
                  "filename": {
                    "minLength": 1,
                    "type": "string",
                  },
                  "id": {
                    "minLength": 1,
                    "type": "string",
                  },
                  "sha256": {
                    "pattern": "^[0-9a-f]{64}$",
                    "type": "string",
                  },
                  "size": {
                    "maximum": 9007199254740991,
                    "minimum": 0,
                    "type": "integer",
                  },
                },
                "required": [
                  "id",
                  "filename",
                  "contentType",
                  "size",
                  "sha256",
                ],
                "type": "object",
              },
              "change": {
                "const": "content",
                "type": "string",
              },
              "connectionId": {
                "minLength": 1,
                "type": "string",
              },
              "itemId": {
                "minLength": 1,
                "type": "string",
              },
              "kind": {
                "enum": [
                  "file",
                  "folder",
                ],
                "type": "string",
              },
              "name": {
                "minLength": 1,
                "type": "string",
              },
              "path": {
                "minLength": 1,
                "type": "string",
              },
              "replaces": {
                "anyOf": [
                  {
                    "type": "string",
                  },
                  {
                    "type": "null",
                  },
                ],
              },
            },
            "required": [
              "change",
              "connectionId",
              "itemId",
              "kind",
              "path",
              "name",
              "attachment",
              "replaces",
            ],
            "type": "object",
          },
          {
            "additionalProperties": false,
            "properties": {
              "change": {
                "const": "delete",
                "type": "string",
              },
              "connectionId": {
                "minLength": 1,
                "type": "string",
              },
              "itemId": {
                "minLength": 1,
                "type": "string",
              },
              "kind": {
                "enum": [
                  "file",
                  "folder",
                ],
                "type": "string",
              },
              "name": {
                "minLength": 1,
                "type": "string",
              },
              "path": {
                "minLength": 1,
                "type": "string",
              },
              "reason": {
                "enum": [
                  "deleted",
                  "moved-out",
                ],
                "type": "string",
              },
            },
            "required": [
              "change",
              "connectionId",
              "itemId",
              "kind",
              "path",
              "name",
              "reason",
            ],
            "type": "object",
          },
        ],
      }
    `);
  });
  it('derives the rename suffix from the event, stable and extension-preserving', () => {
    expect(withSuffix('report.pdf', '1a2b3c4d')).toBe('report (1a2b3c4d).pdf');
    expect(withSuffix('README', '1a2b3c4d')).toBe('README (1a2b3c4d)');
    expect(withSuffix('.env', '1a2b3c4d')).toBe('.env (1a2b3c4d)');
  });
});
