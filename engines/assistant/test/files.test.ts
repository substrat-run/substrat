import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineHarness, type EngineHarness } from '@substrat-run/engine-test-kit';
import type { AssistantStreamEvent } from '@substrat-run/contracts/assistant-stream';
import { ASSISTANT_PERM, assistantModule, type Thread } from '../src/index.js';
import { ASSISTANT_FILE_MAX_BYTES, assistantFiles, purgeAssistantThreadFiles } from '../src/files.js';

describe('assistant files through the host broker and real attachment storage', () => {
  let h: EngineHarness;
  beforeEach(async () => { h = await engineHarness({ modules: [assistantModule], attachments: true }); });
  afterEach(async () => { await h.close(); });

  const world = async () => {
    const owner = await h.mintPrincipal([ASSISTANT_PERM.use]);
    const other = await h.mintPrincipal([ASSISTANT_PERM.use]);
    const auditor = await h.mintPrincipal([ASSISTANT_PERM.use, ASSISTANT_PERM.audit]);
    const runner = await h.mintPrincipal([ASSISTANT_PERM.run]);
    const storage = await h.host.attachments(runner.principal, h.tenant, h.scope);
    const files = assistantFiles(owner.stub, storage);
    const thread = await owner.stub.invoke<Thread>('assistant/create-thread', {});
    return { owner, other, auditor, runner, storage, files, thread };
  };
  const csv = { filename: 'entities.csv', body: new TextEncoder().encode('code,amount\n001,12.50\n') };

  it('stores bytes outside the log and sends an immutable file reference, including a file-only message', async () => {
    const { owner, runner, files, thread } = await world();
    const file = await files.upload({ threadId: thread.id, ...csv });
    expect(file).toMatchObject({ filename: 'entities.csv', contentType: 'text/csv', visibility: 'internal', size: csv.body.length });
    expect((await files.open(thread.id, file.id)).body).toEqual(csv.body);
    await owner.stub.invoke('assistant/send-message', { threadId: thread.id, attachmentIds: [file.id] });
    const page = await owner.stub.invoke<{ events: AssistantStreamEvent[] }>('assistant/read-events', { threadId: thread.id });
    expect(page.events[0]).toEqual({
      id: 1, t: 'user-message', text: '',
      files: [{ id: file.id, filename: file.filename, contentType: file.contentType, size: file.size, sha256: file.sha256 }],
    });
    expect(JSON.stringify(page)).not.toContain('001,12.50');
    await runner.stub.invoke('assistant/acquire-run', { threadId: thread.id, runId: 'r1' });
    await runner.stub.invoke('assistant/append-events', { threadId: thread.id, runId: 'r1', events: [{ t: 'turn-finish', reason: 'done' }] });
    await owner.stub.invoke('assistant/send-message', { threadId: thread.id, text: 'Now compare these rows', attachmentIds: [file.id] });
    const later = await owner.stub.invoke<{ events: AssistantStreamEvent[] }>('assistant/read-events', { threadId: thread.id, after: 3 });
    expect(later.events[0]).toMatchObject({ t: 'user-message', text: 'Now compare these rows', files: [{ id: file.id }] });
  });

  it('a stranger cannot list, open, upload or bypass the broker with the scope-wide use key', async () => {
    const { other, storage, files, thread } = await world();
    const file = await files.upload({ threadId: thread.id, ...csv });
    const strangers = assistantFiles(other.stub, storage);
    await expect(strangers.list(thread.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(strangers.open(thread.id, file.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(strangers.upload({ threadId: thread.id, ...csv })).rejects.toMatchObject({ code: 'not_found' });
    const direct = await h.host.attachments(other.principal, h.tenant, h.scope);
    await expect(direct.open(file.id)).rejects.toThrow();
    await expect(direct.upload({ entity: file.entity, filename: csv.filename, contentType: 'text/csv', visibility: 'internal', body: csv.body })).rejects.toThrow();
  });

  it('audit permits file reads, while uploading still requires the owner of an open thread', async () => {
    const { owner, auditor, storage, files, thread } = await world();
    const file = await files.upload({ threadId: thread.id, ...csv });
    const audit = assistantFiles(auditor.stub, storage);
    expect((await audit.open(thread.id, file.id)).body).toEqual(csv.body);
    await expect(audit.upload({ threadId: thread.id, ...csv })).rejects.toMatchObject({ code: 'not_found' });
    await owner.stub.invoke('assistant/close-thread', { threadId: thread.id });
    await expect(files.upload({ threadId: thread.id, ...csv })).rejects.toMatchObject({ extensions: { reason: 'thread_closed' } });
    expect((await files.open(thread.id, file.id)).body).toEqual(csv.body);
  });

  it('missing and cross-thread references fail atomically; duplicate and excessive references fail validation', async () => {
    const { owner, files, thread } = await world();
    const another = await owner.stub.invoke<Thread>('assistant/create-thread', {});
    const file = await files.upload({ threadId: another.id, ...csv });
    for (const id of ['missing', file.id]) {
      await expect(owner.stub.invoke('assistant/send-message', { threadId: thread.id, text: 'compare', attachmentIds: [id] })).rejects.toMatchObject({ code: 'not_found' });
      await expect(files.open(thread.id, id)).rejects.toMatchObject({ code: 'not_found' });
    }
    for (const ids of [[file.id, file.id], Array.from({ length: 6 }, (_, n) => `file-${n}`)]) {
      await expect(owner.stub.invoke('assistant/send-message', { threadId: another.id, attachmentIds: ids })).rejects.toThrow();
    }
    const page = await owner.stub.invoke<{ events: unknown[] }>('assistant/read-events', { threadId: thread.id });
    expect(page.events).toEqual([]);
    await expect(owner.stub.invoke('assistant/send-message', { threadId: thread.id })).rejects.toThrow();
  });

  it('refuses unsupported formats, paths, empty and oversized files before they reach storage', async () => {
    const { files, thread } = await world();
    for (const input of [
      { ...csv, filename: 'old.xls' }, { ...csv, filename: '../data.csv' },
      { ...csv, body: new Uint8Array() }, { ...csv, body: new Uint8Array(ASSISTANT_FILE_MAX_BYTES + 1) },
    ]) await expect(files.upload({ threadId: thread.id, ...input })).rejects.toThrow();
    expect(await files.list(thread.id)).toEqual([]);
  });

  it('the host can purge files before subject erasure, including an upload never sent in a message', async () => {
    const { storage, files, thread } = await world();
    const sent = await files.upload({ threadId: thread.id, ...csv });
    const staged = await files.upload({ threadId: thread.id, ...csv });
    await purgeAssistantThreadFiles(storage, thread.id);
    await purgeAssistantThreadFiles(storage, thread.id);
    expect(await storage.open(sent.id)).toBeNull();
    expect(await storage.open(staged.id)).toBeNull();
    expect(await files.list(thread.id)).toEqual([]);
  });
});
