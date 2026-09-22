import { describe, expect, it } from 'vitest';
import {
  CONNECTION_EXPIRY_WARNING_DAYS,
  CONNECTION_STALE_DAYS,
  connection,
  connectionHealthEntry,
  deriveConnectionHealth,
  deriveExpiryWarning,
  toConnectionHealthEntry,
  type Connection,
} from '../src/index.js';

/**
 * The connection health derivation (#1690). Every state, and both sides of every
 * boundary — a derivation whose edges are untested reads "healthy" for a
 * connection that is not, which is the one mistake this exists to prevent.
 */
const NOW = '2026-09-22T12:00:00.000Z';
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const ahead = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

const outcomes = (
  lastOkAt: string | null,
  lastErrorAt: string | null,
  status: Connection['status'] = 'active',
): Pick<Connection, 'status' | 'lastOkAt' | 'lastErrorAt'> => ({ status, lastOkAt, lastErrorAt });

describe('deriveConnectionHealth', () => {
  it('no outcome at all is never-used — not healthy (§3.8, #605)', () => {
    expect(deriveConnectionHealth(outcomes(null, null), NOW)).toBe('never-used');
  });

  it('a recent success is healthy', () => {
    expect(deriveConnectionHealth(outcomes(ago(60_000), null), NOW)).toBe('healthy');
  });

  it('an error with no success ever is erroring, not never-used', () => {
    expect(deriveConnectionHealth(outcomes(null, ago(60_000)), NOW)).toBe('erroring');
  });

  it('the latest outcome decides between a success and an error', () => {
    expect(deriveConnectionHealth(outcomes(ago(2 * DAY), ago(DAY)), NOW)).toBe('erroring');
    expect(deriveConnectionHealth(outcomes(ago(DAY), ago(2 * DAY)), NOW)).toBe('healthy');
  });

  it('a tie between a success and an error resolves to erroring', () => {
    const at = ago(DAY);
    expect(deriveConnectionHealth(outcomes(at, at), NOW)).toBe('erroring');
  });

  it('an error older than the stale window is still erroring, never stale', () => {
    expect(deriveConnectionHealth(outcomes(null, ago(30 * DAY)), NOW)).toBe('erroring');
  });

  it('the stale boundary: one ms inside is healthy, exactly at it is stale', () => {
    const window = CONNECTION_STALE_DAYS * DAY;
    expect(deriveConnectionHealth(outcomes(ago(window - 1), null), NOW)).toBe('healthy');
    expect(deriveConnectionHealth(outcomes(ago(window), null), NOW)).toBe('stale');
    expect(deriveConnectionHealth(outcomes(ago(window + DAY), null), NOW)).toBe('stale');
  });

  it('the stale window is a parameter, defaulting to the stated seven days', () => {
    expect(CONNECTION_STALE_DAYS).toBe(7);
    expect(deriveConnectionHealth(outcomes(ago(10 * DAY), null), NOW, 30)).toBe('healthy');
  });

  it('a lapsed grant (status expired) is erroring whatever the outcomes say', () => {
    expect(deriveConnectionHealth(outcomes(ago(60_000), null, 'expired'), NOW)).toBe('erroring');
    expect(deriveConnectionHealth(outcomes(null, null, 'expired'), NOW)).toBe('erroring');
  });

  it('accepts a Date for now as well as an instant string', () => {
    expect(deriveConnectionHealth(outcomes(ago(60_000), null), new Date(NOW))).toBe('healthy');
  });
});

describe('deriveExpiryWarning', () => {
  const window = CONNECTION_EXPIRY_WARNING_DAYS * DAY;

  it('no recorded expiry is no warning', () => {
    expect(deriveExpiryWarning(null, NOW)).toBeNull();
  });

  it('outside the window is no warning; at and inside it is soon', () => {
    expect(deriveExpiryWarning(ahead(window + 1), NOW)).toBeNull();
    expect(deriveExpiryWarning(ahead(window), NOW)).toBe('soon');
    expect(deriveExpiryWarning(ahead(1), NOW)).toBe('soon');
  });

  it('at or past the expiry is expired', () => {
    expect(deriveExpiryWarning(NOW, NOW)).toBe('expired');
    expect(deriveExpiryWarning(ago(DAY), NOW)).toBe('expired');
  });
});

describe('toConnectionHealthEntry', () => {
  const row = connection.parse({
    id: '01JZ0000000000000000000001',
    tenantId: '01JZ0000000000000000000002',
    vertical: 'callout',
    provider: 'scrive',
    label: 'Acme Scrive (prod)',
    status: 'active',
    externalAccountRef: 'acct-1',
    scopes: ['doc:send'],
    expiresAt: ahead(DAY),
    lastOkAt: ago(60_000),
    lastError: null,
    lastErrorAt: null,
    createdBy: '01JZ0000000000000000000003',
    createdAt: ago(10 * DAY),
    revokedAt: null,
  });

  it('carries exactly the allow-list — no createdBy, scopes or revokedAt', () => {
    const entry = toConnectionHealthEntry(row, NOW);
    expect(Object.keys(entry).sort()).toEqual(Object.keys(connectionHealthEntry.shape).sort());
    expect(entry).not.toHaveProperty('createdBy');
    expect(entry).not.toHaveProperty('scopes');
    expect(entry).not.toHaveProperty('revokedAt');
    expect(entry.health).toBe('healthy');
    expect(entry.expiryWarning).toBe('soon');
    expect(connectionHealthEntry.parse(entry)).toEqual(entry);
  });

  it('ignores anything a widened row carries beyond the contract', () => {
    const widened = { ...row, secret: { token: 'tok-live' }, ciphertext: 'sealed' } as unknown as Connection;
    expect(JSON.stringify(toConnectionHealthEntry(widened, NOW))).not.toMatch(/tok-live|sealed|secret|ciphertext/);
  });

  it('the entry schema refuses a widened row (strict)', () => {
    expect(() => connectionHealthEntry.parse({ ...toConnectionHealthEntry(row, NOW), createdBy: 'x' })).toThrow();
  });
});
