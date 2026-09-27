/**
 * The reserved event types (#1864) and the two checks that read them: `ctx.emit` refuses a
 * member from module code, and the kernel's writer refuses a NON-member — so a kernel event
 * added without joining the set fails the first contract test that drives it.
 */
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_ADDED, ATTACHMENT_REMOVED } from '../src/attachments.js';
import { CAPABILITY_EXERCISED, CAPABILITY_MINTED, CAPABILITY_REVOKED } from '../src/capability.js';
import { errorCodeOf } from '../src/errors.js';
import {
  KERNEL_AUTHORED_EVENT_TYPES,
  assertKernelAuthoredType,
  assertModuleEmittableType,
} from '../src/kernel-events.js';
import { ENTITY_LINKED, ENTITY_RELINKED } from '../src/permission.js';

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (err) {
    return errorCodeOf(err);
  }
  return undefined;
};

describe('kernel-authored event types (#1864)', () => {
  it('is exactly the seven types the kernel writes', () => {
    expect([...KERNEL_AUTHORED_EVENT_TYPES].sort()).toEqual(
      [
        ATTACHMENT_ADDED,
        ATTACHMENT_REMOVED,
        CAPABILITY_EXERCISED,
        CAPABILITY_MINTED,
        CAPABILITY_REVOKED,
        ENTITY_LINKED,
        ENTITY_RELINKED,
      ].sort(),
    );
  });

  it.each([...KERNEL_AUTHORED_EVENT_TYPES])('module code may not emit %s; the kernel may', (type) => {
    expect(codeOf(() => assertModuleEmittableType(type))).toBe('validation_failed');
    expect(codeOf(() => assertKernelAuthoredType(type))).toBeUndefined();
  });

  it('the twin: an ordinary type is module code\'s, and the kernel writer refuses it', () => {
    expect(codeOf(() => assertModuleEmittableType('todo.list-shared'))).toBeUndefined();
    expect(codeOf(() => assertKernelAuthoredType('todo.list-shared'))).toBe('internal');
  });
});
