import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ControlPlaneError, type StoreDriverApprovalView, type StoreDriverRevokeResultView } from '@substrat-run/control-plane-client';
import {
  approvalFromFiles, approvalLines, approvalStatusLines, revokeStoreDriverUntilComplete,
  storeDriverReviewText, uploadApprovalLine, validateStoreDriverApproval,
} from '../src/store-driver-approval.js';

const sha256 = 'a'.repeat(64);
const commit = 'b'.repeat(40);
const body = () => ({
  reason: 'Reviewed release',
  sourceReferences: [{ repository: 'https://example.test/driver.git', commit }],
  isolationReview: {
    separateScriptPerTenant: { met: false, evidence: 'One script per vertical' },
    noOutboundAccess: { met: false, evidence: 'Network is still available' },
    envelopeVerifiedOutsideDriver: { met: true, evidence: 'Verified outside driver' },
    envelopeChecked: { checked: true as const, evidence: 'Read envelope' },
    reservedOperationsChecked: { checked: true as const, evidence: 'Read reserved operations' },
    noModuleStateChecked: { checked: true as const, evidence: 'Read module state' },
  },
  schema: 0, className: 'Store', operations: ['read', 'graph.lookup'],
});

const approval = (revoked = false): StoreDriverApprovalView => ({
  approvalId: revoked ? 'approval-2' : 'approval-1', driver: 'graph', sha256, sourceCommit: commit,
  approvedBy: 'staff-1', approvedAt: '2026-10-28T00:00:00Z', reason: 'Reviewed release',
  sourceReferences: body().sourceReferences, isolationReview: body().isolationReview,
  schema: 0, className: 'Store', operations: ['read'],
  revokedBy: revoked ? 'staff-2' : null, revokedAt: revoked ? '2026-10-29T00:00:00Z' : null,
  revokedReason: revoked ? 'Rolled back' : null, revokedEmergency: revoked ? false : null,
});

describe('store-driver approval CLI input', () => {
  it('accepts exact server-shaped review data and reads the two JSON files without prompts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'store-driver-approval-'));
    try {
      const sources = join(dir, 'sources.json');
      const review = join(dir, 'review.json');
      writeFileSync(sources, JSON.stringify(body().sourceReferences));
      writeFileSync(review, JSON.stringify(body().isolationReview));
      expect(approvalFromFiles({ reason: body().reason, sourceReferencesFile: sources,
        isolationReviewFile: review, schema: '0', className: 'Store', operations: ['read', 'graph.lookup'] })).toEqual(body());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates repository and commit shapes and every recorded text field before sending', () => {
    expect(validateStoreDriverApproval(body())).toEqual(body());
    const badSources = [
      { repository: 'http://example.test/driver', commit },
      { repository: 'https://name@example.test/driver', commit },
      { repository: 'https://example.test/', commit },
      { repository: 'https://example.test/driver?view=1', commit },
      { repository: 'https://example.test/driver#head', commit },
      { repository: 'https://example.test/driver\\branch', commit },
      { repository: 'https://example.test/driver', commit: commit.toUpperCase() },
      { repository: 'https://example.test/driver', commit: 'a'.repeat(39) },
    ];
    for (const source of badSources) expect(() => validateStoreDriverApproval({ ...body(), sourceReferences: [source] })).toThrow();
    for (const mark of ['\u0085', '\u202e', '\u200b', '\u2028']) {
      const cases = [
        { ...body(), reason: `review${mark}` },
        { ...body(), className: `Sto${mark}re` },
        { ...body(), operations: [`re${mark}ad`] },
        { ...body(), sourceReferences: [{ repository: `https://example.test/driver${mark}`, commit }] },
        { ...body(), sourceReferences: [{ repository: 'https://example.test/driver', commit: `${commit.slice(0, -1)}${mark}` }] },
        { ...body(), isolationReview: { ...body().isolationReview, envelopeChecked: { checked: true, evidence: `read${mark}` } } },
      ];
      for (const candidate of cases) expect(() => validateStoreDriverApproval(candidate)).toThrow();
      expect(() => storeDriverReviewText(`revoke${mark}`, 'reason')).toThrow();
    }
    for (const className of ['9Store', 'Store.Name', 'Store Name']) {
      expect(() => validateStoreDriverApproval({ ...body(), className })).toThrow(/className/);
    }
    expect(() => validateStoreDriverApproval({ ...body(), operations: ['read:name'] })).toThrow(/operations/);
    expect(() => validateStoreDriverApproval({ ...body(), isolationReview: { ...body().isolationReview, extra: true } })).toThrow();
  });
});

