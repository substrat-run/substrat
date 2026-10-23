/**
 * #2499: the provider-neutral file-source vocabulary. Every refusal is paired with the nearest
 * input it must still admit, so a bound that drifts in either direction goes red.
 */
import { describe, expect, it } from 'vitest';
import {
  FILE_SOURCE_MAX_FILES_PER_WRITE,
  FILE_SOURCE_MAX_FILE_BYTES,
  FILE_SOURCE_MAX_WRITE_BYTES,
  fileSourceChange,
  fileSourceConflict,
  fileSourceUpsertAnswer,
  fileSourceWriteRequest,
} from '../src/file-source.js';

const file = (attachmentId: string, size = 10) => ({ attachmentId, size });
const request = (over: Record<string, unknown> = {}) => ({ files: [file('a1')], conflict: 'fail', ...over });

describe('fileSourceWriteRequest', () => {
  it('admits a request, and defaults the directory to the bound folder itself', () => {
    expect(fileSourceWriteRequest.parse(request())).toEqual({ directory: '', files: [file('a1')], conflict: 'fail' });
    expect(fileSourceWriteRequest.parse(request({ directory: 'reports/2026' })).directory).toBe('reports/2026');
  });

  it('requires a conflict mode, and admits each of the three', () => {
    const { conflict: _omitted, ...without } = request();
    expect(fileSourceWriteRequest.safeParse(without).success).toBe(false);
    for (const conflict of ['replace', 'rename', 'fail']) {
      expect(fileSourceWriteRequest.parse(request({ conflict })).conflict).toBe(conflict);
    }
    expect(fileSourceConflict.options).toEqual(['replace', 'rename', 'fail']);
  });

  it('refuses a conflict mode it does not know', () => {
    expect(fileSourceWriteRequest.safeParse(request({ conflict: 'overwrite' })).success).toBe(false);
    expect(fileSourceWriteRequest.safeParse(request({ conflict: 'REPLACE' })).success).toBe(false);
  });

  it('holds the file count to 1..FILE_SOURCE_MAX_FILES_PER_WRITE', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => file(`a${i}`, 0));
    expect(fileSourceWriteRequest.safeParse(request({ files: [] })).success).toBe(false);
    expect(fileSourceWriteRequest.safeParse(request({ files: many(1) })).success).toBe(true);
    expect(fileSourceWriteRequest.safeParse(request({ files: many(FILE_SOURCE_MAX_FILES_PER_WRITE) })).success).toBe(true);
    expect(fileSourceWriteRequest.safeParse(request({ files: many(FILE_SOURCE_MAX_FILES_PER_WRITE + 1) })).success).toBe(false);
  });

  it('holds one file to FILE_SOURCE_MAX_FILE_BYTES, and a size to a non-negative integer', () => {
    const one = (size: number) => request({ files: [file('a1', size)] });
    expect(fileSourceWriteRequest.safeParse(one(FILE_SOURCE_MAX_FILE_BYTES)).success).toBe(true);
    expect(fileSourceWriteRequest.safeParse(one(FILE_SOURCE_MAX_FILE_BYTES + 1)).success).toBe(false);
    expect(fileSourceWriteRequest.safeParse(one(0)).success).toBe(true);
    expect(fileSourceWriteRequest.safeParse(one(-1)).success).toBe(false);
    expect(fileSourceWriteRequest.safeParse(one(1.5)).success).toBe(false);
  });

  it('holds all the files together to FILE_SOURCE_MAX_WRITE_BYTES, with the cap in the message', () => {
    // The total cap is twice the per-file cap, so two files at the cap fill it exactly and a third
    // byte, in a third file, is what tips it over.
    const two = [file('a1', FILE_SOURCE_MAX_FILE_BYTES), file('a2', FILE_SOURCE_MAX_FILE_BYTES)];
    expect(FILE_SOURCE_MAX_WRITE_BYTES).toBe(2 * FILE_SOURCE_MAX_FILE_BYTES);
    expect(fileSourceWriteRequest.safeParse(request({ files: two })).success).toBe(true);
    const over = fileSourceWriteRequest.safeParse(request({ files: [...two, file('a3', 1)] }));
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toBe(`the files come to more than ${FILE_SOURCE_MAX_WRITE_BYTES} bytes, the most one event may move`);
  });

  it('refuses one attachment named twice, and admits two distinct ones', () => {
    expect(fileSourceWriteRequest.safeParse(request({ files: [file('a1'), file('a2')] })).success).toBe(true);
    const twice = fileSourceWriteRequest.safeParse(request({ files: [file('a1'), file('a1')] }));
    expect(twice.success).toBe(false);
    expect(twice.error?.issues[0]?.message).toBe('an attachment is named more than once');
  });

  it('takes an optional name, and refuses an empty one or an empty attachment id', () => {
    expect(fileSourceWriteRequest.safeParse(request({ files: [{ ...file('a1'), name: 'report.pdf' }] })).success).toBe(true);
    expect(fileSourceWriteRequest.safeParse(request({ files: [{ ...file('a1'), name: '' }] })).success).toBe(false);
    expect(fileSourceWriteRequest.safeParse(request({ files: [file('')] })).success).toBe(false);
  });
});

