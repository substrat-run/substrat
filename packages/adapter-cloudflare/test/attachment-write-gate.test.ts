import { describe, expect, it } from 'vitest';
import { principalId, scopeId, substratError, tenantId, toWireFailure } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { askAttachmentWriteGate } from '../src/host.js';

/**
 * The host's early write check against a scope DO that may predate the verb (#2516): a DO that
 * cannot answer is a refusal to read the body, never a pass.
 */
describe('askAttachmentWriteGate', () => {
  const args = [{ entityType: 'item', entityId: 'i1' }, principalId.parse(ulid()), tenantId.parse(ulid()), scopeId.parse(ulid())] as const;

  it('a DO without the verb fails closed with a retryable unavailable that says to redeploy', async () => {
    const old = {
      attachmentCheckWriteReply: async () => {
        throw new TypeError('The RPC receiver does not implement the method "attachmentCheckWriteReply".');
      },
    };
    const err = await askAttachmentWriteGate(old as never, ...args).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'unavailable', message: expect.stringMatching(/Redeploy the vertical.*Nothing was stored/) });
  });

  it('its twin: a DO that answers allowed passes, and one that answers a refusal throws it', async () => {
    await expect(askAttachmentWriteGate({ attachmentCheckWriteReply: async () => ({ value: null }) } as never, ...args)).resolves.toBeUndefined();
    const refused = { attachmentCheckWriteReply: async () => ({ failure: toWireFailure(substratError('forbidden', 'denied')) }) };
    await expect(askAttachmentWriteGate(refused as never, ...args)).rejects.toThrow();
  });

  it('is by the error\'s kind, not its wording: a reworded TypeError is still the redeploy answer', async () => {
    const reworded = { attachmentCheckWriteReply: async () => { throw new TypeError('RPC method missing on receiver'); } };
    await expect(askAttachmentWriteGate(reworded as never, ...args)).rejects.toMatchObject({ code: 'unavailable' });
    const named = { attachmentCheckWriteReply: async () => { throw Object.assign(new Error('gone'), { name: 'TypeError' }); } };
    await expect(askAttachmentWriteGate(named as never, ...args)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('any other transport error is rethrown as it is', async () => {
    const boom = { attachmentCheckWriteReply: async () => { throw new Error('network lost'); } };
    await expect(askAttachmentWriteGate(boom as never, ...args)).rejects.toThrow('network lost');
  });
});
