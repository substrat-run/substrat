import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { PageHeader } from '@substrat-run/ui';
import {
  bankidSettings,
  identityProviders,
  listOAuthClients,
  listUsers,
  signInLog,
  type RegisteredClient,
  type SignInAttempt,
} from '../api';
import { APPLICATIONS_PATH, CONNECTIONS_PATH, LOGS_PATH, USERS_PATH } from '../console/paths';
import { navigate } from '../console/router';
import { EntryLink, outcomeText } from './Logs';

/**
 * `/` — the console's landing page, Auth0's Overview (spec/console-redesign.md §3).
 *
 * Every block owns its read and its failure. An Overview is a summary of several stores, and
 * the one thing it must not do is let a single failed read (BankID's settings, say) blank the
 * counts that did come back — so there is no page-level loading state at all.
 */
export function OverviewView() {
  const clients = useRead(listOAuthClients);
  return (
    <>
      <PageHeader title="Overview" description="What this issuer holds, and how federated sign-ins have gone this week." />
      <GetStarted clients={clients} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
        <UsersTile />
        <ApplicationsTile clients={clients} />
        <ConnectionsTile />
      </div>
      <SignInsChart />
      <RecentFailures />
    </>
  );
}

/* ---- reads ---- */

type Read<T> = { data: T; err: null } | { data: null; err: string } | { data: null; err: null };

