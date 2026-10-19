import { describe, it, expect } from 'vitest';
import { defineOperations, z } from '@substrat-run/contracts';
import { INVITES_PERM } from '@substrat-run/engine-invites';
import { DASHBOARD_PERM, DASHBOARD_PERMISSIONS } from '../src/module.js';

/**
 * The keys a dashboard operation may declare are the dashboard's own six. The brand on a
 * `PermissionKey` is the same type for every key, so the allow-list `defineOperations` is handed
 * has to carry each key as a literal; these are the compile-time checks that it does.
 */
describe('dashboard operation permission keys', () => {
  it('admits each of the dashboard’s own keys', () => {
    const ops = defineOperations({}, DASHBOARD_PERMISSIONS)({
      'dashboard/probe': {
        summary: 'A probe',
        permission: DASHBOARD_PERM.read,
        output: z.object({}),
      },
    });
    expect(Object.keys(ops)).toEqual(['dashboard/probe']);
  });

  it('refuses a key the dashboard does not own', () => {
    defineOperations({}, DASHBOARD_PERMISSIONS)({
      'dashboard/probe': {
        summary: 'A probe',
        // @ts-expect-error — an invites key is not one of the dashboard's keys
        permission: INVITES_PERM.read,
        output: z.object({}),
      },
    });
  });
});
