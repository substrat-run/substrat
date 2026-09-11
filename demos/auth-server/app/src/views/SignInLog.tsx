import { useCallback, useEffect, useState } from 'react';
import { signInLog, type SignInAttempt, type SignInLogPage } from '../api';

/**
 * WHAT HAPPENED when people tried to sign in — the screen an operator opens when someone says
 * "I cannot sign in with Microsoft".
 *
 * It sits beside the providers it explains, rather than under the issuer's settings, because it
 * is read in the same minute as the panel it sends you back to: the reason a federated sign-in
 * fails is almost always one field on the provider's own screen or one registration at the
 * upstream's console.
 *
 * The shape to look for is stated on the page rather than left to be inferred, because it is
 * the one nobody guesses: **a "Sent to the provider" row with nothing after it**. That means
 * the person left and never came back, so the refusal happened on the provider's own screen —
 * and the authority they were sent to is then the only evidence there is. For Microsoft that
 * is the whole diagnosis: `common` against a single-tenant app registration fails exactly
 * this way, and so does an app registration that has not been told this issuer's redirect URI.
 */
export function SignInLogView() {
  const [page, setPage] = useState<SignInLogPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);

  const reload = useCallback(async () => {
    try {
      setPage(await signInLog(failedOnly ? { outcome: 'failed' } : {}));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [failedOnly]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Sign-in log</h2>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <label className="toggle" style={{ margin: 0 }}>
            <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />
            <span>Refusals only</span>
          </label>
          <button className="btn" onClick={() => void reload()}>Refresh</button>
        </div>
      </div>
      {err && <p className="error">{err}</p>}
      <p className="muted">
        Every federated sign-in this issuer served, newest first — the hop out to the provider
        and the hop back, as two rows. A “Sent to the provider” row with nothing after it is the
        telling case: the person never came back, so the provider refused them on its own screen,
        and the authority below is what to check against the app registration there.
      </p>
      {!page ? (
        <p className="muted">Loading…</p>
      ) : page.attempts.length === 0 ? (
        <p className="muted">
          {failedOnly
            ? 'No refusals recorded. Untick “Refusals only” to see the attempts that worked.'
            : 'Nothing recorded yet. Press a provider button on the sign-in screen and this fills in.'}
        </p>
      ) : (
        <>
          <table className="grid">
            <thead>
              <tr><th>When</th><th>Provider</th><th>What happened</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {page.attempts.map((attempt) => (
                <AttemptRow key={attempt.id} attempt={attempt} />
              ))}
            </tbody>
          </table>
          <p className="muted small">
            The log keeps the most recent {page.retained} hops and then rolls over — it is a
            debugging aid, not an audit trail. {page.total} stored right now.
          </p>
        </>
      )}
    </section>
  );
}

/** The outcome in the words an operator reads, not the stored token. */
function outcomeText(attempt: SignInAttempt): string {
  if (attempt.outcome === 'started') return 'Sent to the provider';
  if (attempt.outcome === 'succeeded') return 'Signed in';
  return attempt.phase === 'sign-in' ? 'Refused before leaving' : 'Refused on the way back';
}

function AttemptRow({ attempt }: { attempt: SignInAttempt }) {
  return (
    <tr>
      <td><time dateTime={new Date(attempt.at).toISOString()}>{new Date(attempt.at).toLocaleString()}</time></td>
      <td>
        <code>{attempt.method}</code>
        {attempt.clientId && <span className="tag">for {attempt.clientId}</span>}
      </td>
      <td>
        {outcomeText(attempt)}
        {attempt.outcome === 'failed' && attempt.error && <> — <code>{attempt.error}</code></>}
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
