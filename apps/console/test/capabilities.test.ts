import { describe, expect, it } from 'vitest';
import { capabilityStatus, type CapabilityRecord } from '@substrat-run/contracts';
import {
  STATUS_LABEL,
  appendPage,
  authorLine,
  coverageLine,
  grantLine,
  operationsLine,
  capabilityTone,
  revocable,
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
    expect(grantLine(act({ permissions: ['doc:read', 'doc:write'] } as Partial<CapabilityRecord>))).toBe(
      'doc:read, doc:write on folder:F1',
    );
    expect(grantLine(become())).toBe('becomes 01J0000000000000000000SEAT');
    expect(operationsLine(act())).toBe('any the keys allow');
    expect(operationsLine(act({ operations: ['doc/read', 'doc/list'] } as Partial<CapabilityRecord>))).toBe('doc/read, doc/list');
    expect(operationsLine(become())).toBe('—');
  });

  it('shows a narrowed link’s attachment opt-in beside its operations', () => {
    const narrowed = { operations: ['cap/read'] } as Partial<CapabilityRecord>;
    expect(operationsLine(act({ ...narrowed, attachments: 'read' } as Partial<CapabilityRecord>))).toBe(
      'cap/read + attachments: read',
    );
    expect(operationsLine(act({ ...narrowed, attachments: null } as Partial<CapabilityRecord>))).toBe('cap/read');
    expect(operationsLine(act(narrowed))).toBe('cap/read');
    expect(operationsLine(act({ attachments: 'read' } as Partial<CapabilityRecord>))).toBe('any the keys allow');
  });

  it('two links on one entity with different key sets read differently — the keys are the authority', () => {
    const a = act({ permissions: ['doc:read', 'doc:write'] } as Partial<CapabilityRecord>);
    const b = act({ permissions: ['doc:read', 'doc:delete'] } as Partial<CapabilityRecord>);
    expect(grantLine(a)).not.toBe(grantLine(b));
    // Every key is in the line, none is summarised away.
    for (const key of ['doc:read', 'doc:write']) expect(grantLine(a)).toContain(key);
    for (const key of ['doc:read', 'doc:delete']) expect(grantLine(b)).toContain(key);
    // The twin: identical key sets read identically.
    expect(grantLine(a)).toBe(grantLine(act({ permissions: ['doc:read', 'doc:write'] } as Partial<CapabilityRecord>)));
  });

  it('says when it is showing a page rather than everything', () => {
    expect(coverageLine(50, true)).toBe('Showing the newest 50 capabilities; older ones follow.');
    expect(coverageLine(50, false)).toBe('50 capabilities.');
    expect(coverageLine(1, false)).toBe('1 capability.');
  });

  it('appends the next page by id, so a repeated row is not shown twice', () => {
    const one = act({ id: '01J0000000000000000000AAA1' } as Partial<CapabilityRecord>);
    const two = act({ id: '01J0000000000000000000AAA2' } as Partial<CapabilityRecord>);
    const three = act({ id: '01J0000000000000000000AAA3' } as Partial<CapabilityRecord>);
    expect(appendPage([one, two], [three]).map((r) => r.id)).toEqual([one.id, two.id, three.id]);
    expect(appendPage([one, two], [two, three]).map((r) => r.id)).toEqual([one.id, two.id, three.id]);
    expect(appendPage([one], [])).toEqual([one]);
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

describe('which capabilities the card offers to revoke (#1686)', () => {
  it('a live one, and a used-up one whose sessions still act', () => {
    expect(revocable(capabilityStatus(act(), NOW))).toBe(true);
    expect(revocable(capabilityStatus(act({ maxUses: 1, uses: 1 }), NOW))).toBe(true);
  });

  it('twin: never a revoked or an expired one, which act for nobody', () => {
    expect(revocable(capabilityStatus(act({ revokedAt: NOW as never, revokedBy: { platform: common.mintedBy } as never }), NOW))).toBe(false);
    expect(revocable(capabilityStatus(act({ expiresAt: '2026-10-01T12:00:00.000Z' as never }), NOW))).toBe(false);
  });
});
