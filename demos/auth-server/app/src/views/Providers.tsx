import { useCallback, useEffect, useState } from 'react';
import {
  identityProviders,
  removeIdentityProvider,
  saveIdentityProvider,
  type ConfiguredProvider,
  type ProviderCatalogueEntry,
  type ProviderDraft,
} from '../api';
import { Field } from '../primitives';

/* ---- the upstream identity providers ---- */

/**
 * The directories this issuer will sign people in THROUGH — the other end of the registry
 * below. "Applications" holds the apps that send people here; this holds the providers this
 * issuer itself is a relying party of.
 *
 * The catalogue is closed on purpose (`src/providers.ts`): each entry is a provider Better
 * Auth ships endpoints and a profile mapping for, so enabling one is a credential and two
 * decisions rather than a form full of URLs to get subtly wrong.
 */
/**
 * The editor sentinel for "a custom provider being created". Not a valid provider id — the
 * server only accepts lowercase slugs — so it can never collide with a configured row.
 */
const NEW_CUSTOM = '::custom';

export function ProvidersPanel({ issuer }: { issuer: string | null }) {
  const [catalogue, setCatalogue] = useState<ProviderCatalogueEntry[] | null>(null);
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const state = await identityProviders();
      setCatalogue(state.catalogue);
      setProviders(state.providers);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const configured = (id: string) => providers.find((p) => p.id === id);
  const unconfigured = (catalogue ?? []).filter((entry) => !configured(entry.id));

  return (
    <section className="panel">
      <div className="panel-head"><h2>Sign-in providers</h2></div>
      {err && <p className="error">{err}</p>}
      {!catalogue ? (
        <p className="muted">Loading providers…</p>
      ) : (
        <>
          <p className="muted">
            Directories this issuer signs people in through. Enabling one adds a “Continue with
            …” button to the login screen — including for people a relying party sent here.
            “Custom (OIDC)” takes any standards-compliant issuer by URL — Keycloak, Okta,
            Auth0, or another auth server like this one.
          </p>
          {providers.length > 0 && (
            <table className="grid">
              <thead>
                <tr><th>Provider</th><th>Client ID</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {providers.map((provider) => {
                  const entry = catalogue.find((e) => e.id === provider.id);
                  return (
                    <tr key={provider.id}>
                      <td>
                        <div>
                          {entry?.label ?? provider.label ?? provider.id}
                          {provider.issuer && !entry && <span className="tag">custom OIDC</span>}
                          {provider.allowSignup && <span className="tag">creates accounts</span>}
                          {provider.trustEmail && <span className="tag">trusted email</span>}
                        </div>
                        {provider.tenantId && <code className="client-id">{provider.tenantId}</code>}
                        {provider.issuer && <code className="client-id">{provider.issuer}</code>}
                      </td>
                      <td><code>{provider.clientId}</code></td>
                      <td>{provider.disabled ? 'Disabled' : 'Enabled'}</td>
                      <td className="actions">
                        <button className="btn tiny" onClick={() => setEditing(provider.id)}>Edit</button>
                        <button
                          className="btn tiny danger"
                          onClick={async () => {
                            if (!window.confirm(`Remove ${entry?.label ?? provider.label ?? provider.id}? People who signed in with it will need another way in.`)) return;
                            try {
                              await removeIdentityProvider(provider.id);
                              // Close the editor if it was showing THIS provider. The table
                              // stays clickable while it is open, so Remove can be pressed on
                              // the row being edited — and the key that fixes provider-to-
                              // provider switching cannot help here, because the id has not
                              // changed. Without this the form survives its own row, flips to
                              // "Enable", and keeps the deleted client id and toggles.
                              // Functional, so a newer editor opened meanwhile is left alone.
                              setEditing((current) => (current === provider.id ? null : current));
                              await reload();
                            } catch (e) {
                              setErr(e instanceof Error ? e.message : String(e));
                            }
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!editing && (
            <div className="add-provider">
              {unconfigured.map((entry) => (
                <button key={entry.id} className="btn" onClick={() => setEditing(entry.id)}>
                  + {entry.label}
                </button>
              ))}
              {/* NEW_CUSTOM is not a valid provider id (the server only accepts lowercase
                  slugs), so it can never collide with a configured row. */}
              <button className="btn" onClick={() => setEditing(NEW_CUSTOM)}>+ Custom (OIDC)</button>
            </div>
          )}
          {editing && (
            <ProviderEditor
              // The table stays clickable while the editor is open, so Edit on a second
              // provider changes `editing` without unmounting this. Same element type in the
              // same position ⇒ React keeps the instance and its `useState` initialisers do
              // not re-run, so the form would still hold the FIRST provider's credentials and
              // save them onto the second one's row. The key is what makes it a remount.
              key={editing}
              issuer={issuer}
              entry={catalogue.find((e) => e.id === editing) ?? null}
              provider={configured(editing) ?? null}
              onCancel={() => setEditing(null)}
              onSaved={async () => {
                setEditing(null);
                await reload();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * One provider's credentials and the two decisions that come with it.
 *
 * The redirect URI is SHOWN, not asked for: it is derived from the provider id and this
 * issuer's own origin, and every upstream refuses the sign-in outright if what is registered
 * there differs by so much as a trailing slash. Making an operator retype it would only
 * introduce a way to get it wrong.
 *
 * With no catalogue `entry` this edits a CUSTOM (generic OIDC) provider instead: the operator
 * names it (the id becomes the callback path segment, so it is asked once and then fixed),
 * labels its button, and pastes the upstream's issuer URL — discovery derives the endpoints.
 */
function ProviderEditor({
  issuer, entry, provider, onCancel, onSaved,
}: {
  /**
   * The issuer's OWN origin, from discovery — not `window.location.origin`. In production they
   * are the same host; in dev the dashboard is served by Vite on another port, and printing
   * that one would tell an operator to register a redirect URI the issuer will never send.
   */
  issuer: string | null;
  entry: ProviderCatalogueEntry | null;
  provider: ConfiguredProvider | null;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [customId, setCustomId] = useState(provider?.id ?? '');
  const [label, setLabel] = useState(provider?.label ?? '');
  const [issuerUrl, setIssuerUrl] = useState(provider?.issuer ?? '');
  const [clientId, setClientId] = useState(provider?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [tenantId, setTenantId] = useState(provider?.tenantId ?? '');
  const [allowSignup, setAllowSignup] = useState(provider?.allowSignup ?? false);
  const [trustEmail, setTrustEmail] = useState(provider?.trustEmail ?? false);
  const [disabled, setDisabled] = useState(provider?.disabled ?? false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const providerId = entry?.id ?? provider?.id ?? customId.trim();
  const displayName = entry?.label ?? provider?.label ?? (label.trim() || 'custom provider');

  const save = async () => {
    setErr(null);
    // Refused here, not by the server: an empty id would make the PUT's path `/providers/`,
    // which matches no route and comes back as a 404 that names no field.
    if (!providerId) {
      setErr('A provider ID is required — it becomes the callback path segment.');
      return;
    }
    const draft: ProviderDraft = {
      clientId: clientId.trim(),
      // Empty means "leave the stored secret alone" — an edit that only flips a toggle must
      // not require re-pasting a credential the operator may no longer have.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      tenantId: tenantId.trim() || null,
      // A NAMED generic entry (Supabase) sends the issuer but not the label — that one is the
      // catalogue's, and the server fills it in from there. An UNNAMED custom provider sends
      // both. A built-in sends neither.
      ...(entry?.issuerField
        ? { issuer: issuerUrl.trim() }
        : entry
          ? {}
          : { issuer: issuerUrl.trim(), label: label.trim() }),
      allowSignup,
      trustEmail,
      disabled,
    };
    setBusy(true);
    try {
      await saveIdentityProvider(providerId, draft);
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <h3>{provider ? `Edit ${displayName}` : entry ? `Enable ${entry.label}` : 'Add a custom OIDC provider'}</h3>
      {!entry && (
        <>
          <Field
            label="Provider ID"
            value={provider?.id ?? customId}
            onChange={setCustomId}
            disabled={Boolean(provider)}
            hint={provider
              ? 'Fixed — it is the callback path segment the upstream has registered.'
              : 'Lowercase letters, digits and hyphens (e.g. acme-sso). It becomes the callback path segment, so it cannot change later.'}
          />
          <Field label="Button label" value={label} onChange={setLabel} hint="The login screen offers “Continue with <this>”." />
          <Field
            label="Issuer URL"
            value={issuerUrl}
            onChange={setIssuerUrl}
            hint="The upstream's OIDC issuer, e.g. https://id.example.com — its discovery document provides the endpoints."
          />
        </>
      )}
      {/* A NAMED generic entry asks the same question, in the provider's own words: it is a
          generic row underneath, so the issuer URL is still the whole configuration — but the
          catalogue knows what that provider's issuer looks like, and an operator does not. */}
      {entry?.issuerField && (
        <Field
          label={entry.issuerField.label}
          value={issuerUrl}
          onChange={setIssuerUrl}
          placeholder={entry.issuerField.placeholder}
          hint={entry.issuerField.hint}
        />
      )}
      <label className="field">
        <span>Redirect URI</span>
        <code>
          {(issuer ?? window.location.origin).replace(/\/$/, '')}
          {provider?.callbackPath ?? `/api/auth/callback/${providerId || '<provider-id>'}`}
        </code>
        <em className="hint">
          Register this exactly, at {entry ? entry.console : 'the upstream provider’s client registration'}. Matched character for character.
        </em>
      </label>
      <Field label="Client ID" value={clientId} onChange={setClientId} />
      <Field
        label={provider?.clientSecretSet ? 'Client secret (stored — type to replace)' : 'Client secret'}
        value={clientSecret}
        onChange={setClientSecret}
        type="password"
        hint={provider?.clientSecretSet ? 'Leave blank to keep the secret already stored.' : undefined}
      />
      {entry?.tenantField && (
        <Field
          label={entry.tenantField.label}
          value={tenantId}
          onChange={setTenantId}
          placeholder={entry.tenantField.placeholder}
          hint={entry.tenantField.hint}
        />
      )}
      <label className="toggle">
        <input type="checkbox" checked={allowSignup} onChange={(e) => setAllowSignup(e.target.checked)} />
        <span>
          <strong>Let this provider create accounts</strong>
          <em className="hint">
            On, anyone who can sign in upstream gets an account here — for a directory you own,
            that is usually the point. Off, only people who already have an account can use it.
            Separate from the issuer-wide sign-up toggle, which is about passwords.
          </em>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={trustEmail} onChange={(e) => setTrustEmail(e.target.checked)} />
        <span>
          <strong>Trust this provider’s email addresses</strong>
          <em className="hint">
            Lets someone sign in to an account that already exists here with the same address.
            Without it they are refused with “account not linked” — Microsoft in particular does
            not assert that an address is verified. The local account must also have a verified
            email, which this toggle cannot supply: an account you created here has never had
            one proved, and that refusal survives trusting the provider. The way past it that
            needs no trust is the person's own — sign in as usual, then connect the provider
            under “Sign-in methods”. Only turn this on for a directory that controls its
            addresses.
          </em>
        </span>
      </label>
      <label className="toggle">
        <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
        <span>
          <strong>Disabled</strong>
          <em className="hint">Keeps the credentials but takes the button off the login screen.</em>
        </span>
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : provider ? 'Save changes' : entry ? 'Enable' : 'Add provider'}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
