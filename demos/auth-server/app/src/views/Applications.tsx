import { useCallback, useEffect, useState } from 'react';
import {
  APPLICATION_TYPES,
  createOAuthClient,
  deleteOAuthClient,
  listOAuthClients,
  rotateOAuthClientSecret,
  setupState,
  updateOAuthClient,
  type ApplicationType,
  type ClientDraft,
  type PublicProvider,
  type RegisteredClient,
} from '../api';
import { Field } from '../primitives';

/* ---- the relying-party registry ---- */

/** The id `src/sign-in-policy.ts` stamps and matches a password sign-in under. */
const PASSWORD_METHOD = 'password';
/** This form's local stand-in for a stored policy with no `providers` key at all ("any
 *  provider"), held only until the offered list arrives and can replace it with the real ids. */
const ANY_PROVIDER = '*';

const EMPTY_DRAFT: ClientDraft = {
  client_name: '',
  application_type: 'web',
  redirect_uris: [],
  logo_uri: '',
  metadata: {},
  skip_consent: false,
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
  /**
   * The stored sign-in policy (`metadata.signIn` — `src/sign-in-policy.ts`). Absent is the
   * default and means every method the issuer offers; present means exactly the ones ticked.
   *
   * The choices come from `setupState()`, the same public read the login screen uses, so this
   * form can only offer providers that actually exist — a policy naming one that does not is
   * a client nobody can sign into, and it should not be possible to write it here.
   */
  const storedPolicy = (client?.metadata?.signIn ?? null) as { providers?: unknown; password?: unknown } | null;
  /**
   * The issuer's live providers — `null` until the read below answers, and that distinction is
   * load-bearing rather than tidy. `save` writes the policy as `offered ∩ methods`, so an
   * empty list while the read is still in flight (or after it failed) serializes
   * `providers: []` — a valid policy the API accepts, and one that silently turns a
   * Microsoft-and-password client into a password-only one. So the checkbox list has three
   * states, not two, and saving a RESTRICTED policy waits for this to be one of them.
   */
  const [offered, setOffered] = useState<PublicProvider[] | null>(null);
  const [offeredError, setOfferedError] = useState<string | null>(null);
  const [restrict, setRestrict] = useState(storedPolicy !== null);
  const [methods, setMethods] = useState<Set<string>>(() => {
    const chosen = new Set<string>(Array.isArray(storedPolicy?.providers) ? (storedPolicy.providers as string[]) : []);
    // Absent `providers` means "any provider", which this form shows as all of them ticked —
    // resolved against the offered list once it arrives (below).
    if (storedPolicy && !Array.isArray(storedPolicy.providers)) chosen.add(ANY_PROVIDER);
    if (!storedPolicy || storedPolicy.password !== false) chosen.add(PASSWORD_METHOD);
    return chosen;
  });
  useEffect(() => {
    void (async () => {
      try {
        const state = await setupState();
        setOffered(state.providers);
        setMethods((current) => {
          if (!current.has(ANY_PROVIDER)) return current;
          const resolved = new Set(current);
          resolved.delete(ANY_PROVIDER);
          for (const provider of state.providers) resolved.add(provider.id);
          return resolved;
        });
      } catch (e) {
        // Said out loud rather than swallowed: without this list the form cannot show what
        // the stored policy contains, let alone write a new one.
        setOfferedError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);
  const toggleMethod = (id: string, on: boolean) =>
    setMethods((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const [meta, setMeta] = useState(() => {
    const { theme: _theme, signIn: _signIn, ...rest } = client?.metadata ?? {};
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
    // The textarea does not own `theme` or `signIn` (its hint says so) — a raw one pasted
    // there must not survive past the fields, which would otherwise win only when non-empty.
    delete metadata.theme;
    delete metadata.signIn;
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
    // Unrestricted writes NO key at all rather than a permissive one: absent is the documented
    // default, and a stored `{providers: [...everything], password: true}` would silently stop
    // following the issuer as providers are added.
    if (restrict) {
      // Guarded, not defaulted: `offered` is what turns the ticked boxes into a provider list,
      // and an absent one would write "no providers" — a policy nobody chose.
      if (!offered) {
        return setErr(
          offeredError
            ? `Sign-in methods: the issuer's providers could not be read (${offeredError}), so this policy cannot be saved without changing it.`
            : 'Sign-in methods: still loading the issuer’s providers — try again in a moment.',
        );
      }
      metadata.signIn = {
        providers: offered.filter((p) => methods.has(p.id)).map((p) => p.id),
        password: methods.has(PASSWORD_METHOD),
      };
    }
    const draft: ClientDraft = {
      client_name: name.trim(),
      application_type: type,
      redirect_uris: uris.split('\n').map((u) => u.trim()).filter(Boolean),
      metadata,
      skip_consent: skipConsent,
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
      <h3>Sign-in methods</h3>
      <p className="muted small">
        Which ways people may sign in when this application sends them here. This is enforced
        at the authorize endpoint, not merely on the screen: a session established another way
        is asked to sign in again rather than handed a code.
      </p>
      <label className="toggle">
        <input type="checkbox" checked={!restrict} onChange={(e) => setRestrict(!e.target.checked)} />
        <span>
          <strong>Accept every method this issuer offers</strong>
          <em className="hint">
            The default. New providers become available to this application as they are added.
          </em>
        </span>
      </label>
      {restrict && (
        <div className="methods">
          <label className="toggle">
            <input
              type="checkbox"
              checked={methods.has(PASSWORD_METHOD)}
              onChange={(e) => toggleMethod(PASSWORD_METHOD, e.target.checked)}
            />
            <span>Email and password</span>
          </label>
          {(offered ?? []).map((provider) => (
            <label className="toggle" key={provider.id}>
              <input
                type="checkbox"
                checked={methods.has(provider.id)}
                onChange={(e) => toggleMethod(provider.id, e.target.checked)}
              />
              <span>{provider.label}</span>
            </label>
          ))}
          {/* Three states, because "none configured" and "not read yet" are different answers
              and only one of them means the boxes below are the whole truth. */}
          {offeredError ? (
            <p className="error">
              The issuer’s sign-in providers could not be read ({offeredError}), so this
              application’s policy cannot be edited. Reload the page to try again.
            </p>
          ) : !offered ? (
            <em className="hint">Loading the providers this issuer offers…</em>
          ) : !offered.length ? (
            <em className="hint">
              This issuer has no upstream provider configured yet — add one under Sign-in
              providers, and it can be chosen here.
            </em>
          ) : null}
          <em className="hint">
            Exactly one method ticked and no password: people are sent straight to it, with no
            sign-in screen in between.
          </em>
        </div>
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
          Stored as-is on the client. The <code>theme</code> and <code>signIn</code> keys are owned by the fields above
          (further keys: <code>colorInput</code>, <code>colorText</code>, <code>colorMutedText</code>,{' '}
          <code>borderRadius</code> — settable via the API); everything else the issuer never reads.
        </em>
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy || (restrict && !offered)} onClick={() => void save()}>
          {busy ? 'Saving…' : client ? 'Save changes' : 'Register'}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
