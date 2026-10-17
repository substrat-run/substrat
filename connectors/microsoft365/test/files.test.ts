import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  microsoft365ChannelChange,
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
  const sync = async () => {
    const [binding] = await listMicrosoft365Bindings(host, conn);
    return syncMicrosoft365Scope(host, conn, binding!, options);
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
    await w.send({ directory: 'Offers/2026', files: [{ attachmentId: a.id }, { attachmentId: b.id, name: 'Terms.txt' }], conflict: 'fail' });
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
      await w.send({ files: [{ attachmentId: a.id }], conflict });
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
    await w.send({ files: [{ attachmentId: a.id }], conflict: 'rename' });
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
    await w.send({ files: [{ attachmentId: a.id }], conflict: 'fail' });
    await w.host.drainDue(w.t, w.s);
    expect(w.drive.text(w.general, 'report.pdf')).toBe("a person's report");
    expect(w.drive.childrenNamed(w.general)).toEqual(['report.pdf']);
    expect(await w.ledgers()).toEqual([expect.objectContaining({ status: 'pending', files: [] })]);
  });

  it('replace overwrites, and says so in the event', async () => {
    const w = await world();
    await w.bind();
    w.drive.put(w.general, 'report.pdf', 'old');
    const a = await w.attach('report.pdf', 'new');
    await w.send({ files: [{ attachmentId: a.id }], conflict: 'replace' });
    expect(w.drive.text(w.general, 'report.pdf')).toBe('new');
  });

  it('sends a file over 4 MB by upload session, without the token on the upload URL', async () => {
    const w = await world();
    await w.bind();
    const big = new Uint8Array(5 * 1024 * 1024).fill(7);
    const a = await w.attach('drawing.bin', big);
    await w.send({ files: [{ attachmentId: a.id }], conflict: 'fail' });
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
    await w.send({ files: [{ attachmentId: a.id }], conflict: 'fail' });
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
    await w.send({ files: [{ attachmentId: a.id }], conflict: 'fail' });
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
    await w.send({ files: [{ attachmentId: elsewhere.id }], conflict: 'fail' });
    expect(w.drive.graphCalls().filter((c) => c.method === 'PUT')).toEqual([]);
    expect(await w.ledgers()).toEqual([]);
  });

  describe('the fence refuses before Graph is called', () => {
    const outside: [string, Partial<Microsoft365FilesRequested>][] = [
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
      ['a dot-dot file name', { files: [{ attachmentId: 'x', name: '..' }] }],
      ['a file name with a slash', { files: [{ attachmentId: 'x', name: '../secret.txt' }] }],
      ['a reserved device name', { files: [{ attachmentId: 'x', name: 'CON.txt' }] }],
    ];
    it.each(outside)('%s', async (_label, over) => {
      const w = await world();
      await w.bind();
      const a = await w.attach('ok.txt', 'x');
      const before = w.drive.calls.length;
      await w.send({ files: [{ attachmentId: a.id }], conflict: 'replace', ...over });
      expect(w.drive.calls.length).toBe(before);
      expect(await w.ledgers()).toEqual([]);
      expect(w.drive.childrenNamed('root')).toEqual(['General', 'Leadership']);
    });

    it('admits an NFC name with accents and a directory under the folder (the positive twin)', async () => {
      const w = await world();
      await w.bind();
      const a = await w.attach('Café menu.txt', 'x');
      await w.send({ directory: 'Kök/2026', files: [{ attachmentId: a.id }], conflict: 'fail' });
      expect(w.drive.childrenNamed(w.general)).toEqual(['Kök']);
    });
  });

  it('refuses a write when no folder is bound', async () => {
    const w = await world();
    const a = await w.attach('ok.txt', 'x');
    await w.send({ files: [{ attachmentId: a.id }], conflict: 'fail' });
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
    w.landed.length = 0;

    w.drive.put(w.general, 'new.txt', 'new');
    w.drive.edit(agenda, 'agenda v2');
    w.drive.rename(sub, 'Meeting minutes');
    w.drive.remove(m1);
    w.drive.move(leaving, w.leadership);
    w.drive.move(incoming, w.general);
    const r = await w.sync();
    expect(r.full).toBe(false);

    const byPath = (change: string) => w.landed.filter((c) => c.change === change).map((c) => c.path).sort();
    expect(byPath('delete')).toEqual(['Minutes/m1.txt', 'Moved-away-secret.docx']);
    expect(w.landed.find((c) => c.change === 'delete' && c.name === 'Moved-away-secret.docx')).toMatchObject({ reason: 'moved-out' });
    expect(w.landed.find((c) => c.change === 'delete' && c.name === 'm1.txt')).toMatchObject({ reason: 'deleted' });
    expect(byPath('upsert')).toEqual(['Meeting minutes', 'Shared-plans', 'Shared-plans/plan.txt', 'agenda.txt', 'new.txt']);
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
    await w.send({ files: [{ attachmentId: a.id }], conflict: 'fail' });
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
  it('derives the rename suffix from the event, stable and extension-preserving', () => {
    expect(withSuffix('report.pdf', '1a2b3c4d')).toBe('report (1a2b3c4d).pdf');
    expect(withSuffix('README', '1a2b3c4d')).toBe('README (1a2b3c4d)');
    expect(withSuffix('.env', '1a2b3c4d')).toBe('.env (1a2b3c4d)');
  });
});
