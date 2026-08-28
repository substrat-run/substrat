import { useCallback, useEffect, useState } from 'react';
import {
  api,
  ApiError,
  isNeedsSetup,
  type Balance,
  type Expense,
  type LeaveRequest,
  type LeaveType,
  type Me,
  type OnboardingSummary,
  type Project,
  type RosterMember,
  type Timesheet,
} from './api';

export interface Onboarding {
  instanceId: string;
  status: 'open' | 'signed' | 'voided';
  answered: number;
  total: number;
  items: { key: string; label: string; done: boolean }[];
}

export interface AppData {
  me: Me;
  leaveTypes: LeaveType[];
  balance: Balance | null;
  requests: LeaveRequest[];
  timesheet: Timesheet | null;
  expenses: Expense[];
  projects: Project[];
  onboarding: Onboarding | null;
}

export interface Loaded {
  data: AppData | null;
  loading: boolean;
  error: string | null;
  /** The caller has no session — show the sign-in screen rather than an error. */
  unauthorized: boolean;
  /** A freshly-provisioned instance with no admin yet — show first-run setup, not sign-in. */
  needsSetup: boolean;
  /** While `needsSetup`: whether signing in still claims the seat, or only a claim link does (#925). */
  firstSignInOpen: boolean;
  reload: () => void;
}

/** Load everything the employee app centres on, keyed to the current persona. */
export function useAppData(personaKey: string): Loaded {
  const [data, setData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [firstSignInOpen, setFirstSignInOpen] = useState(false);

  const reload = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setUnauthorized(false);
    setNeedsSetup(false);
    (async () => {
      try {
        const me = await api.me();
        // A brand-new instance with no admin yet → first-run setup, not the app.
        if (isNeedsSetup(me)) {
          if (!cancelled) {
            setNeedsSetup(true);
            setFirstSignInOpen(me.firstSignInOpen === true);
            setLoading(false);
          }
          return;
        }
        if (!me.employeeId) {
          if (!cancelled) {
            setData({ me, leaveTypes: [], balance: null, requests: [], timesheet: null, expenses: [], projects: [], onboarding: null });
            setLoading(false);
          }
          return;
        }
        const eid = me.employeeId;
        const [leaveTypes, balance, requests, timesheet, expenses, projects, onboardingList] =
          await Promise.all([
            api.leaveTypes(eid),
            api.balance(eid),
            api.myRequests(eid),
            api.timesheet(eid),
            api.myExpenses(eid),
            api.projects(eid),
            api.onboardingFor(eid),
          ]);

        let onboarding: Onboarding | null = null;
        const open = onboardingList.find((o) => o.instance.status !== 'voided');
        if (open) {
          const detail = await api.onboardingDetail(open.instance.id);
          const items = detail.template.content.sections
            .flatMap((s) => s.items)
            .map((i) => ({ key: i.key, label: i.label, done: detail.latest[i.key] === true }));
          onboarding = {
            instanceId: open.instance.id,
            status: open.instance.status as Onboarding['status'],
            answered: items.filter((i) => i.done).length,
            total: items.length,
            items,
          };
        }
        if (!cancelled) {
          setData({ me, leaveTypes, balance, requests, timesheet, expenses, projects, onboarding });
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          if (e instanceof ApiError && e.status === 401) setUnauthorized(true);
          else setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [personaKey]);

  useEffect(() => reload(), [reload]);

  return { data, loading, error, unauthorized, needsSetup, firstSignInOpen, reload };
}

export interface ManagerData {
  roster: RosterMember[];
  leaveTypes: LeaveType[];
  requests: LeaveRequest[];
  expenses: Expense[];
  timesheets: Record<string, Timesheet>;
  onboarding: Record<string, OnboardingSummary | null>;
  dept: string;
}

/** The Manage-section data — loaded only when the caller holds manager/HR perms. */
export function useManagerData(personaKey: string, enabled: boolean): { data: ManagerData | null; reload: () => void } {
  const [data, setData] = useState<ManagerData | null>(null);

  const reload = useCallback(() => {
    if (!enabled) {
      setData(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [me, roster, leaveTypes, requests, expenses] = await Promise.all([
          api.me(),
          api.roster(),
          api.leaveTypes(),
          api.requests(),
          api.allExpenses(),
        ]);
        // These hooks run only for a resolved manager/admin, so setup is never in flight —
        // the guard is here to keep the union total, not because it's reachable.
        if (isNeedsSetup(me)) { if (!cancelled) setData(null); return; }
        const timesheets: Record<string, Timesheet> = {};
        const onboarding: Record<string, OnboardingSummary | null> = {};
        await Promise.all(
          roster.map(async (m) => {
            timesheets[m.id] = await api.timesheet(m.id);
            const ob = await api.onboardingSummaryFor(m.id);
            // A new hire can carry both an onboarding checklist and an
            // anställningsavtal. The contract is the one that gates their start
            // date, so it wins the card when both are live.
            const live = ob.filter((o) => o.instance.status !== 'voided');
            onboarding[m.id] = live.find((o) => o.contentKind === 'document') ?? live[0] ?? null;
          }),
        );
        if (!cancelled) {
          setData({ roster, leaveTypes, requests, expenses, timesheets, onboarding, dept: me.country === 'ES' ? 'Spain' : 'Sweden' });
        }
      } catch {
        if (!cancelled) setData(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [personaKey, enabled]);

  useEffect(() => reload(), [reload]);
  return { data, reload };
}

export interface AdminData {
  me: Me;
  leaveTypes: LeaveType[];
  roster: RosterMember[];
  projects: Project[];
  country: 'SE' | 'ES';
}

/**
 * The Admin (HR-setup) data — the vocabulary + people + projects an HR admin owns.
 * Loaded only for the hr-admin role. On a freshly-installed instance every list is
 * empty, which is exactly what the first-run setup checklist reads to guide the owner.
 */
export function useAdminData(personaKey: string, enabled: boolean): { data: AdminData | null; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!enabled) {
      setData(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [me, leaveTypes, roster, projects] = await Promise.all([
          api.me(),
          api.leaveTypes(),
          api.roster(),
          api.adminProjects(),
        ]);
        if (isNeedsSetup(me)) { if (!cancelled) { setData(null); setLoading(false); } return; }
        if (!cancelled) {
          setData({ me, leaveTypes, roster, projects, country: me.country });
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [personaKey, enabled]);

  useEffect(() => reload(), [reload]);
  return { data, loading, error, reload };
}

/** Working-days between two ISO dates, inclusive (Mon–Fri). */
export function workingDays(startISO: string, endISO: string): number {
  const start = new Date(startISO + 'T00:00:00');
  const end = new Date(endISO + 'T00:00:00');
  if (end < start) return 0;
  let n = 0;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) n += 1;
  }
  return n;
}

export const todayISO = (): string => new Date().toISOString().slice(0, 10);

export function fmtDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', day: 'numeric', month: 'short' });
}
