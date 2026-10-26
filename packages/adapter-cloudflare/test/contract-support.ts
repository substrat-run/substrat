// The directory faults the kill-switch suites (contract-switch.test.ts) and the peer suite
// (contract-data.test.ts) both hand their fixtures.
import { env, runInDurableObject } from 'cloudflare:test';
import { adminRowFaultSql, switchRecordFaultSql } from '@substrat-run/contract-tests';

/**
 * #2089: the kill-switch suites' outcome-row fault — a trigger on the directory singleton the
 * host writes its admin log to, scoped to one scope and one phase.
 */
const execDirectorySql = (sql: string) =>
  runInDurableObject(env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName('control-plane')), (_i, state) => {
    state.storage.sql.exec(sql);
  });

export const refuseAdminRows = async (scope: string, phase: string) => {
  const { create, drop } = adminRowFaultSql(scope, phase);
  await execDirectorySql(create);
  return () => execDirectorySql(drop);
};

export const refuseSwitchRecord = async (scope: string, kind: 'system' | 'peer') => {
  const { create, drop } = switchRecordFaultSql(scope, kind);
  for (const sql of create) await execDirectorySql(sql);
  return async () => { for (const sql of drop) await execDirectorySql(sql); };
};
