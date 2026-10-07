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
  isKernelAuthoredEventType,
} from '../src/kernel-events.js';
import { ENTITY_GRANTS_RETIRED, ENTITY_GRANTS_TOPPED_UP, ENTITY_LINKED, ENTITY_RELINKED } from '../src/permission.js';
import { ENTITY_ARCHIVED, ENTITY_RESTORED, ENTITY_TRASHED, ENTITY_UNARCHIVED } from '../src/entity-state.js';

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (err) {
    return errorCodeOf(err);
  }
  return undefined;
};

describe('kernel-authored event types (#1864)', () => {
  it('is exactly the thirteen types the kernel writes', () => {
    expect([...KERNEL_AUTHORED_EVENT_TYPES].sort()).toEqual(
      [
        ATTACHMENT_ADDED,
        ATTACHMENT_REMOVED,
        CAPABILITY_EXERCISED,
        CAPABILITY_MINTED,
        CAPABILITY_REVOKED,
        ENTITY_LINKED,
        ENTITY_RELINKED,
        // #119: an archive or trash move is the kernel's record, never module code's.
        ENTITY_ARCHIVED,
        ENTITY_UNARCHIVED,
        ENTITY_TRASHED,
        ENTITY_RESTORED,
        // #2071: a declared shape's top-up is the kernel's record of a grant nobody's operation made.
        ENTITY_GRANTS_TOPPED_UP,
        // #2082: and so is a retirement — a grant taken back by the reviewed registry, no operation.
        ENTITY_GRANTS_RETIRED,
      ].sort(),
    );
  });

  it.each([...KERNEL_AUTHORED_EVENT_TYPES])('module code may not emit %s; the kernel may', (type) => {
    expect(codeOf(() => assertModuleEmittableType(type))).toBe('validation_failed');
    expect(codeOf(() => assertKernelAuthoredType(type))).toBeUndefined();
  });

  /**
   * Module code is bundled with contracts into the same worker, so whatever this package
   * exports it can cast and mutate. None of that may change what is refused.
   */
  it('mutating the exported list changes nothing the guards refuse', () => {
    const exported = KERNEL_AUTHORED_EVENT_TYPES as unknown as {
      splice(start: number): unknown;
      push(v: string): unknown;
      length: number;
      delete?: (v: string) => unknown;
      clear?: () => unknown;
      add?: (v: string) => unknown;
    };
    const attempts: (() => unknown)[] = [
      () => exported.splice(0),
      () => exported.push('todo.list-shared'),
      () => (exported.length = 0),
      () => exported.delete?.(ENTITY_RELINKED),
      () => exported.clear?.(),
      () => exported.add?.('todo.list-shared'),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch {
        // a frozen array throws in strict mode; either way, nothing may have changed
      }
    }
    expect(KERNEL_AUTHORED_EVENT_TYPES).toHaveLength(13);
    for (const type of [ENTITY_RELINKED, ENTITY_LINKED, CAPABILITY_MINTED, ATTACHMENT_ADDED]) {
      expect(codeOf(() => assertModuleEmittableType(type))).toBe('validation_failed');
      expect(isKernelAuthoredEventType(type)).toBe(true);
    }
    // The twin: pushing an ordinary type into the export did not make it kernel-authored.
    expect(codeOf(() => assertKernelAuthoredType('todo.list-shared'))).toBe('internal');
    expect(isKernelAuthoredEventType('todo.list-shared')).toBe(false);
  });

  it('the twin: an ordinary type is module code\'s, and the kernel writer refuses it', () => {
    expect(codeOf(() => assertModuleEmittableType('todo.list-shared'))).toBeUndefined();
    expect(codeOf(() => assertKernelAuthoredType('todo.list-shared'))).toBe('internal');
  });
});
