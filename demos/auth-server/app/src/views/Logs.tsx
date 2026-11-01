import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { PageHeader } from '@substrat-run/ui';
import { signInLog, type SignInAttempt, type SignInLogFilter, type SignInLogType } from '../api';
import { logEntryPath } from '../console/paths';
import { navigate } from '../console/router';

/**
 * WHAT HAPPENED when people tried to sign in — the screen an operator opens when someone says
 * "I cannot sign in with Microsoft" (spec/console-redesign.md §5).
 *
 * The shape to look for is not left to be inferred, because it is the one nobody guesses: a hop
 * OUT with no hop back. That means the person left and never returned, so the refusal happened on
 * the provider's own screen — and the authority they were sent to is then the only evidence
 * there is. For Microsoft that is usually the whole diagnosis: `common` against a single-tenant
 * app registration fails exactly this way, and so does an app registration that has not been
 * told this issuer's redirect URI. So the table marks those rows itself rather than asking a
 * reader to pair them up by eye — which is also the only way the mark is RIGHT when several
 * sign-ins are in flight at once (see `correlation` in `src/sign-in-log.ts`).
 */
export function LogsView() {
  const [retained, setRetained] = useState<number | null>(null);
  return (
    <>
      <PageHeader
        title="Logs"
        description={
          // The narrowness is a decision (`src/sign-in-log.ts`, "What is NOT here"), so the header
          // says it: an empty screen after a password sign-in must not read as a broken log.
          `Federated sign-ins only — each round trip to an upstream provider, as the hop out and the hop back. Password and BankID sign-ins are not recorded${
            retained ? `, and the issuer keeps the last ${retained} hops` : ''
          }.`
        }
      />
      <LogList filters onRetained={setRetained} />
    </>
  );
}

/**
 * The same table narrowed to one application or one account, with no page header — what the
 * Application and User detail screens' Logs tabs show. The server returns whole ATTEMPTS for
 * either filter (the hop that names the client or account, and the hop joined to it), so the
 * "no answer yet" mark reads the same here as on `/logs`.
 */
export function LogTable({ clientId, userId, limit }: { clientId?: string; userId?: string; limit?: number }) {
  return <LogList clientId={clientId} userId={userId} limit={limit} />;
}

/** Auth0's description of each code this log carries, and ours for the hop that has none. */
export function logTypeLabel(type: SignInLogType | null): string {
  if (type === 's') return 'Success Login';
  if (type === 'f') return 'Failed Login';
  return 'Sent to provider';
}

/** The code and its description, as one cell — `—` where Auth0 would have no row at all. */
export function LogType({ type }: { type: SignInLogType | null }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
      <code>{type ?? '—'}</code>
      <span className={type ? undefined : 'muted'}>{logTypeLabel(type)}</span>
    </span>
  );
}

/** The outcome in the words an operator reads, not the stored token. */
export function outcomeText(attempt: SignInAttempt): string {
  if (attempt.error === 'email_verification_required') return 'Email verification required';
  if (attempt.outcome === 'started') return 'Sent to the provider';
  if (attempt.outcome === 'succeeded') return 'Signed in';
  return attempt.phase === 'sign-in' ? 'Refused before leaving' : 'Refused on the way back';
}

