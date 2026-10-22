import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_CHECK_CAP, AUTH_DIAGNOSTICS_KEY, authChecksOf, recordAuthCheck, tallyAuthCheck, type AuthCheck, type AuthRecording } from '../src/auth-diagnostics.js';

const slots = globalThis as Record<symbol, unknown>;
const original = slots[AUTH_DIAGNOSTICS_KEY];
afterEach(() => { slots[AUTH_DIAGNOSTICS_KEY] = original; });
const check: AuthCheck = { stage: 'bearer', outcome: 'refused', reason: 'issuer-invalid' };

describe('auth diagnostics boundary', () => {
  it('bounds repeated checks and counts overflow', () => {
    const record: AuthRecording = {};
    for (let i = 0; i < AUTH_CHECK_CAP + 3; i++) tallyAuthCheck(record, check);
    expect(record.authChecks).toHaveLength(AUTH_CHECK_CAP);
    expect(record.authChecksDropped).toBe(3);
  });

  it('copies only the vocabulary on write and read, never messages or credential values', () => {
    const extra = { ...check, token: 'private-token', message: 'private-message', sub: 'private-person' };
    const recorded: AuthCheck[] = [];
    slots[AUTH_DIAGNOSTICS_KEY] = { record: (value: AuthCheck) => recorded.push(value) };
    recordAuthCheck(extra);
    expect(recorded).toEqual([check]);
    expect(authChecksOf([extra, { ...check, reason: 'private-value' }, null])).toEqual([check]);
    expect(authChecksOf(Array(100).fill(extra))).toHaveLength(AUTH_CHECK_CAP);
    expect(authChecksOf(undefined)).toEqual([]);
  });

  it('has no effect without a sink and cannot propagate a sink failure', () => {
    delete slots[AUTH_DIAGNOSTICS_KEY];
    expect(() => recordAuthCheck(check)).not.toThrow();
    slots[AUTH_DIAGNOSTICS_KEY] = { record: () => { throw new Error('broken observer'); } };
    expect(() => recordAuthCheck(check)).not.toThrow();
  });
});
