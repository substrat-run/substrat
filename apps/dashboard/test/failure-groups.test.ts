import { describe, expect, it } from 'vitest';
import { instant, opsFailureFingerprint, platformActorId, type OpsFailureEntry } from '@substrat-run/contracts';
import { deriveFailureGroups } from '../src/failure-groups.js';

const actor = platformActorId.parse('01ARZ3NDEKTSV4RRFFQ69G5FAV');

/** A failure row as the plane answers it, newest-first ordering left to the caller. */
function row(over: Partial<Omit<OpsFailureEntry, 'at'>> & { at: string }): OpsFailureEntry {
  const base = {
    id: over.at.replace(/\D/g, ''),
    actor,
    operation: 'preview.create',
    stage: 'restore',
    tenantId: null,
    scopeId: null,
    vertical: 'acme/crm',
    version: null,
    status: 502,
    origin: 'platform' as const,
    code: 'unavailable' as const,
    message: 'internal error',
    reference: null,
    fingerprint: null as string | null,
    ...over,
    at: instant.parse(over.at),
  };
  return { ...base, fingerprint: base.fingerprint ?? opsFailureFingerprint(base) };
}

describe('deriveFailureGroups (#1233, the builder slice)', () => {
  it('groups recurring shapes, keeping the newest evidence on top', () => {
    const groups = deriveFailureGroups([
      row({ at: '2026-09-08T12:00:00Z', message: 'newest restore fault' }),
      row({ at: '2026-09-07T12:00:00Z', message: 'older restore fault' }),
      row({ at: '2026-09-06T12:00:00Z', message: 'oldest restore fault' }),
      row({ at: '2026-09-05T12:00:00Z', operation: 'deploy.upload', stage: 'wfp-upload', code: null, origin: 'provider', status: 422, message: 'rejected' }),
    ]);
    expect(groups).toHaveLength(2);
    // Newest last-seen first, and the group carries its newest row's sample.
    expect(groups[0]).toMatchObject({
      operation: 'preview.create',
      count: 3,
      firstSeen: '2026-09-06T12:00:00.000Z',
      lastSeen: '2026-09-08T12:00:00.000Z',
      lastMessage: 'newest restore fault',
      lastStatus: 502,
    });
    expect(groups[1]).toMatchObject({ operation: 'deploy.upload', count: 1 });
  });

  it('groups a pre-fingerprint row (null column) with its post-fingerprint siblings', () => {
    // A row written before #1290 has no stored fingerprint; the derivation
    // computes the same key from (operation, stage, code), so old evidence
    // joins the group instead of standing alone.
    const groups = deriveFailureGroups([
      row({ at: '2026-09-08T10:00:00Z' }),
      row({ at: '2026-09-01T10:00:00Z', fingerprint: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);
    expect(groups[0]!.firstSeen).toBe('2026-09-01T10:00:00.000Z');
  });

  it('distinguishes shapes by code — a different defect is a different group', () => {
    const groups = deriveFailureGroups([
      row({ at: '2026-09-08T10:00:00Z', code: 'unavailable' }),
      row({ at: '2026-09-08T09:00:00Z', code: 'permission_denied' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('keeps the newest classification but backfills origin from older rows', () => {
    // The newest row's writer could not classify; an older row could. The group
    // says what is known — the same COALESCE the staff store applies at ingest.
    const groups = deriveFailureGroups([
      row({ at: '2026-09-08T10:00:00Z', origin: null }),
      row({ at: '2026-09-07T10:00:00Z', origin: 'provider' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.origin).toBe('provider');
  });
});
