import { useState } from 'react';
import { listOAuthClients, setIssuerSettings, type IssuerSettings } from '../api';

/**
 * The issuer-wide ceiling on what a machine client (`client_credentials`) may be granted —
 * `MACHINE_SCOPES`, written through the settings PATCH to the same declared key the platform's
 * Env tab and a `wrangler` var set, so there is one answer whichever of them set it last.
 *
 * The issuer judges the list, not this form: a sign-in scope or a malformed token comes back
 * as the refusal's own reason and nothing is stored. Removing a scope a machine client holds
 * names those clients first, because the token endpoint stops minting it on the next request.
 */
export function MachineScopesEditor({
  settings, onChanged,
}: { settings: IssuerSettings; onChanged: (s: IssuerSettings) => void }) {
  const [scopes, setScopes] = useState(settings.machineScopes);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    const scope = draft.trim();
    if (scope && !scopes.includes(scope)) setScopes([...scopes, scope]);
    setDraft('');
  };
  // A refused value reads as `[]`, so an unchanged empty list still replaces it.
  const changed = scopes.join(' ') !== settings.machineScopes.join(' ') || Boolean(settings.machineScopesError);

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const removed = settings.machineScopes.filter((s) => !scopes.includes(s));
      if (removed.length) {
        const holders = (await listOAuthClients()).filter((c) =>
          c.client_credentials_scopes?.some((s) => removed.includes(s)),
        );
        if (
          holders.length &&
          !window.confirm(
            `${holders.map((c) => c.client_name ?? c.client_id).join(', ')} still ${holders.length === 1 ? 'holds' : 'hold'} ${removed.join(', ')}. ` +
              'The issuer stops granting it from the next token request; tokens already issued stay valid until they expire. Save?',
          )
        ) return;
      }
      const next = await setIssuerSettings({ machineScopes: scopes });
      setScopes(next.machineScopes);
      onChanged(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {settings.machineScopesError && <p className="error">{settings.machineScopesError} Save a new list to replace it.</p>}
      {err && <p className="error">{err}</p>}
      {scopes.length === 0 ? (
        <p className="muted small">No machine scopes yet: no machine application can be registered or get a token.</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {scopes.map((s) => (
            <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <code>{s}</code>
              <button type="button" className="btn tiny" aria-label={`Remove ${s}`} disabled={busy} onClick={() => setScopes(scopes.filter((x) => x !== s))}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={draft}
          placeholder="reports:read"
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn" style={{ width: 'auto' }} disabled={busy || !draft.trim()} onClick={add}>Add</button>
        <button type="button" className="btn primary" style={{ width: 'auto' }} disabled={busy || !changed} onClick={() => void save()}>
          Save
        </button>
      </div>
      <em className="hint">
        The sign-in scopes (<code>openid</code>, <code>profile</code>, <code>email</code>, <code>offline_access</code>) are
        refused: a machine token has no person behind it.
      </em>
    </div>
  );
}
