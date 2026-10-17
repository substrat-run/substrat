import { describe, expect, it, vi } from 'vitest';
import { scopeId, tenantId } from '@substrat-run/contracts';
import { ulid, type HostAdmin } from '@substrat-run/kernel';
import type { VerticalClient } from '@substrat-run/control-plane-api';
import { orphanAttachmentSweepFor, parseOrphanSweepMode } from '../src/worker.js';

/**
 * #2314: the scheduled pass's orphan-attachment phase is off unless ORPHAN_ATTACHMENT_SWEEP names
 * one of its two modes, and never runs without script dispatch: no script but the one serving a
 * scope may judge its bytes, and this worker's own scope namespace holds none of them.
 */
describe('ORPHAN_ATTACHMENT_SWEEP (#2314)', () => {
  it('turns on only for the two spellings; unset, off and anything garbled are off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(parseOrphanSweepMode(undefined)).toBeUndefined();
      expect(parseOrphanSweepMode('')).toBeUndefined();
      expect(parseOrphanSweepMode('off')).toBeUndefined();
      expect(parseOrphanSweepMode('dry-run')).toBe('dry-run');
      expect(parseOrphanSweepMode(' delete ')).toBe('delete');
      expect(warn).not.toHaveBeenCalled();
      for (const garbled of ['DELETE', 'true', 'on', 'dryrun', 'delete!']) expect(parseOrphanSweepMode(garbled)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(5);
    } finally {
      warn.mockRestore();
    }
  });

  const resolveRef = async () => ({}) as VerticalClient;
  const admin = { getScopeRecord: async () => undefined } as unknown as HostAdmin;

  it('is off without a mode, and off without script dispatch whatever the mode', () => {
    expect(orphanAttachmentSweepFor({}, admin, resolveRef)).toBeUndefined();
    expect(orphanAttachmentSweepFor({ ORPHAN_ATTACHMENT_SWEEP: 'delete' }, admin, undefined)).toBeUndefined();
  });

  it('carries the mode and the batch, and reaches a scope through the directory first', async () => {
    const phase = orphanAttachmentSweepFor({ ORPHAN_ATTACHMENT_SWEEP: 'dry-run', ORPHAN_ATTACHMENT_SWEEP_BATCH: '5' }, admin, resolveRef);
    expect(phase).toMatchObject({ mode: 'dry-run', batch: 5 });
    expect(orphanAttachmentSweepFor({ ORPHAN_ATTACHMENT_SWEEP: 'dry-run', ORPHAN_ATTACHMENT_SWEEP_BATCH: 'lots' }, admin, resolveRef)).not.toHaveProperty('batch');
    // A scope the directory does not hold is refused before any script is asked.
    const t = tenantId.parse(ulid());
    const s = scopeId.parse(ulid());
    expect(await phase!.sweepScopeFn(t, s, { dryRun: true })).toEqual({ refused: expect.stringMatching(/not on record/) });
  });
});
