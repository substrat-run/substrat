import { describe, expect, it } from 'vitest';
import { capabilityStatus, type CapabilityRecord } from '@substrat-run/contracts';
import {
  STATUS_LABEL,
  authorLine,
  grantLine,
  operationsLine,
  capabilityTone,
  usesLine,
} from '../src/lib/capabilities';

const NOW = '2026-10-02T00:00:00.000Z';
const common = {
  id: '01J0000000000000000000CAP0',
  label: null,
  mintedBy: '01J0000000000000000000PRN0',
  mintedAt: '2026-10-01T00:00:00.000Z',
  expiresAt: null,
  maxUses: null,
  uses: 0,
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
};
const act = (over: Partial<CapabilityRecord> = {}): CapabilityRecord =>
  ({
    mode: 'act',
    ...common,
    entity: { entityType: 'folder', entityId: 'F1' },
    permissions: ['doc:read'],
    operations: null,
    ...over,
  }) as CapabilityRecord;
const become = (over: Partial<CapabilityRecord> = {}): CapabilityRecord =>
  ({ mode: 'become', ...common, principal: '01J0000000000000000000SEAT', ...over }) as CapabilityRecord;

describe('the console Capabilities card (#1686)', () => {
  it('names each standing, and a used-up link is a warning rather than finished', () => {
    expect(capabilityStatus(act(), NOW)).toBe('live');
    expect(capabilityStatus(act({ revokedAt: NOW }), NOW)).toBe('revoked');
    expect(capabilityStatus(act({ expiresAt: NOW }), NOW)).toBe('expired');
    expect(capabilityStatus(act({ maxUses: 1, uses: 1 }), NOW)).toBe('used-up');
    expect(capabilityTone('live')).toBe('success');
    expect(capabilityTone('used-up')).toBe('warning');
    expect(capabilityTone('revoked')).toBe('danger');
    expect(capabilityTone('expired')).toBe('neutral');
    expect(STATUS_LABEL['used-up']).toBe('Used up');
  });

  it('says what each kind lets its holder do', () => {
    expect(grantLine(act())).toBe('doc:read on folder:F1');
    expect(grantLine(act({ permissions: ['doc:read', 'doc:write'] } as Partial<CapabilityRecord>))).toBe('2 keys on folder:F1');
    expect(grantLine(become())).toBe('becomes 01J0000000000000000000SEAT');
    expect(operationsLine(act())).toBe('any the keys allow');
    expect(operationsLine(act({ operations: ['doc/read', 'doc/list'] } as Partial<CapabilityRecord>))).toBe('doc/read, doc/list');
    expect(operationsLine(become())).toBe('—');
  });

  it('shows who minted, with the platform actor distinguished from a person, and the use count', () => {
    expect(authorLine('01J0000000000000000000PRN0' as CapabilityRecord['mintedBy'])).toBe('01J0000000000000000000PRN0');
    expect(authorLine({ platform: '01J0000000000000000000STF0' } as CapabilityRecord['mintedBy'])).toBe(
      'platform:01J0000000000000000000STF0',
    );
    expect(usesLine(act({ uses: 3 }))).toBe('3');
    expect(usesLine(act({ uses: 1, maxUses: 4 }))).toBe('1 / 4');
  });
});
