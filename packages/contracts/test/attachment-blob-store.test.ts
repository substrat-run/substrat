import { describe, expect, it } from 'vitest';
import {
  ATTACHMENT_BLOB_BINDING,
  blobStoreBindingName,
  declaresAttachmentTargets,
  runtimeNeeds,
  tenantStoreBindingName,
  withAttachmentBlobStore,
} from '../src/index.js';

const A = '01JTESTATTACHTENANT000000A';
const B = '01JTESTATTACHTENANT000000B';

describe('per-tenant binding names — one encoding, and it names one tenant only (#1995)', () => {
  it('names a tenant’s binding as <BINDING>__<ULID>, the same for both store kinds', () => {
    expect(blobStoreBindingName(ATTACHMENT_BLOB_BINDING, A)).toBe(`ATTACHMENTS__${A}`);
    expect(tenantStoreBindingName('DB', A)).toBe(`DB__${A}`);
  });

  it('distinct tenants never share a name', () => {
    expect(blobStoreBindingName(ATTACHMENT_BLOB_BINDING, A)).not.toBe(blobStoreBindingName(ATTACHMENT_BLOB_BINDING, B));
  });

  // The next case along: an id that is not a ULID could spell another binding's name. Each of
  // these, joined unchecked, would read a different binding than the tenant it claims to be.
  it.each([
    ['another tenant behind a separator', `X__${B}`],
    ['a lowercase ULID (env names are case-sensitive)', A.toLowerCase()],
    ['a ULID with a suffix', `${A}_`],
    ['a truncated ULID', A.slice(0, 25)],
    ['an empty id', ''],
    ['a path', `../${A}`],
  ])('refuses a tenant id that is not a ULID: %s', (_why, tenant) => {
    expect(() => blobStoreBindingName(ATTACHMENT_BLOB_BINDING, tenant)).toThrow(/not a tenant id/);
    expect(() => tenantStoreBindingName('DB', tenant)).toThrow(/not a tenant id/);
  });

  it('refuses a binding that is not SCREAMING_SNAKE', () => {
    expect(() => blobStoreBindingName('attachments', A)).toThrow(/not a per-tenant binding name/);
    expect(() => blobStoreBindingName('', A)).toThrow(/not a per-tenant binding name/);
  });
});

describe('the attachment store is derived from attachmentTargets, never hand-maintained (#1995)', () => {
  const needs = (raw: Record<string, unknown> = {}) => runtimeNeeds.parse({ entry: 'src/worker.ts', ...raw });

  it('declares nothing for a vertical whose modules attach nothing', () => {
    expect(declaresAttachmentTargets([{ attachmentTargets: [] }, {}])).toBe(false);
    expect(withAttachmentBlobStore(needs(), false)).toEqual([]);
    expect(withAttachmentBlobStore(undefined, false)).toEqual([]);
  });

  it('declares the platform store when any module declares a target — with or without runtimeNeeds', () => {
    expect(declaresAttachmentTargets([{ attachmentTargets: [] }, { attachmentTargets: [{ entityType: 'x' }] }])).toBe(true);
    expect(withAttachmentBlobStore(needs(), true)).toEqual([{ binding: 'ATTACHMENTS', kind: 'blob' }]);
    expect(withAttachmentBlobStore(undefined, true)).toEqual([{ binding: 'ATTACHMENTS', kind: 'blob' }]);
  });

  it('keeps the vertical’s own blob stores, and a hand-declared attachment store once', () => {
    expect(withAttachmentBlobStore(needs({ blobStores: [{ binding: 'FILES' }] }), true)).toEqual([
      { binding: 'FILES', kind: 'blob' },
      { binding: 'ATTACHMENTS', kind: 'blob' },
    ]);
    expect(withAttachmentBlobStore(needs({ blobStores: [{ binding: 'ATTACHMENTS' }] }), true)).toEqual([
      { binding: 'ATTACHMENTS', kind: 'blob' },
    ]);
  });

  it('refuses the attachment store’s name declared as a per-tenant relational store, attachments or not', () => {
    const relational = needs({ tenantStores: [{ binding: 'ATTACHMENTS' }] });
    expect(() => withAttachmentBlobStore(relational, true)).toThrow(/tenantStores declares 'ATTACHMENTS'/);
    expect(() => withAttachmentBlobStore(relational, false)).toThrow(/tenantStores declares 'ATTACHMENTS'/);
    // Its positive twin: a relational store of any other name is the vertical's own business.
    expect(withAttachmentBlobStore(needs({ tenantStores: [{ binding: 'DB' }] }), true)).toEqual([
      { binding: 'ATTACHMENTS', kind: 'blob' },
    ]);
  });

  it('a blob store of any kind but `blob` is refused where it is declared', () => {
    expect(() => needs({ blobStores: [{ binding: 'ATTACHMENTS', kind: 'relational' }] })).toThrow();
  });
});