/** One read, run once on mount. `{null, null}` is "not answered yet", never "empty". */
function useRead<T>(fn: () => Promise<T>): Read<T> {
  const [state, setState] = useState<Read<T>>({ data: null, err: null });
  useEffect(() => {
    let live = true;
    fn().then(
      (data) => live && setState({ data, err: null }),
      (e: unknown) => live && setState({ data: null, err: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
    // Mount-time on purpose: callers pass a closure, and re-running on its identity would
    // re-read every render.
  }, []);
  return state;
}

/**
 * The seeded applications, which do not count as "set up": the console row (`builtin`, this
 * issuer's own screen) and the dev server's demo relying party. The demo's name is restated
 * from `DEMO_CLIENT` in `src/auth.ts` rather than imported — that module is the issuer's
 * server half and would pull Better Auth into the bundle. A rename there only makes this card
 * disappear early, never show for a real application.
 */
const DEMO_CLIENT_NAME = 'Substrat Demo RP';
const isSeeded = (c: RegisteredClient) => Boolean(c.builtin) || c.client_name === DEMO_CLIENT_NAME;

/* ---- get started ---- */

function GetStarted({ clients }: { clients: Read<RegisteredClient[]> }) {
  // Only on an answer: an unread or failed list says nothing about whether the issuer is new.
  if (!clients.data || clients.data.some((c) => !isSeeded(c))) return null;
  return (
    <section className="panel">
      <div className="panel-head"><h2>Get started</h2></div>
      <p className="muted" style={{ marginTop: 0 }}>
        Nothing is registered here yet beyond what the issuer seeds itself. Two steps make it useful:
      </p>
      <ol style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 8, color: 'var(--text-primary)' }}>
        <li>
          <PlaceLink href={APPLICATIONS_PATH}>Register an application</PlaceLink> — the relying party
          your users sign into. It gets a client id and, for a web app, a secret shown once.
        </li>
        <li>
          <PlaceLink href={CONNECTIONS_PATH}>Add a connection</PlaceLink> — Google, Microsoft, any
          OIDC provider or BankID beside the email-and-password database every issuer has.
        </li>
      </ol>
    </section>
  );
}

/* ---- stat tiles ---- */

function Tile({ label, href, read, children }: { label: string; href: string; read: { err: string | null; ready: boolean }; children?: ReactNode }) {
  return (
    <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <PlaceLink href={href}>
        <span style={{ fontSize: 12, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
      </PlaceLink>
      {read.err ? (
        <p className="error" style={{ margin: 0 }}>{read.err}</p>
      ) : !read.ready ? (
        <p className="muted" style={{ margin: 0 }}>Loading…</p>
      ) : (
        children
      )}
    </section>
  );
}

function Stat({ value, note }: { value: number; note?: ReactNode }) {
  return (
    <>
      <span style={{ fontSize: 28, lineHeight: '34px', fontWeight: 600, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      {note && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{note}</span>}
    </>
  );
}

function UsersTile() {
  const users = useRead(listUsers);
  const banned = users.data?.filter((u) => u.banned).length ?? 0;
  return (
    <Tile label="Users" href={USERS_PATH} read={{ err: users.err, ready: users.data !== null }}>
      {users.data && <Stat value={users.data.length} note={banned ? `${banned} banned` : 'none banned'} />}
    </Tile>
  );
}

function ApplicationsTile({ clients }: { clients: Read<RegisteredClient[]> }) {
  // The console row is this issuer's own screen, not an application anyone registered, so it is
  // left out of the count the operator reads as "how many relying parties do I have".
  const registered = clients.data?.filter((c) => !c.builtin) ?? [];
  const machine = registered.filter((c) => c.application_type === 'machine').length;
  return (
    <Tile label="Applications" href={APPLICATIONS_PATH} read={{ err: clients.err, ready: clients.data !== null }}>
      {clients.data && (
        <Stat value={registered.length} note={machine === 1 ? '1 machine client' : `${machine} machine clients`} />
      )}
    </Tile>
  );
}

function ConnectionsTile() {
  /**
   * Three stores, one count: the upstream providers, BankID when it is configured, and the
   * email-and-password database every issuer has (hence the `+ 1`). One read, so the tile shows
   * either a number it can stand behind or the reason it has none — never a count that silently
   * left BankID out because its read failed.
   */
  const counts = useRead(async () => {
    const [{ providers }, bankid] = await Promise.all([identityProviders(), bankidSettings()]);
    return { upstream: providers.length, disabled: providers.filter((p) => p.disabled).length, bankid: bankid !== null };
  });
  const c = counts.data;
  return (
    <Tile label="Connections" href={CONNECTIONS_PATH} read={{ err: counts.err, ready: c !== null }}>
      {c && (
        <Stat
          value={c.upstream + (c.bankid ? 1 : 0) + 1}
          note={[
            'password',
            c.upstream ? `${c.upstream} upstream` : null,
            c.bankid ? 'BankID' : null,
            c.disabled ? `${c.disabled} disabled` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      )}
    </Tile>
  );
}

/* ---- federated sign-ins, last 7 days ---- */

const DAYS = 7;
const PAGE = 100;
const MAX_PAGES = 5;

interface Day {
  start: number;
  label: string;
  succeeded: number;
  failed: number;
}

interface Week {
  days: Day[];
  /** The oldest row the walk reached, when the log stops before the window does. */
  reachesBackTo: number | null;
  retained: number;
}

/**
 * The window, walked newest-first with keyset paging until it passes the window's start, the log
 * runs out, or 5 × 100 rows — the ring's own size, so a walk that stops on the page cap has read
 * everything the log holds. Only `s` and `f` hops count: a hop out is half an attempt, and
 * counting it would make every sign-in look like two.
 */
async function readWeek(): Promise<Week> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days: Day[] = Array.from({ length: DAYS }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (DAYS - 1 - i));
    return { start: d.getTime(), label: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }), succeeded: 0, failed: 0 };
  });
  const windowStart = days[0]!.start;
  let before: number | undefined;
  let oldest: SignInAttempt | undefined;
  let reachedStart = false;
  let retained = 0;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = await signInLog({ limit: PAGE, ...(before !== undefined ? { before } : {}) });
    retained = page.retained;
    for (const a of page.attempts) {
      if (a.at < windowStart) {
        reachedStart = true;
        break;
      }
      const day = [...days].reverse().find((d) => a.at >= d.start);
      if (day && a.type === 's') day.succeeded += 1;
      if (day && a.type === 'f') day.failed += 1;
    }
    oldest = page.attempts[page.attempts.length - 1] ?? oldest;
    if (reachedStart) break;
    // A short page is the end of the log. The window is then cut short only if the ring is full —
    // an issuer with three sign-ins all week has simply had three.
    if (page.attempts.length < PAGE) {
      return { days, reachesBackTo: page.total >= page.retained && oldest ? oldest.at : null, retained };
    }
    before = oldest?.id;
  }
  return { days, reachesBackTo: !reachedStart && oldest ? oldest.at : null, retained };
}

function SignInsChart() {
  const week = useRead(readWeek);
  const w = week.data;
  const succeeded = w?.days.reduce((n, d) => n + d.succeeded, 0) ?? 0;
  const failed = w?.days.reduce((n, d) => n + d.failed, 0) ?? 0;
  const peak = Math.max(1, ...(w?.days.map((d) => Math.max(d.succeeded, d.failed)) ?? [1]));
  const summary = `Federated sign-ins in the last ${DAYS} days: ${succeeded} succeeded, ${failed} failed.`;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Federated sign-ins, last {DAYS} days</h2>
        <PlaceLink href={LOGS_PATH}>Logs</PlaceLink>
      </div>
      {week.err ? (
        <p className="error">{week.err}</p>
      ) : !w ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p style={{ margin: '0 0 12px', color: 'var(--text-primary)' }}>{summary}</p>
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }} aria-hidden>
            <Key color="var(--status-success-dot)">Succeeded</Key>
            <Key color="var(--status-danger-dot)">Failed</Key>
          </div>
          {/* The bars are a picture of the sentence above, so assistive technology reads the
              per-day numbers from the label rather than walking 14 unlabelled boxes. */}
          <div
            role="img"
            aria-label={`${summary} Per day: ${w.days.map((d) => `${d.label} ${d.succeeded} succeeded, ${d.failed} failed`).join('; ')}.`}
            style={{ display: 'grid', gridTemplateColumns: `repeat(${DAYS}, minmax(0, 1fr))`, gap: 8, alignItems: 'end' }}
          >
            {w.days.map((d) => {
              const uncovered = w.reachesBackTo !== null && d.start + 86_400_000 <= w.reachesBackTo;
              return (
                <div key={d.start} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 120, width: '100%', justifyContent: 'center', borderBottom: '1px solid var(--border-default)' }}>
                    <Bar value={d.succeeded} peak={peak} color="var(--status-success-dot)" />
                    <Bar value={d.failed} peak={peak} color="var(--status-danger-dot)" />
                  </div>
                  <span style={{ fontSize: 11, color: uncovered ? 'var(--text-tertiary)' : 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    {d.label}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                    {uncovered ? 'not kept' : `${d.succeeded} / ${d.failed}`}
                  </span>
                </div>
              );
            })}
          </div>
          {w.reachesBackTo !== null && (
            <p className="muted small" style={{ marginBottom: 0 }}>
              The log only reaches back to {new Date(w.reachesBackTo).toLocaleString()} — it keeps the
              last {w.retained} hops — so the days before that are not counted here.
            </p>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>
            Password and BankID sign-ins are not logged, so they are not counted.
          </p>
        </>
      )}
    </section>
  );
}

