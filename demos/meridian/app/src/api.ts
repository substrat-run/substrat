// Typed client over the Meridian dev server. The dev persona is carried in the
// `x-principal` header (localStorage-backed); in production this becomes a real
// session. Every call goes through /api/invoke — the kernel checks permissions
// inside each operation, so the generic transport is exactly as safe.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const PRINCIPAL_KEY = 'meridian.principal';
export const getPrincipal = (): string => localStorage.getItem(PRINCIPAL_KEY) ?? 'elin';
export const setPrincipal = (key: string): void => localStorage.setItem(PRINCIPAL_KEY, key);

function headers(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-principal': getPrincipal() };
}

async function invoke<T>(op: string, input?: unknown): Promise<T> {
  const res = await fetch('/api/invoke', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ op, input }),
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `${res.status}`, res.status);
  return body;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers() });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `${res.status}`, res.status);
  return body;
}

/**
 * Better Auth (via the worker → the tenant's IdentityDO). A successful call sets the
 * same-origin session cookie, so the app just reloads afterward and `/api/me` resolves.
 * On a fresh instance the first sign-in CLAIMS the owner seat (→ hr-admin).
 */
async function authPost(path: string, body: unknown): Promise<void> {
  const res = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new ApiError(b.message ?? b.error ?? `Sign-in failed (${res.status})`, res.status);
  }
}

export const auth = {
  signUp: (email: string, password: string, name: string) => authPost('sign-up/email', { email, password, name }),
  /** Sign up WITH an invite token — allowed even after the workspace is closed to open sign-up. */
  signUpWithInvite: (email: string, password: string, name: string, token: string) =>
    authPost(`sign-up/email?invite=${encodeURIComponent(token)}`, { email, password, name }),
  signIn: (email: string, password: string) => authPost('sign-in/email', { email, password }),
  signOut: () => authPost('sign-out', {}),
};

/** A POST to one of the worker's own JSON routes (not the /api/invoke op transport). */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const text = await res.text();
  const parsed = (text ? JSON.parse(text) : undefined) as (T & { error?: string }) | undefined;
  if (!res.ok) throw new ApiError(parsed?.error ?? `${res.status}`, res.status);
  return parsed as T;
}

/** One outstanding member invite (the admin's pending list). No token — that lives in the link. */
export interface Invite {
  principal: string;
  roleKey: string;
  email: string | null;
  createdAt: number;
}
export interface InvitesResult {
  /** The roles a teammate can be invited at (this vertical's ROLES). */
  roles: string[];
  invites: Invite[];
}

// -- shapes (subset the app renders) ----------------------------------------

export interface Me {
  key: string;
  display: string;
  role: string;
  country: 'SE' | 'ES';
  employeeId: string | null;
}
export interface CastMember {
  key: string;
  display: string;
  role: string;
  country: 'SE' | 'ES';
  employeeId: string | null;
}
export interface LeaveType {
  key: string;
  label: string;
  kind: string;
  annual_days: string | null;
}
export interface Balance {
  employeeId: string;
  balances: { leaveTypeKey: string; balance: string }[];
}
export interface LeaveRequest {
  id: string;
  employee_id: string;
  leave_type_key: string;
  start_date: string;
  end_date: string;
  days: string;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled';
  created_at: string;
}
export interface TimeEntry {
  id: string;
  project_id: string | null;
  work_date: string;
  hours: string;
  note: string | null;
}
export interface Timesheet {
  employeeId: string;
  entries: TimeEntry[];
  totalHours: string;
}
export interface Expense {
  id: string;
  employee_id: string;
  description: string;
  amount: string;
  currency: string;
  category: string;
  status: 'submitted' | 'approved' | 'rejected' | 'exported';
  created_at: string;
}
export interface Project {
  id: string;
  code: string;
  name: string;
}
export interface OnboardingItem {
  key: string;
  label: string;
  type: string;
}
export interface OnboardingInstance {
  id: string;
  status: 'open' | 'signed' | 'voided';
  answered: number;
  total: number;
  items: { key: string; label: string; done: boolean }[];
}
export interface RosterMember {
  id: string;
  number: string;
  name: string;
  email: string | null;
  started_at: string | null;
}
export interface PayrollExport {
  fromDate: string;
  toDate: string;
  expenses: { employeeId: string; amount: string; currency: string; category: string }[];
  absence: { employeeId: string; leaveTypeKey: string; days: string }[];
}
export interface OnboardingSummary {
  instance: {
    id: string;
    // `pending_signature` is the state a DOCUMENT sits in while it is out at a
    // signing provider: frozen, unwritable, waiting on people who may not have
    // accounts here at all.
    status: 'open' | 'pending_signature' | 'signed' | 'voided';
  };
  title: string;
  /** 'checklist' (items to tick) or 'document' (an avtal, bound by hash). */
  contentKind: 'checklist' | 'document';
  answered: number;
  total: number;
  /** How many requested signatures are still outstanding. */
  pendingSignatures: number;
}

/** A freshly-provisioned instance with no admin yet — the SPA shows first-run setup. */
export interface NeedsSetup {
  status: 'needs-setup';
}
/** Narrow `/api/me` to the first-run setup state (no admin has claimed the workspace yet). */
export function isNeedsSetup(m: Me | NeedsSetup): m is NeedsSetup {
  return (m as NeedsSetup).status === 'needs-setup';
}

