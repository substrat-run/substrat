import type { DashboardClient, FindingEntry, FindingRuleEntry } from './api.generated';

/** The preview's inbox (DEV_MOCK): one finding in each tab, acted on in memory only. */
export type FindingsClient = Pick<
  DashboardClient,
  'listFindings' | 'setFindingStatus' | 'listFindingRules' | 'createFindingRule' | 'revokeFindingRule'
>;

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const base: Omit<FindingEntry, 'id' | 'status' | 'title' | 'subject'> = {
  tenantId: 'MOCKTEAM',
  kind: 'recurring',
  regressed: false,
  severity: 'warning',
  operation: null,
  codes: [],
  vertical: null,
  scopeId: null,
  count: 1,
  firstSeen: ago(600),
  lastSeen: ago(5),
  lastVersion: null,
  resolvedVersion: null,
  resolvedAt: null,
  resolution: null,
  acknowledgedAt: null,
  ruleId: null,
  evidence: { source: 'ops-failures', fingerprint: 'mock' },
  likelyCause: null,
};

export function mockFindingsClient(): FindingsClient {
  let entries: FindingEntry[] = [
    { ...base, id: 'F1', status: 'open', severity: 'critical', title: 'conflict on helpdesk/assign-ticket', subject: 'helpdesk/assign-ticket', operation: 'helpdesk/assign-ticket', codes: ['conflict'], count: 42, regressed: true, likelyCause: { kind: 'deploy', version: 'v14', reason: 'onset 41 s after rollout of v14' } },
    { ...base, id: 'F2', status: 'open', title: 'helpdesk/sync-mailbox is late', subject: 'helpdesk/sync-mailbox', kind: 'drift', evidence: { source: 'sweep-runs', kind: 'schedule', unit: 'helpdesk/sync-mailbox' } },
    { ...base, id: 'F3', status: 'acked', title: 'internal on helpdesk/send-reply', subject: 'helpdesk/send-reply', operation: 'helpdesk/send-reply', codes: ['internal'], count: 3, acknowledgedAt: ago(30) },
    { ...base, id: 'F4', status: 'resolved', severity: 'info', title: 'validation_failed on helpdesk/create-ticket', subject: 'helpdesk/create-ticket', operation: 'helpdesk/create-ticket', codes: ['validation_failed'], resolvedAt: ago(120), resolution: 'verdict' },
    { ...base, id: 'F5', status: 'suppressed', title: 'not_found on helpdesk/get-ticket', subject: 'helpdesk/get-ticket', operation: 'helpdesk/get-ticket', codes: ['not_found'], ruleId: 'R1' },
  ];
  let rules: FindingRuleEntry[] = [
    { id: 'R1', tenantId: 'MOCKTEAM', kind: null, operation: 'helpdesk/get-ticket', code: 'not_found', subject: null, expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), reason: 'Crawler noise', createdBy: 'you', createdAt: ago(1000) },
  ];
  return {
    listFindings: async () => ({ available: true, entries }),
    setFindingStatus: async ({ id, status }) => {
      const next = { ...entries.find((e) => e.id === id)!, status };
      entries = entries.map((e) => (e.id === id ? next : e));
      return next;
    },
    listFindingRules: async ({ active }) => ({ entries: active ? rules.filter((r) => Date.parse(r.expiresAt) > Date.now()) : rules }),
    createFindingRule: async (input) => {
      const rule: FindingRuleEntry = { id: `R${rules.length + 1}`, tenantId: 'MOCKTEAM', kind: input.kind ?? null, operation: input.operation ?? null, code: input.code ?? null, subject: input.subject ?? null, expiresAt: input.expiresAt, reason: input.reason, createdBy: 'you', createdAt: new Date().toISOString() };
      rules = [...rules, rule];
      let suppressed = 0;
      entries = entries.map((e) => {
        // The plane's UPDATE (kernel findings.ts createFindingRule): every scope field a rule carries must
        // match, an absent one is a wildcard, `code` is membership in the finding's codes, `subject` is
        // exact. Only a resolved finding is left alone; an already suppressed one moves to the new rule.
        const hit =
          e.status !== 'resolved' &&
          (rule.kind === null || e.kind === rule.kind) &&
          (rule.operation === null || e.operation === rule.operation) &&
          (rule.code === null || e.codes.includes(rule.code)) &&
          (rule.subject === null || e.subject === rule.subject);
        if (hit) suppressed += 1;
        return hit ? { ...e, status: 'suppressed', ruleId: rule.id } : e;
      });
      return { rule, suppressed };
    },
    revokeFindingRule: async ({ ruleId }) => {
      // Like the plane: a revoked rule is not deleted, its expiry is pulled back to now.
      const ended = { ...rules.find((r) => r.id === ruleId)!, expiresAt: new Date().toISOString() };
      rules = rules.map((r) => (r.id === ruleId ? ended : r));
      return ended;
    },
  };
}
