import { describe, expect, it } from 'vitest';
import { ATTACHMENT_FIELD_MAX, attachmentUploadFields, uploadLinkMintInput } from '../src/index.js';

/** #2519: the bounds a new attachment is judged by, one field at a time, each with its twin at the bound. */
const fields = {
  id: '01JTESTATTACHMENT0000000A',
  entity: { entityType: 'doc', entityId: 'd1' },
  filename: 'a.pdf',
  contentType: 'application/pdf',
  visibility: 'internal' as const,
  createdBy: '01JTESTPRINCIPAL00000000A',
  createdAt: '2026-08-17T00:00:00.000Z',
};

describe('attachmentUploadFields', () => {
  it('admits every string at its bound', () => {
    expect(
      attachmentUploadFields.safeParse({
        ...fields,
        entity: { entityType: 'e'.repeat(ATTACHMENT_FIELD_MAX.entityType), entityId: 'i'.repeat(ATTACHMENT_FIELD_MAX.entityId) },
        filename: 'f'.repeat(ATTACHMENT_FIELD_MAX.filename),
        contentType: 'c'.repeat(ATTACHMENT_FIELD_MAX.contentType),
        createdBy: 'p'.repeat(ATTACHMENT_FIELD_MAX.createdBy),
      }).success,
    ).toBe(true);
  });

  it.each([
    ['filename', { filename: 'f'.repeat(ATTACHMENT_FIELD_MAX.filename + 1) }],
    ['contentType', { contentType: 'c'.repeat(ATTACHMENT_FIELD_MAX.contentType + 1) }],
    ['entityType', { entity: { entityType: 'e'.repeat(ATTACHMENT_FIELD_MAX.entityType + 1), entityId: 'd1' } }],
    ['entityId', { entity: { entityType: 'doc', entityId: 'i'.repeat(ATTACHMENT_FIELD_MAX.entityId + 1) } }],
    ['createdBy', { createdBy: 'p'.repeat(ATTACHMENT_FIELD_MAX.createdBy + 1) }],
  ])('refuses a %s one unit over its bound, naming it', (field, over) => {
    const out = attachmentUploadFields.safeParse({ ...fields, ...over });
    expect(out.success).toBe(false);
    expect(JSON.stringify(out.error?.issues.map((i) => i.path))).toContain(field);
  });
});

describe('uploadLinkMintInput', () => {
  it('refuses at the mint an entity no redemption could store, and admits one at the bound', () => {
    const at = { entityType: 'e'.repeat(ATTACHMENT_FIELD_MAX.entityType), entityId: 'i'.repeat(ATTACHMENT_FIELD_MAX.entityId) };
    expect(uploadLinkMintInput.safeParse({ entity: at }).success).toBe(true);
    expect(uploadLinkMintInput.safeParse({ entity: { ...at, entityId: at.entityId + 'i' } }).success).toBe(false);
    expect(uploadLinkMintInput.safeParse({ entity: { ...at, entityType: at.entityType + 'e' } }).success).toBe(false);
  });
});
