import { useCallback, useEffect, useState } from 'react';
import {
  APPLICATION_TYPES,
  createOAuthClient,
  deleteOAuthClient,
  listOAuthClients,
  rotateOAuthClientSecret,
  updateOAuthClient,
  type ApplicationType,
  type ClientDraft,
  type RegisteredClient,
} from '../api';
import { Field } from '../primitives';

/* ---- the relying-party registry ---- */

const EMPTY_DRAFT: ClientDraft = {
  client_name: '',
  application_type: 'web',
  redirect_uris: [],
  logo_uri: '',
  metadata: {},
  skip_consent: false,
  enable_end_session: false,
  post_logout_redirect_uris: [],
  disabled: false,
};

/**
 * The applications this issuer will answer for. Better Auth registers clients (dynamically,
 * or from `trustedClients` in code) but offers no way to see or change them afterwards — so
 * before this panel, the only record of a registered app was a row in the platform's
 * read-only Data tab.
 */
export function ClientsPanel() {
  const [clients, setClients] = useState<RegisteredClient[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<RegisteredClient | 'new' | null>(null);
  /** A freshly minted secret, held until dismissed — the only moment it is knowable. */
  const [secret, setSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      setClients(await listOAuthClients());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Applications</h2>
        {!editing && <button className="btn" onClick={() => setEditing('new')}>+ New client</button>}
      </div>
      {err && <p className="error">{err}</p>}
      {secret && <SecretOnce {...secret} onDismiss={() => setSecret(null)} />}
      {editing && (
        <ClientEditor
          // Same reason as the providers panel above: Edit on a second client while this is
          // open would otherwise keep the first one's form state and save it onto the second.
          key={editing === 'new' ? 'new' : editing.client_id}
          client={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={async (result) => {
            setEditing(null);
            if (result) setSecret(result);
            await reload();
          }}
        />
      )}
      {!clients ? (
        <p className="muted">Loading applications…</p>
      ) : clients.length === 0 ? (
        <p className="muted">
          No applications yet. Register one here, or let it register itself at the issuer’s
          registration endpoint.
        </p>
      ) : (
        <table className="grid">
          <thead>
            <tr><th>Application</th><th>Redirect URIs</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {clients.map((client) => (
              <tr key={client.client_id}>
                <td>
                  <div>
                    {client.client_name ?? 'Unnamed application'}
                    <span className="tag">{client.application_type ?? 'web'}</span>
                    {client.skip_consent && <span className="tag">no consent screen</span>}
                    {client.enable_end_session && <span className="tag">can sign out</span>}
                    {!client.user_id && <span className="tag">self-registered</span>}
                  </div>
                  <code className="client-id">{client.client_id}</code>
                </td>
                <td className="uris">
                  {client.redirect_uris.map((uri) => <div key={uri}><code>{uri}</code></div>)}
                </td>
                <td>
                  {client.disabled ? <span className="tag warn">disabled</span> : 'active'}
                  {!client.client_secret_set && <span className="tag">public</span>}
                </td>
                <td className="actions">
                  <button className="btn tiny" onClick={() => setEditing(client)}>Edit</button>
                  <button
                    className="btn tiny"
                    onClick={() =>
                      void act(async () => {
                        await updateOAuthClient(client.client_id, { disabled: !client.disabled });
                      })
                    }
                  >
                    {client.disabled ? 'Enable' : 'Disable'}
                  </button>
                  {client.client_secret_set && (
                    <button
                      className="btn tiny"
                      onClick={() =>
                        void act(async () => {
                          if (!confirm(`Rotate the secret for “${client.client_name ?? client.client_id}”? The current one stops working immediately.`)) return;
                          setSecret(
                            await rotateOAuthClientSecret(client.client_id).then((r) => ({
                              clientId: r.client.client_id,
                              clientSecret: r.clientSecret,
                            })),
                          );
                        })
                      }
                    >
                      Rotate secret
                    </button>
                  )}
                  <button
                    className="btn tiny danger"
                    onClick={() =>
                      void act(async () => {
                        if (!confirm(`Remove “${client.client_name ?? client.client_id}”? Its tokens and consents go with it.`)) return;
                        await deleteOAuthClient(client.client_id);
                        // Same as the providers panel: the editor outlives the row it edits
                        // unless it is told, and its next save would PATCH a client that is
                        // gone.
                        setEditing((current) =>
                          current !== 'new' && current?.client_id === client.client_id ? null : current,
                        );
                      })
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        Each application connects with its own client ID, so the login and consent screens can
        tell them apart — the name and icon here are what a person sees when that application
        asks them to sign in.
      </p>
    </section>
  );
}

/** A minted secret, shown once. There is no route that can show it again — that is deliberate. */
function SecretOnce({
  clientId, clientSecret, onDismiss,
}: { clientId: string; clientSecret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret-once">
      <p><strong>Copy this secret now.</strong> It is not stored anywhere you can read it again.</p>
      <dl className="kv">
        <dt>Client ID</dt><dd><code>{clientId}</code></dd>
        <dt>Client secret</dt><dd><code>{clientSecret}</code></dd>
      </dl>
      <div className="row">
        <button
          className="btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(clientSecret);
              setCopied(true);
            } catch {
              // Clipboard access can be refused; the value is on screen to select either way.
              setCopied(false);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy secret'}
        </button>
        <button className="btn" onClick={onDismiss}>Done</button>
      </div>
    </div>
  );
}

/**
 * The new/edit form. Redirect URIs are one per line and must match the application's callback
 * EXACTLY — the issuer compares them as strings, so a trailing slash is a different URI.
 * Metadata is free-form JSON the issuer stores and never interprets; it is there for the
 * login and consent screens to read per client.
 */
function ClientEditor({
  client, onCancel, onSaved,
}: {
  client: RegisteredClient | null;
  onCancel: () => void;
  onSaved: (secret: { clientId: string; clientSecret: string } | null) => void | Promise<void>;
}) {
  const [name, setName] = useState(client?.client_name ?? '');
  const [type, setType] = useState<ApplicationType>(
    (client?.application_type as ApplicationType | undefined) ?? EMPTY_DRAFT.application_type,
  );
  const [icon, setIcon] = useState(client?.logo_uri ?? '');
  const [uris, setUris] = useState((client?.redirect_uris ?? []).join('\n'));
  const [skipConsent, setSkipConsent] = useState(Boolean(client?.skip_consent));
  const [endSession, setEndSession] = useState(Boolean(client?.enable_end_session));
  const [logoutUris, setLogoutUris] = useState((client?.post_logout_redirect_uris ?? []).join('\n'));

  /**
   * The stored theme (`metadata.theme` — the vocabulary src/branding.ts sanitizes). The
   * common keys get their own fields below; everything else in the metadata object stays in
   * the raw JSON textarea, which therefore shows metadata WITHOUT `theme` — one owner per
   * key, so a save can never have the two halves fighting over the same value. Theme keys
   * without a field (colorInput, colorText, …) are carried through a save untouched.
   */
  const storedTheme = (client?.metadata?.theme ?? {}) as Record<string, unknown>;
  const themeText = (key: string): string => (typeof storedTheme[key] === 'string' ? (storedTheme[key] as string) : '');
  const [themeTitle, setThemeTitle] = useState(themeText('title'));
  const [themeLogo, setThemeLogo] = useState(themeText('logoUrl'));
  const [themePrimary, setThemePrimary] = useState(themeText('colorPrimary'));
  const [themePrimaryFg, setThemePrimaryFg] = useState(themeText('colorPrimaryForeground'));
  const [themeBackground, setThemeBackground] = useState(themeText('colorBackground'));
  const [themePanel, setThemePanel] = useState(themeText('colorPanel'));
  const [meta, setMeta] = useState(() => {
    const { theme: _theme, ...rest } = client?.metadata ?? {};
    return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr(null);
    let metadata: Record<string, unknown> = {};
    if (meta.trim()) {
      try {
        const value: unknown = JSON.parse(meta);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be a JSON object');
        metadata = value as Record<string, unknown>;
      } catch (e) {
        return setErr(`Metadata: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // The textarea does not own `theme` (its hint says so) — a raw one pasted there must
    // not survive past the fields, which would otherwise win only when non-empty.
    delete metadata.theme;
    // Reassemble the theme: the untouched extra keys, then the fields (empty = remove).
    const fields: [string, string][] = [
      ['title', themeTitle],
      ['logoUrl', themeLogo],
      ['colorPrimary', themePrimary],
      ['colorPrimaryForeground', themePrimaryFg],
      ['colorBackground', themeBackground],
      ['colorPanel', themePanel],
    ];
    const theme: Record<string, unknown> = Object.fromEntries(
      Object.entries(storedTheme).filter(([key]) => !fields.some(([field]) => field === key)),
    );
    for (const [key, value] of fields) if (value.trim()) theme[key] = value.trim();
    if (Object.keys(theme).length) metadata.theme = theme;
    const draft: ClientDraft = {
      client_name: name.trim(),
      application_type: type,
      redirect_uris: uris.split('\n').map((u) => u.trim()).filter(Boolean),
      metadata,
      skip_consent: skipConsent,
      enable_end_session: endSession,
      post_logout_redirect_uris: logoutUris.split('\n').map((u) => u.trim()).filter(Boolean),
      disabled: client?.disabled ?? false,
      ...(icon.trim() ? { logo_uri: icon.trim() } : {}),
    };
    setBusy(true);
    try {
      if (client) {
        await updateOAuthClient(client.client_id, draft);
        await onSaved(null);
      } else {
        const created = await createOAuthClient(draft);
        await onSaved({ clientId: created.client.client_id, clientSecret: created.clientSecret });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <h3>{client ? `Edit ${client.client_name ?? client.client_id}` : 'Register an application'}</h3>
      <Field label="Name" value={name} onChange={setName} hint="Shown on the consent screen — this is what people read." />
      <label className="field">
        <span>Application type</span>
        <select value={type} onChange={(e) => setType(e.target.value as ApplicationType)}>
          {APPLICATION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <em className="hint">
          A <code>web</code> client keeps its secret on a server. A <code>native</code> one is public — PKCE, and
          loopback or private-scheme redirect URIs are allowed.
        </em>
      </label>
      <label className="field">
        <span>Redirect URIs</span>
        <textarea rows={3} value={uris} onChange={(e) => setUris(e.target.value)} />
        <em className="hint">One per line, matched exactly. A `web` client needs HTTPS unless it is on loopback.</em>
      </label>
      <Field label="Logo URL" value={icon} onChange={setIcon} hint="Optional. Shown beside the name on the consent screen." />
      <label className="toggle">
        <input type="checkbox" checked={skipConsent} onChange={(e) => setSkipConsent(e.target.checked)} />
        <span>
          <strong>Skip the consent screen</strong>
          <em className="hint">
            For a first-party application you already trust. Nobody will be asked to approve the scopes it requests.
          </em>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={endSession} onChange={(e) => setEndSession(e.target.checked)} />
        <span>
          <strong>Let this application sign people out</strong>
          <em className="hint">
            Allows RP-initiated logout at <code>/oauth2/end-session</code>. Off by default, and
            without it the issuer answers <em>“The client is not allowed to initiate logout”</em>.
          </em>
        </span>
      </label>
      {endSession && (
        <label className="field">
          <span>Post-logout redirect URIs</span>
          <textarea rows={2} value={logoutUris} onChange={(e) => setLogoutUris(e.target.value)} />
          <em className="hint">
            One per line, matched exactly — and a SEPARATE list from the redirect URIs above. A
            <code>post_logout_redirect_uri</code> that is not here is ignored: the person is signed out
            and left on the issuer&apos;s own page. Leave blank if the application never asks to be
            sent back.
          </em>
        </label>
      )}
      <h3>Appearance</h3>
      <p className="muted small">
        How the sign-in, sign-up and consent screens look when this application sends someone
        here. Colors are hex (<code>#0a6847</code>); blank means the issuer&apos;s default.
      </p>
      <Field label="Sign-in title" value={themeTitle} onChange={setThemeTitle} hint="Replaces “Substrat Auth” as the sign-in heading." />
      <Field label="Logo URL" value={themeLogo} onChange={setThemeLogo} hint="https:// or data:image/ — shown above the heading." />
      <Field label="Primary color" value={themePrimary} onChange={setThemePrimary} hint="Buttons and links." />
      <Field label="Primary text color" value={themePrimaryFg} onChange={setThemePrimaryFg} hint="Text on the primary color — keep the contrast readable." />
      <Field label="Background color" value={themeBackground} onChange={setThemeBackground} />
      <Field label="Card color" value={themePanel} onChange={setThemePanel} />
      <label className="field">
        <span>Metadata (JSON)</span>
        <textarea rows={4} value={meta} onChange={(e) => setMeta(e.target.value)} placeholder={'{\n  "plan": "internal"\n}'} />
        <em className="hint">
          Stored as-is on the client. The <code>theme</code> key is owned by the fields above
          (further keys: <code>colorInput</code>, <code>colorText</code>, <code>colorMutedText</code>,{' '}
          <code>borderRadius</code> — settable via the API); everything else the issuer never reads.
        </em>
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : client ? 'Save changes' : 'Register'}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
