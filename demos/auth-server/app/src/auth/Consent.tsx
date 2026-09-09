import { useEffect, useState } from 'react';
import {
  answerConsent,
  oauthClient,
  type ClientTheme,
  type ConsentRequest,
  type OAuthClient,
} from '../api';
import { Centered, Card } from '../primitives';

/**
 * What each requested scope means, in the words of the person being asked. An unknown scope
 * is shown verbatim rather than hidden: consenting to something unnamed is not consent.
 */
const SCOPE_TEXT: Record<string, string> = {
  openid: 'Confirm who you are',
  profile: 'Your name and profile details',
  email: 'Your email address',
  offline_access: 'Stay signed in while you are away',
};

/**
 * The consent screen — the answer to an authorize request the plugin parked at `/consent?…`.
 * The request itself is the signed query in that URL (there is no server-side consent code
 * any more), and it must be handed back with the answer. Approving mints the authorization
 * code and sends the browser to the relying party's own callback; denying sends it there too,
 * carrying `access_denied`. Either way the RP hears back, which is the whole point: before
 * this screen existed, both answers were "you are now looking at an admin dashboard" (#898).
 */
export function Consent({ request, theme }: { request: ConsentRequest; theme: ClientTheme }) {
  const [client, setClient] = useState<OAuthClient | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void oauthClient(request.clientId, request.oauthQuery)
      .then(setClient)
      .catch(() => setClient(null));
  }, [request.clientId, request.oauthQuery]);

  const answer = async (accept: boolean) => {
    setErr(null);
    setBusy(true);
    try {
      // A full navigation, not a fetch — this URL belongs to the relying party.
      window.location.href = await answerConsent({ accept, oauthQuery: request.oauthQuery });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // A dynamically registered client picks its own name, so it is a claim, not an identity.
  // The client id underneath is the part the issuer actually vouches for.
  const who = client?.name?.trim() || request.clientId;

  return (
    <Centered>
      <Card title="Authorize access" logo={theme.logoUrl}>
        <p className="muted">
          <strong>{who}</strong> wants to sign you in with your Substrat Auth account.
        </p>
        {request.scopes.length > 0 && (
          <ul className="scopes">
            {request.scopes.map((scope) => (
              <li key={scope}>{SCOPE_TEXT[scope] ?? scope}</li>
            ))}
          </ul>
        )}
        {err && <p className="error">{err}</p>}
        <div className="consent-actions">
          <button className="btn primary" disabled={busy} onClick={() => void answer(true)}>
            {busy ? 'Working…' : 'Allow'}
          </button>
          <button className="btn" disabled={busy} onClick={() => void answer(false)}>
            Deny
          </button>
        </div>
        <p className="muted small">
          Requested by client <code>{request.clientId}</code>. Only continue if you started this
          from an application you trust.
        </p>
      </Card>
    </Centered>
  );
}
