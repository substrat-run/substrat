import { describe, expect, it } from 'vitest';
import { errorCodeOf, permissionKey, toProblem } from '@substrat-run/contracts';
import { PermissionDenied, SecretBoxUnconfiguredError } from '../src/index.js';

/**
 * The kernel's two long-standing error classes, joined to the taxonomy (#113 phase 2).
 *
 * The point of the join is that a transport stops needing to know these classes exist:
 * it asks for the code. The point of the assertions below is that joining them changed
 * nothing else — same names, same messages, same public fields — because both are
 * matched by name in code this change does not touch.
 */
describe('PermissionDenied', () => {
  const PERM = permissionKey.parse('customer:manage');

  it('keeps its name and message', () => {
    const err = new PermissionDenied('permission denied: customer:manage');
    expect(err.name).toBe('PermissionDenied');
    expect(err.message).toBe('permission denied: customer:manage');
    expect(err).toBeInstanceOf(Error);
  });

  it('answers the taxonomy without anyone importing the class', () => {
    const err = new PermissionDenied('permission denied: customer:manage');
    expect(errorCodeOf(err)).toBe('permission_denied');
    expect(toProblem(err).status).toBe(403);
  });

  it('still carries the permission and node it was refused at (K-35)', () => {
    const node = { tenantId: null, scopeId: null } as never;
    const err = new PermissionDenied('permission denied: customer:manage', {
      permission: PERM,
      node,
    });
    expect(err.permission).toBe(PERM);
    expect(err.node).toBe(node);
    // And the permission reaches the wire body, in-process, as a declared extension.
    expect(toProblem(err).permission).toBe(PERM);
  });

  it('carries no extension when thrown message-only, exactly as before', () => {
    const err = new PermissionDenied('my own policy says no');
    expect(err.permission).toBeUndefined();
    expect(toProblem(err).permission).toBeUndefined();
  });
});

describe('SecretBoxUnconfiguredError', () => {
  it('is a 503 — a deployment fact, not a fault in the request', () => {
    const err = new SecretBoxUnconfiguredError('no seal key configured: set PLATFORM_SECRET');
    expect(err.name).toBe('SecretBoxUnconfiguredError');
    expect(errorCodeOf(err)).toBe('unavailable');

    const body = toProblem(err);
    expect(body.status).toBe(503);
    // The message names what to set and carries no secret, so it reaches the caller.
    expect(body.detail).toContain('PLATFORM_SECRET');
  });
});
