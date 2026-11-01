import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { DetailHeader, EmptyState } from '@substrat-run/ui';
import { signInLogEntry, type SignInAttempt } from '../api';
import { LOGS_PATH, applicationPath, userPath } from '../console/paths';
import { navigate } from '../console/router';
import { EntryLink, LogType, logTypeLabel, outcomeText } from './Logs';
import { RawJson } from './RawJson';

/**
 * `/logs/<id>` — one hop of a federated sign-in, with the other hops of the same attempt.
 *
 * The related hops are on the same screen because a single row is rarely the answer: a refusal
 * on the way back says what the upstream objected to, but WHICH authority this issuer sent the
 * person to is on the hop out, and a hop out alone is only a diagnosis once you can see that
 * nothing came back. The pair is what an operator pastes into a support thread, so it is one URL.
 *
 * A link to an entry outlives the entry: the log is a ring, and a row a colleague linked last
 * week may have rolled out since. That is an ordinary answer, so it gets an empty state with the
 * way back rather than an error.
 */
export function LogEntryView({ id }: { id: number }) {
  const [entry, setEntry] = useState<{ attempt: SignInAttempt; related: SignInAttempt[] } | null | 'missing'>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    signInLogEntry(id).then(
      (found) => live && setEntry(found ?? 'missing'),
      (e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [id]);

  if (entry === 'missing') {
    return (
      <EmptyState
        title="No such log entry"
        description={`The log holds no entry ${id}. It keeps only the most recent hops, so this one has probably rolled out since the link was made.`}
        action={
          <button className="btn primary" style={{ width: 'auto' }} onClick={() => navigate(LOGS_PATH)}>
            Back to Logs
          </button>
        }
      />
    );
  }

  return (
    <>
      {err && <p className="error">{err}</p>}
      {entry === null ? (
        !err && <p className="muted">Loading this entry…</p>
      ) : (
        <Entry attempt={entry.attempt} related={entry.related} />
      )}
    </>
  );
}

function Entry({ attempt, related }: { attempt: SignInAttempt; related: SignInAttempt[] }) {
  const when = new Date(attempt.at);
  const unanswered = attempt.outcome === 'started' && !related.some((r) => r.phase === 'callback');
  return (
    <>
      <DetailHeader
        title={
          <>
            <code>{attempt.type ?? '—'}</code> {logTypeLabel(attempt.type)}
          </>
        }
        meta={
          <>
            <code>{attempt.method}</code>
            <span aria-hidden>·</span>
            <time dateTime={when.toISOString()}>{when.toLocaleString()}</time>
            <span aria-hidden>·</span>
            <span>entry {attempt.id}</span>
          </>
        }
      />
      <section className="panel">
        <div className="panel-head"><h2>Details</h2></div>
        <dl className="kv">
          <Pair label="What happened">
            {outcomeText(attempt)}
            {unanswered && (
              <>
                {' '}
                <span className="tag warn">no answer yet</span>
                <p className="muted note">
                  No hop back is recorded for this attempt: the person never returned from the
                  provider, so it refused them on its own screen. The authority below is what to
                  check against the app registration there.
                </p>
              </>
            )}
          </Pair>
          <Pair label="Phase">{attempt.phase}</Pair>
          <Pair label="Method"><code>{attempt.method}</code></Pair>
          <Pair label="Application">
            {attempt.clientId ? <PlaceLink href={applicationPath(attempt.clientId)}><code>{attempt.clientId}</code></PlaceLink> : <None />}
          </Pair>
          <Pair label="User">
            {attempt.userId ? <PlaceLink href={userPath(attempt.userId)}><code>{attempt.userId}</code></PlaceLink> : <None />}
          </Pair>
          <Pair label="Authority">{attempt.authority ? <code>{attempt.authority}</code> : <None />}</Pair>
          <Pair label="Error">{attempt.error ? <code>{attempt.error}</code> : <None />}</Pair>
          {/* Verbatim and unclipped: the upstream's sentence (an `AADSTS…` message) is usually
              the whole diagnosis, and the part naming the misconfiguration is often at the end. */}
          <Pair label="Error description">
            {attempt.errorDescription ? <span style={{ whiteSpace: 'pre-wrap' }}>{attempt.errorDescription}</span> : <None />}
          </Pair>
          <Pair label="Attempt">{attempt.correlation ? <code>{attempt.correlation}</code> : <None />}</Pair>
        </dl>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>The rest of this attempt</h2></div>
        <p className="muted">
          A sign-in is two hops — out to the provider, and back — and the pair is the diagnosis: the
          hop out says where the person was sent, the hop back says what the provider answered.
        </p>
        {!attempt.correlation ? (
          <p className="muted">This hop carries no attempt id, so nothing can be joined to it.</p>
        ) : related.length === 0 ? (
          <p className="muted">
            {attempt.outcome === 'started'
              ? 'No other hop recorded — the person has not come back from the provider.'
              : 'No other hop recorded — the hop out has rolled out of the log, or was never served by this issuer.'}
          </p>
        ) : (
          <table className="grid">
            <thead>
              <tr><th>When</th><th>Type</th><th>Phase</th><th>What happened</th></tr>
            </thead>
            <tbody>
              {related.map((r) => (
                <tr key={r.id}>
                  <td>
                    <EntryLink id={r.id}>
                      <time dateTime={new Date(r.at).toISOString()}>{new Date(r.at).toLocaleString()}</time>
                    </EntryLink>
                  </td>
                  <td><LogType type={r.type} /></td>
                  <td>{r.phase}</td>
                  <td>
                    {outcomeText(r)}
                    {r.error && <> — <code>{r.error}</code></>}
                    {r.errorDescription && <div className="reason">{r.errorDescription}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <RawJson value={{ attempt, related }} />
    </>
  );
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function None() {
  return <span className="muted">—</span>;
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