function Bar({ value, peak, color }: { value: number; peak: number; color: string }) {
  return (
    <div
      style={{
        width: '38%',
        maxWidth: 18,
        // A zero is drawn as a hairline rather than nothing, so an empty day reads as a measured
        // zero and not as a missing bar.
        height: value ? `${Math.max(4, (value / peak) * 100)}%` : 1,
        background: value ? color : 'var(--border-default)',
        borderRadius: '3px 3px 0 0',
      }}
    />
  );
}

function Key({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color }} />
      {children}
    </span>
  );
}

/* ---- recent failures ---- */

function RecentFailures() {
  const failures = useRead(() => signInLog({ outcome: 'failed', limit: 3 }));
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Recent failures</h2>
        <PlaceLink href={LOGS_PATH}>All logs</PlaceLink>
      </div>
      {failures.err ? (
        <p className="error">{failures.err}</p>
      ) : !failures.data ? (
        <p className="muted">Loading…</p>
      ) : failures.data.attempts.length === 0 ? (
        <p className="muted">No failed federated sign-ins are in the log.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
          {failures.data.attempts.map((a) => (
            <li key={a.id} style={{ display: 'grid', gap: 2 }}>
              <span>
                <EntryLink id={a.id}>
                  <time dateTime={new Date(a.at).toISOString()}>{new Date(a.at).toLocaleString()}</time>
                </EntryLink>{' '}
                <code>{a.method}</code> — {outcomeText(a)}
                {a.error && <> — <code>{a.error}</code></>}
              </span>
              {a.errorDescription && (
                <span style={{ fontSize: 13, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{a.errorDescription}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PlaceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      style={{ color: 'var(--text-link)' }}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
