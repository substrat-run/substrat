import { useCallback, useEffect, useState } from 'react';
import { signInLog, type SignInAttempt } from '../api';

/**
 * WHAT HAPPENED when people tried to sign in — the screen an operator opens when someone says
 * "I cannot sign in with Microsoft".
 *
 * It sits beside the providers it explains, rather than under the issuer's settings, because it
 * is read in the same minute as the panel it sends you back to: the reason a federated sign-in
 * fails is almost always one field on the provider's own screen or one registration at the
 * upstream's console.
 *
 * The shape to look for is not left to be inferred, because it is the one nobody guesses: a hop
 * OUT with no hop back. That means the person left and never returned, so the refusal happened on
 * the provider's own screen — and the authority they were sent to is then the only evidence
 * there is. For Microsoft that is usually the whole diagnosis: `common` against a single-tenant
 * app registration fails exactly this way, and so does an app registration that has not been
 * told this issuer's redirect URI. So the screen marks those rows itself rather than asking a
 * reader to pair them up by eye — which is also the only way the mark is RIGHT when several
 * sign-ins are in flight at once (see `correlation` in `src/sign-in-log.ts`).
 */
export function SignInLogView() {
  const [attempts, setAttempts] = useState<SignInAttempt[] | null>(null);
  const [total, setTotal] = useState(0);
  const [retained, setRetained] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  /** False once a page comes back short — there is nothing older to ask for. */
  const [more, setMore] = useState(false);

  const PAGE = 50;

  const reload = useCallback(async () => {
    setBusy(true);
    try {
      const page = await signInLog({ limit: PAGE, ...(failedOnly ? { outcome: 'failed' as const } : {}) });
      setAttempts(page.attempts);
      setTotal(page.total);
      setRetained(page.retained);
      setMore(page.attempts.length === PAGE);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [failedOnly]);

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
      const page = await signInLog({
        limit: PAGE,
        before: oldest.id,
        ...(failedOnly ? { outcome: 'failed' as const } : {}),
      });
      setAttempts((shown) => [...(shown ?? []), ...page.attempts]);
      setMore(page.attempts.length === PAGE);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [attempts, failedOnly]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * The correlations that HAVE an answer among the rows on screen. A `started` row outside this
   * set is one nobody came back from — the shape the blurb above names.
   *
   * Scoped to what is loaded, and that is honest rather than convenient: a callback is always
   * NEWER than the start it answers, and this list is newest-first, so a loaded start's answer is
   * loaded too — unless it arrived in the seconds since the read, which is why the mark says "no
   * answer yet" rather than "abandoned". Filtering to refusals hides every callback by
   * definition, so the mark is suppressed there instead of being wrong about all of them.
   */
  const answered = new Set(
    (attempts ?? []).filter((a) => a.phase === 'callback' && a.correlation).map((a) => a.correlation),
  );
  const markUnanswered = !failedOnly;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Sign-in log</h2>
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <label className="toggle" style={{ margin: 0 }}>
            <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} />
            <span>Refusals only</span>
          </label>
          <button className="btn" disabled={busy} onClick={() => void reload()}>Refresh</button>
        </div>
      </div>
      {err && <p className="error">{err}</p>}
      <p className="muted">
        Every federated sign-in this issuer served, newest first — the hop out to the provider and
        the hop back, as two rows. A hop out marked <strong>no answer yet</strong> is the telling
        case: the person never came back, so the provider refused them on its own screen, and the
        authority below is what to check against the app registration there.
      </p>
      {!attempts ? (
        <p className="muted">Loading…</p>
      ) : attempts.length === 0 ? (
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

/** The outcome in the words an operator reads, not the stored token. */
function outcomeText(attempt: SignInAttempt): string {
  if (attempt.outcome === 'started') return 'Sent to the provider';
  if (attempt.outcome === 'succeeded') return 'Signed in';
  return attempt.phase === 'sign-in' ? 'Refused before leaving' : 'Refused on the way back';
}

function AttemptRow({ attempt, unanswered }: { attempt: SignInAttempt; unanswered: boolean }) {
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
