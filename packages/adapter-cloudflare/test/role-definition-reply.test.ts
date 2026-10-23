/**
 * #2447 (review round 1): the coordinator reads the ControlPlaneDO's `defineRole` answer whichever
 * build gave it, so a DO from before #2447 in a deploy's restart window is no TypeError.
 */
import { describe, expect, it } from 'vitest';
import { definedRoleOf } from '../src/role-definition-reply.js';

const role = { key: 'staff', permissions: ['a:use'], source: 'vertical' } as never;

describe('definedRoleOf', () => {
  it('reads the current answers: a refusal, and the previous definition (or none)', () => {
    expect(definedRoleOf({ refused: 'no' })).toEqual({ refused: 'no' });
    expect(definedRoleOf({ before: role })).toEqual({ before: role });
    expect(definedRoleOf({ before: null })).toEqual({ before: null });
  });

  it('reads an older DO’s answer as the previous definition: null for a first definition, the role otherwise, never a refusal', () => {
    expect(definedRoleOf(null)).toEqual({ before: null });
    expect(definedRoleOf(undefined)).toEqual({ before: null });
    expect(definedRoleOf(role)).toEqual({ before: role });
  });
});
