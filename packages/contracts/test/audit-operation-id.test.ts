import { describe, expect, it } from 'vitest';
import { auditOperationId, isWellFormedText, memberChangeAudit, ownerTransferAudit } from '../src/index.js';

/**
 * #2064: an audited change's operation id is matched in SQL and in memory, and only well-formed
 * text reads the same in both. A lone UTF-16 surrogate is refused where the id enters: the audit
 * row contracts both routes write through.
 */
describe('the audit operation id', () => {
  const lone = ['op\uD800', 'op\uDC00x', '\uDBFF', 'a\uDC00\uD800b'];
  const wellFormed = ['01J0000000000000000000000A', 'op😀', 'plain'];

  it('is well-formed text: a lone surrogate is refused, a paired one and plain text are not', () => {
    for (const id of lone) expect(isWellFormedText(id), JSON.stringify(id)).toBe(false);
    for (const id of wellFormed) expect(isWellFormedText(id), id).toBe(true);
    expect(auditOperationId.safeParse('').success).toBe(false);
  });

  it('both audit row contracts refuse a lone-surrogate id, and accept its well-formed twin', () => {
    const base = { tenantId: '01J00000000000000000000T01', scopeId: '01J00000000000000000000S01' };
    const transfer = { ...base, phase: 'intent', from: '01J00000000000000000000P01', to: '01J00000000000000000000P02' };
    const member = { ...base, phase: 'intent', change: 'remove', caller: '01J00000000000000000000P01' };
    for (const id of lone) {
      expect(ownerTransferAudit.safeParse({ ...transfer, operationId: id }).success).toBe(false);
      expect(memberChangeAudit.safeParse({ ...member, operationId: id }).success).toBe(false);
    }
    for (const id of wellFormed) {
      expect(ownerTransferAudit.safeParse({ ...transfer, operationId: id }).success).toBe(true);
      expect(memberChangeAudit.safeParse({ ...member, operationId: id }).success).toBe(true);
    }
  });
});
