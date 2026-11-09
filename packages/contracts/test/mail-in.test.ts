import { describe, expect, it } from 'vitest';
import { mailInMessageAnswer } from '../src/mail-in.js';

const entity = { entityType: 'document', entityId: 'doc-1' };

describe('mailInMessageAnswer', () => {
  it("keeps the entity when an operation's own `raw` is not a boolean, and does not read it as a keep", () => {
    expect(mailInMessageAnswer.parse({ entity, raw: 'imported' })).toMatchObject({ entity, raw: undefined });
    expect(mailInMessageAnswer.parse({ entity, raw: true }).raw).toBe(true);
  });
});
