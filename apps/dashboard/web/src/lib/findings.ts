import { ApiError } from './api.generated';
import type { FindingEntry, FindingRuleEntry } from './api.generated';

/**
 * The Findings inbox's logic (#1748), kept out of the view so the rules a reader would
 * otherwise have to infer from JSX — which tab a status belongs to, which moves a status
 * allows, what a suppress rule is built from — are one place and can be asserted on.
 */

export type FindingStatus = FindingEntry['status'];
export type FindingCode = FindingEntry['codes'][number];

/** The inbox's tabs, in the order the design gives them. A tab is a status. */
export const FINDING_TABS: { value: FindingStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'acked', label: 'Acked' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'suppressed', label: 'Suppressed' },
];

/** The tab a URL value names; anything else is the inbox's front door, Open. */
export function tabOf(value: string | undefined): FindingStatus {
  return FINDING_TABS.find((t) => t.value === value)?.value ?? 'open';
}

/**
 * Where each tab's walk stands: the cursor to follow for its next page, or `null` when the plane
 * said the walk is over. A tab is walked on its own (`status` narrows the read), so a long
 * Resolved history never hides the Open tab's older findings behind it.
 */
export type FindingCursors = Record<FindingStatus, string | null>;

/**
 * Fold a page into what is already loaded. By id, the newer copy winning: a finding that moved
 * tab or was seen again since an earlier page is one row, not two. Kept in the plane's order
 * (`lastSeen` descending, `id` ascending on a tie), so a row merged in lands where a fresh read
 * would put it.
 */
export function mergeFindings(have: readonly FindingEntry[], page: readonly FindingEntry[]): FindingEntry[] {
  const byId = new Map(have.map((e) => [e.id, e]));
  for (const e of page) byId.set(e.id, e);
  return [...byId.values()].sort(byRecency);
}

function byRecency(a: FindingEntry, b: FindingEntry): number {
  return Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Whether a tab's count is the team's total for that tab. Only a walk that ran to its end says
 * so: a count over the pages loaded so far is a floor, and a floor shown as a number reads as a total.
 */
export function countIsExact(cursors: FindingCursors, tab: FindingStatus): boolean {
  return cursors[tab] === null;
}

export function countByStatus(entries: readonly FindingEntry[]): Record<FindingStatus, number> {
  const counts: Record<FindingStatus, number> = { open: 0, acked: 0, resolved: 0, suppressed: 0 };
  for (const e of entries) counts[e.status] += 1;
  return counts;
}

/** The tab's findings, most recently seen first (the plane's own order, `id` breaking a tie as it does). */
export function inTab(entries: readonly FindingEntry[], tab: FindingStatus): FindingEntry[] {
  return entries.filter((e) => e.status === tab).sort(byRecency);
}

export type FindingMove = 'acked' | 'resolved' | 'open';

/**
 * The moves a finding in `status` offers. A suppressed finding offers none: it is held by a
 * rule, and the way out is revoking the rule — the plane refuses a status change on it.
 */
export function movesFrom(status: FindingStatus): { to: FindingMove; label: string }[] {
  switch (status) {
    case 'open':
      return [{ to: 'acked', label: 'Acknowledge' }, { to: 'resolved', label: 'Resolve' }];
    case 'acked':
      return [{ to: 'resolved', label: 'Resolve' }, { to: 'open', label: 'Reopen' }];
    case 'resolved':
      return [{ to: 'open', label: 'Reopen' }];
    case 'suppressed':
      return [];
  }
}

/** Whether a finding can be suppressed by hand: only one not already held or settled. */
export function canSuppress(status: FindingStatus): boolean {
  return status === 'open' || status === 'acked';
}

export const EXPIRY_CHOICES = [
  { value: '1', label: '1 day', days: 1 },
  { value: '7', label: '7 days', days: 7 },
  { value: '30', label: '30 days', days: 30 },
] as const;

/** What the dialog collects. `''` is "any" for the three scope dimensions. */
export interface SuppressDraft {
  /** The finding's kind, or `''` for a rule over every kind. */
  kind: '' | FindingEntry['kind'];
  operation: string;
  code: string;
  subject: string;
  days: string;
  reason: string;
}

/** The dialog's starting point: the finding's own scope, a week, no reason yet. */
export function draftFor(f: FindingEntry): SuppressDraft {
  return { kind: f.kind, operation: f.operation ?? '', code: '', subject: '', days: '7', reason: '' };
}

/** The server's cap on a rule's reason (`findingRuleInput`). */
export const REASON_MAX = 500;

/** A rule that narrows nothing would silence every finding, so the dialog refuses it. */
export function draftNarrows(d: SuppressDraft): boolean {
  return d.kind !== '' || d.operation !== '' || d.code !== '' || d.subject !== '';
}

export function draftReady(d: SuppressDraft): boolean {
  return draftNarrows(d) && d.reason.trim() !== '' && d.reason.length <= REASON_MAX && EXPIRY_CHOICES.some((c) => c.value === d.days);
}

/** The `createFindingRule` body for a draft: only the set dimensions, and the expiry as an instant. */
export function ruleInput(d: SuppressDraft, now: number) {
  const days = EXPIRY_CHOICES.find((c) => c.value === d.days)?.days ?? 7;
  return {
    ...(d.kind ? { kind: d.kind } : {}),
    ...(d.operation ? { operation: d.operation } : {}),
    ...(d.code ? { code: d.code as FindingCode } : {}),
    ...(d.subject ? { subject: d.subject } : {}),
    expiresAt: new Date(now + days * 86_400_000).toISOString(),
    reason: d.reason.trim(),
  };
}

/** A rule's scope as a sentence fragment, e.g. `conflict on tickets/create`. */
export function ruleScope(r: FindingRuleEntry): string {
  const parts = [
    r.code ?? 'any code',
    r.operation ? `on ${r.operation}` : '',
    r.subject ? `for ${r.subject}` : '',
    r.kind ? `(${r.kind})` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

/**
 * What a failed call says. A 403 is the permission model answering — the person may read
 * the inbox and not act on it, or neither — and says so instead of the plane's wording.
 */
export function findingsError(e: unknown, doing: 'read' | 'change', target: 'finding' | 'rule' = 'finding'): string {
  if (e instanceof ApiError) {
    if (e.status === 403) {
      return doing === 'read'
        ? 'You do not have access to this team’s findings.'
        : 'You can read findings but not change them. Ask a team admin for access.';
    }
    if (e.status === 404) return `That ${target} no longer exists.`;
    return `${e.message || 'The request failed'} (${e.status})`;
  }
  return 'Findings could not be reached right now.';
}

/**
 * A hint, never the gate: whether to draw the actions, from the caller's team role. The
 * plane is what refuses (`dashboard:manage-findings`), and every action still handles that
 * refusal. Unknown (members not loaded) draws them, so a slow roster never hides a button.
 */
export function mayManageFromRole(role: string | undefined): boolean {
  return role !== 'viewer';
}

/** The caller's team role, from the loaded roster: `undefined` while they are not in it (yet). */
export function canManageFindings(members: readonly { principal: string | null; role_key: string }[], principal: string): boolean {
  return mayManageFromRole(members.find((m) => m.principal === principal)?.role_key);
}