const common = { connectionId: 'conn1', itemId: 'item1', kind: 'file', path: 'a/b.txt', name: 'b.txt' };
const upsert = (over: Record<string, unknown> = {}) => ({
  change: 'upsert',
  ...common,
  previousPath: null,
  size: 3,
  contentType: 'text/plain',
  lastModifiedAt: null,
  webUrl: null,
  content: 'follows',
  ...over,
});
const attachment = {
  id: '01HX',
  filename: 'b.txt',
  contentType: 'text/plain',
  size: 3,
  sha256: 'a'.repeat(64),
};
const content = (over: Record<string, unknown> = {}) => ({ change: 'content', ...common, attachment, replaces: null, ...over });
const deletion = (over: Record<string, unknown> = {}) => ({ change: 'delete', ...common, reason: 'deleted', ...over });

describe('fileSourceChange', () => {
  it('admits each of the three changes', () => {
    expect(fileSourceChange.parse(upsert()).change).toBe('upsert');
    expect(fileSourceChange.parse(content()).change).toBe('content');
    expect(fileSourceChange.parse(deletion()).change).toBe('delete');
  });

  it('admits each content state of an upsert, and a folder with no content', () => {
    for (const state of ['follows', 'unchanged', 'too-large', null]) {
      expect(fileSourceChange.safeParse(upsert({ content: state })).success).toBe(true);
    }
    expect(fileSourceChange.safeParse(upsert({ content: 'inline' })).success).toBe(false);
    expect(fileSourceChange.safeParse(upsert({ kind: 'folder', size: null, content: null })).success).toBe(true);
    expect(fileSourceChange.safeParse(upsert({ kind: 'link' })).success).toBe(false);
  });

  it('refuses a change kind it does not know', () => {
    expect(fileSourceChange.safeParse({ ...deletion(), change: 'rename' }).success).toBe(false);
  });

  it('admits both delete reasons and no other', () => {
    expect(fileSourceChange.safeParse(deletion({ reason: 'deleted' })).success).toBe(true);
    expect(fileSourceChange.safeParse(deletion({ reason: 'moved-out' })).success).toBe(true);
    expect(fileSourceChange.safeParse(deletion({ reason: 'moved' })).success).toBe(false);
  });

  it('says where an item went to nobody: a moved-out delete carries no destination field', () => {
    const parsed = fileSourceChange.parse(deletion({ reason: 'moved-out', movedTo: 'elsewhere/x.txt' }));
    expect(parsed).not.toHaveProperty('movedTo');
    expect(parsed).toMatchObject({ itemId: 'item1', path: 'a/b.txt', name: 'b.txt', reason: 'moved-out' });
  });

  it('keys every change on a non-empty itemId, path and name', () => {
    for (const make of [upsert, content, deletion]) {
      expect(fileSourceChange.safeParse(make()).success).toBe(true);
      for (const field of ['itemId', 'path', 'name', 'connectionId']) {
        expect(fileSourceChange.safeParse(make({ [field]: '' })).success, `${make().change}.${field}`).toBe(false);
      }
    }
  });

  it('carries the landed attachment as its five-field summary, and drops the rest of the record', () => {
    const parsed = fileSourceChange.parse(content({ attachment: { ...attachment, createdBy: 'someone', visibility: 'internal' } }));
    expect(parsed).toMatchObject({ change: 'content', attachment });
    expect(Object.keys((parsed as { attachment: object }).attachment).sort()).toEqual(['contentType', 'filename', 'id', 'sha256', 'size']);
    expect(fileSourceChange.safeParse(content({ attachment: { ...attachment, sha256: 'nope' } })).success).toBe(false);
    expect(fileSourceChange.safeParse(content({ replaces: '01HW' })).success).toBe(true);
  });
});

describe('fileSourceUpsertAnswer', () => {
  const entity = { entityType: 'doc', entityId: '01HX' };

  it('reads the entity the bytes attach to, and tolerates anything else the operation answers', () => {
    expect(fileSourceUpsertAnswer.parse({ entity }).entity).toEqual(entity);
    expect(fileSourceUpsertAnswer.parse({ entity, extra: 1 })).toMatchObject({ extra: 1 });
  });

  it('reads no entity as no bytes, and refuses a malformed one', () => {
    expect(fileSourceUpsertAnswer.parse({}).entity).toBeUndefined();
    expect(fileSourceUpsertAnswer.parse({ entity: null }).entity).toBeNull();
    expect(fileSourceUpsertAnswer.safeParse({ entity: { entityType: 'doc' } }).success).toBe(false);
    expect(fileSourceUpsertAnswer.safeParse('ok').success).toBe(false);
  });
});