export const api = {
  me: () => get<Me | NeedsSetup>('/api/me'),
  /** Which auth this instance runs — the sign-in screen branches on it. */
  authMode: () => get<{ mode: 'builtin' | 'oidc' }>('/api/auth-mode'),
  cast: () => get<CastMember[]>('/api/cast'),

  // Invites (admin-only server-side): the post-setup join path.
  invites: () => get<InvitesResult>('/api/invites'),
  createInvite: (roleKey: string, email?: string) =>
    postJson<{ principal: string; roleKey: string; email: string | null; acceptUrl: string }>('/api/invites', email ? { roleKey, email } : { roleKey }),
  revokeInvite: (principal: string) => postJson<void>(`/api/invites/${encodeURIComponent(principal)}/revoke`, {}),
  /** Claim an invite while signed in — binds this login to the invited member principal. */
  acceptInvite: (token: string) => postJson<{ ok: true }>('/api/accept-invite', { token }),

  leaveTypes: (employeeId?: string) => invoke<LeaveType[]>('hr/list-leave-types', employeeId ? { employeeId } : undefined),
  balance: (employeeId: string) => invoke<Balance>('hr/balance', { employeeId }),
  myRequests: (employeeId: string) => invoke<LeaveRequest[]>('hr/my-requests', { employeeId }),
  requestLeave: (input: {
    employeeId: string;
    leaveTypeKey: string;
    startDate: string;
    endDate: string;
    days: string;
    note?: string;
  }) => invoke<LeaveRequest>('hr/request-leave', input),

  projects: (employeeId: string) => invoke<Project[]>('hr/list-projects', { employeeId }),
  timesheet: (employeeId: string) => invoke<Timesheet>('hr/timesheet', { employeeId }),
  logTime: (input: { employeeId: string; projectId?: string; workDate: string; hours: string; note?: string }) =>
    invoke<TimeEntry>('hr/log-time', input),

  myExpenses: (employeeId: string) => invoke<Expense[]>('hr/my-expenses', { employeeId }),
  submitExpense: (input: {
    employeeId: string;
    description: string;
    amount: string;
    currency: string;
    category: string;
    projectId?: string;
  }) => invoke<Expense>('hr/submit-expense', input),

  // Onboarding is the protocol engine, reached through the employee's own-record
  // grant. The employee fills and e-signs their own.
  onboardingFor: (employeeId: string) =>
    invoke<OnboardingSummary[]>('protocol/list-for-entity', {
      entityType: 'employee',
      entityId: employeeId,
    }),
  onboardingDetail: (instanceId: string) =>
    invoke<{
      instance: { id: string; status: string };
      template: { title: string; content: { sections: { title: string; items: OnboardingItem[] }[] } };
      latest: Record<string, unknown>;
    }>('protocol/get', { instanceId }),
  fillOnboarding: (instanceId: string, itemKey: string, value: boolean) =>
    invoke<unknown>('protocol/fill', { instanceId, itemKey, value }),
  signOnboarding: (instanceId: string) => invoke<unknown>('protocol/sign', { instanceId }),

  // -- manager / HR (the Manage section) --
  roster: () => invoke<RosterMember[]>('hr/roster'),
  requests: (status?: string) => invoke<LeaveRequest[]>('hr/list-requests', status ? { status } : undefined),
  allExpenses: (status?: string) => invoke<Expense[]>('hr/list-expenses', status ? { status } : undefined),
  onboardingSummaryFor: (employeeId: string) =>
    invoke<OnboardingSummary[]>('protocol/list-for-entity', { entityType: 'employee', entityId: employeeId }),
  decideLeave: (requestId: string, decision: 'approve' | 'reject', note?: string) =>
    invoke<unknown>('hr/decide-leave', { requestId, decision, ...(note ? { note } : {}) }),
  decideExpense: (expenseId: string, decision: 'approve' | 'reject') =>
    invoke<unknown>('hr/decide-expense', { expenseId, decision }),

  // -- HR-admin setup (the Admin section) --
  // The first-run surface: an installed instance is empty, so the owner defines the
  // vocabulary (leave types), adds people, and sets up projects before anyone uses it.
  defineLeaveType: (input: { key: string; label: string; kind: string; annualDays?: string }) =>
    invoke<LeaveType>('hr/define-leave-type', input),
  createEmployee: (input: { number: string; name: string; email?: string; nationalId?: string; startedAt?: string }) =>
    invoke<RosterMember>('hr/create-employee', input),
  createProject: (input: { code: string; name: string }) => invoke<Project>('hr/create-project', input),
  // Node-level project list (HR admin holds time:read at the node, so no employee ref).
  adminProjects: () => invoke<Project[]>('hr/list-projects'),
  accrue: (input: { employeeId: string; leaveTypeKey: string; days: string; note?: string }) =>
    invoke<unknown>('hr/accrue', input),
  // Generate the variable-pay export for a period (the payroll boundary — §7). This
  // MUTATES: approved expenses in range are marked exported so a re-run never double-pays.
  payrollExport: (fromDate: string, toDate: string) =>
    invoke<PayrollExport>('hr/payroll-export', { fromDate, toDate }),
};

/** Money/decimal formatting per country. */
export const fmtDays = (d: string): string =>
  Number(d).toLocaleString('en', { maximumFractionDigits: 2 });
export const fmtMoney = (amount: string, currency: string): string =>
  `${Number(amount).toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency}`;