describe('store-driver approval CLI output and revoke continuation', () => {
  it('names the approval command after upload and shows live and revoked rows in status', () => {
    expect(uploadApprovalLine('graph', sha256)).toContain(`substrat store-driver approve --driver graph --sha256 ${sha256}`);
    expect(uploadApprovalLine('graph', sha256)).toContain('upload alone does not make these bytes runnable');
    expect(approvalLines({ approval: approval(), currentSchema: null })).toEqual([
      `✓ approved graph ${sha256} (approval approval-1)`, '  schema 0; current good schema none',
    ]);
    const lines = approvalStatusLines({ driver: 'graph', pins: [], current: null, rollouts: [], rollbackTarget: null,
      unfinishedRollback: null, approvals: [approval(), approval(true)] });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('live');
    expect(lines[1]).toContain('revoked');
    expect(lines[1]).toContain('Rolled back');
  });

  it('posts every revoke page with the same reason and reports remaining progress', async () => {
    const results: StoreDriverRevokeResultView[] = [
      { approval: approval(), complete: false, remaining: 2 },
      { approval: approval(), complete: false, remaining: 1 },
      { approval: approval(true), complete: true, remaining: 0 },
    ];
    const call = vi.fn(async () => results.shift()!);
    const lines: string[] = [];
    await revokeStoreDriverUntilComplete({ client: { revokeStoreDriverRelease: call }, driver: 'graph', sha256,
      reason: 'Reviewed rollback', emergency: false, progress: (line) => lines.push(line) });
    expect(call).toHaveBeenCalledTimes(3);
    expect(call).toHaveBeenNthCalledWith(1, 'graph', sha256, { reason: 'Reviewed rollback' });
    expect(call).toHaveBeenNthCalledWith(2, 'graph', sha256, { reason: 'Reviewed rollback' });
    expect(call).toHaveBeenNthCalledWith(3, 'graph', sha256, { reason: 'Reviewed rollback' });
    expect(lines).toEqual([
      '  revoke walk paused: 2 script(s) remaining; continuing',
      '  revoke walk paused: 1 script(s) remaining; continuing',
      `✓ revoked approval approval-2 for graph ${sha256}`,
    ]);
  });

  it('stops after three consecutive pages without decreasing remaining', async () => {
    const call = vi.fn(async () => ({ approval: approval(), complete: false, remaining: 5 }));
    await expect(revokeStoreDriverUntilComplete({ client: { revokeStoreDriverRelease: call }, driver: 'graph', sha256,
      reason: 'Reviewed rollback', emergency: false, progress: vi.fn() }))
      .rejects.toThrow(/5 script\(s\) remaining; run the same command again, or check store-driver status/);
    expect(call).toHaveBeenCalledTimes(4);
  });

  it('shows the server 403 unchanged and gives a retry for a lost hold', async () => {
    const progress = vi.fn();
    const input = { driver: 'graph', sha256, reason: 'Reviewed rollback', emergency: false, progress };
    const denied = new ControlPlaneError(403, 'a store driver release is revoked by a person: this takes a staff sign-in, not a service token');
    await expect(revokeStoreDriverUntilComplete({ ...input, client: { revokeStoreDriverRelease: async () => { throw denied; } } }))
      .rejects.toThrow(denied.message);
    const held = new ControlPlaneError(409, "the hold on driver 'graph' lapsed");
    await expect(revokeStoreDriverUntilComplete({ ...input, client: { revokeStoreDriverRelease: async () => { throw held; } } }))
      .rejects.toThrow(/retry the same store-driver revoke command/);
    expect(progress).not.toHaveBeenCalled();
  });
});