/** A link that is a place: copyable and openable in a tab, with the plain click same-document. */
export function EntryLink({ id, children }: { id: number; children: ReactNode }) {
  const href = logEntryPath(id);
  return (
    <a
      href={href}
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

const OUTCOMES: { value: SignInLogFilter['outcome']; label: string }[] = [
  { value: undefined, label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'started', label: 'Sent to provider' },
];

function LogList({
  clientId,
  userId,
  limit = 50,
  filters = false,
  onRetained,
}: {
  clientId?: string;
  userId?: string;
  limit?: number;
  filters?: boolean;
  onRetained?: (retained: number) => void;
}) {
  const [attempts, setAttempts] = useState<SignInAttempt[] | null>(null);
  const [total, setTotal] = useState(0);
  const [retained, setRetained] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SignInLogFilter['outcome']>(undefined);
  const [method, setMethod] = useState<string | undefined>(undefined);
  /**
   * Every method a read has shown on this screen. The chips are drawn from what the LOG holds
   * rather than from the configured providers, because a row outlives its provider — the
   * connection somebody removed yesterday is exactly the one whose refusals are worth reading.
   * Accumulated rather than recomputed, so choosing one method does not make the others vanish.
   */
  const [methods, setMethods] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  /** False once a page comes back short — there is nothing older to ask for. */
  const [more, setMore] = useState(false);

  const filter = useCallback(
    (before?: number): SignInLogFilter => ({
      limit,
      ...(before !== undefined ? { before } : {}),
      ...(outcome ? { outcome } : {}),
      ...(method ? { method } : {}),
      ...(clientId ? { clientId } : {}),
      ...(userId ? { userId } : {}),
    }),
    [limit, outcome, method, clientId, userId],
  );

  const seen = (page: SignInAttempt[]) =>
    setMethods((known) => [...new Set([...known, ...page.map((a) => a.method)])].sort());

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const page = await signInLog(filter());
      setAttempts(page.attempts);
      setTotal(page.total);
      setRetained(page.retained);
      onRetained?.(page.retained);
      setMore(page.attempts.length === limit);
      seen(page.attempts);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [filter, limit, onRetained]);

  /**
   * The page before the oldest row on screen. Keyed on that row's `id` rather than on a count,
   * because the log is a ring pruned on write: rows leave from the old end while a reader is
   * looking, and an offset would step over whatever moved.
   */
  const loadOlder = useCallback(async () => {
    const oldest = attempts?.[attempts.length - 1];
    if (!oldest) return;
    setBusy(true);
    try {
      const page = await signInLog(filter(oldest.id));
      setAttempts((shown) => [...(shown ?? []), ...page.attempts]);
      setMore(page.attempts.length === limit);
      seen(page.attempts);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [attempts, filter, limit]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * The correlations that HAVE an answer among the rows on screen. A `started` row outside this
   * set is one nobody came back from — the shape the header names.
   *
   * Scoped to what is loaded, and that is honest rather than convenient: a callback is always
   * NEWER than the start it answers, and this list is newest-first, so a loaded start's answer is
   * loaded too — unless it arrived in the seconds since the read, which is why the mark says "no
   * answer yet" rather than "abandoned". An outcome filter hides callbacks by definition, so the
   * mark is suppressed there instead of being wrong about all of them.
   */
  const answered = new Set(
    (attempts ?? []).filter((a) => a.phase === 'callback' && a.correlation).map((a) => a.correlation),
  );
  const markUnanswered = !outcome;
  const narrowed = Boolean(outcome || method);

  return (
    <section className="panel">
      <div className="panel-head" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        {filters ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', flex: 1, minWidth: 0 }}>
            <Chips label="Outcome">
              {OUTCOMES.map((o) => (
                <Chip key={o.label} on={outcome === o.value} onClick={() => setOutcome(o.value)}>
                  {o.label}
                </Chip>
              ))}
            </Chips>
            {methods.length > 0 && (
              <Chips label="Method">
                <Chip on={method === undefined} onClick={() => setMethod(undefined)}>All</Chip>
                {methods.map((m) => (
                  <Chip key={m} on={method === m} onClick={() => setMethod(m)}>
                    <code>{m}</code>
                  </Chip>
                ))}
              </Chips>
            )}
          </div>
        ) : (
          <h2>Sign-ins</h2>
        )}
        <button className="btn" disabled={busy} onClick={() => void reload()}>Refresh</button>
      </div>
      {err && <p className="error">{err}</p>}
      {filters && (
        <p className="muted">
          A hop out marked <strong>no answer yet</strong> is the telling case: the person never came
          back, so the provider refused them on its own screen, and the authority beside it is what
          to check against the app registration there.
        </p>
      )}
      {!attempts ? (
        !err && <p className="muted">Loading…</p>
      ) : attempts.length === 0 ? (
        <p className="muted">
          {narrowed
            ? 'Nothing recorded matches these filters. Choose “All” to see every hop.'
            : clientId || userId
              ? 'No federated sign-ins recorded here yet.'
              : 'Nothing recorded yet. Press a provider button on the sign-in screen and this fills in.'}
        </p>
      ) : (
        <>
          <table className="grid">
            <thead>
              <tr><th>When</th><th>Type</th><th>Provider</th><th>What happened</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {attempts.map((attempt) => (
                <AttemptRow
                  key={attempt.id}
                  attempt={attempt}
                  unanswered={
                    markUnanswered &&
                    attempt.outcome === 'started' &&
                    (!attempt.correlation || !answered.has(attempt.correlation))
                  }
                />
              ))}
            </tbody>
          </table>
          {more && (
            <button className="btn" disabled={busy} onClick={() => void loadOlder()}>
              {busy ? 'Loading…' : 'Load older'}
            </button>
          )}
          <p className="muted small">
            Showing {attempts.length} of {total}. The log keeps the most recent {retained} hops and
            then rolls over — it is a debugging aid, not an audit trail.
          </p>
        </>
      )}
    </section>
  );
}

function Chips({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)', minWidth: 64 }}>{label}</span>
      {children}
    </div>
  );
}

/** A toggle, announced as one (`aria-pressed`), on the console's tokens so it reads in both themes. */
function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      style={{
        height: 26,
        padding: '0 10px',
        borderRadius: 999,
        fontSize: 12,
        cursor: 'pointer',
        border: `1px solid ${on ? 'var(--border-brand)' : 'var(--border-default)'}`,
        background: on ? 'var(--surface-brand-subtle)' : 'var(--surface-raised)',
        color: on ? 'var(--text-brand)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </button>
  );
}

function AttemptRow({ attempt, unanswered }: { attempt: SignInAttempt; unanswered: boolean }) {
  return (
    <tr>
      <td>
        <EntryLink id={attempt.id}>
          <time dateTime={new Date(attempt.at).toISOString()}>{new Date(attempt.at).toLocaleString()}</time>
        </EntryLink>
      </td>
      <td><LogType type={attempt.type} /></td>
      <td>
        <code>{attempt.method}</code>
        {attempt.clientId && <span className="tag">for {attempt.clientId}</span>}
      </td>
      <td>
        {outcomeText(attempt)}
        {attempt.outcome === 'failed' && attempt.error && <> — <code>{attempt.error}</code></>}
        {/* The mark that carries the diagnosis. `warn` rather than an error colour: nobody came
            back, which is usually a misconfiguration at the provider and occasionally a person
            who simply closed the tab. */}
        {unanswered && <span className="tag warn">no answer yet</span>}
      </td>
      <td>
        {/* The upstream's own sentence, when there is one. This is the field that usually IS
            the answer — an `AADSTS…` message names the exact misconfiguration — so it is shown
            in full rather than truncated to fit the column. */}
        {attempt.errorDescription && <div className="reason">{attempt.errorDescription}</div>}
        {attempt.authority && <code className="client-id">{attempt.authority}</code>}
        {attempt.userId && <span className="muted small">user {attempt.userId}</span>}
      </td>
    </tr>
  );
}
