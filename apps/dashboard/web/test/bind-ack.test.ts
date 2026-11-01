import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/api.generated';
import { sendWithExportBreakAck } from '../src/lib/bind-ack';

describe('sendWithExportBreakAck', () => {
  it('lists the apps the generated client keeps under body.exportBreaks.affected, then sends acknowledged', async () => {
    const affected = [{ vertical: 'billing', type: 'invoice.paid', schemaVersion: 1, incoming: null }];
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, 'this bind drops or re-versions an exported type', { exportBreaks: { affected } }))
      .mockResolvedValueOnce('done');
    const confirm = vi.fn().mockResolvedValue(true);
    await expect(sendWithExportBreakAck(send, confirm)).resolves.toBe('done');
    expect(confirm).toHaveBeenCalledWith('this bind drops or re-versions an exported type', affected);
    expect(send.mock.calls).toEqual([[false], [true]]);
  });
});
