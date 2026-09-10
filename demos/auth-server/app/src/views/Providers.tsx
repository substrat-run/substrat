import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  identityProviders,
  saveIdentityProvider,
  type ConfiguredProvider,
  type ProviderCatalogueEntry,
  type ProviderDraft,
} from '../api';
import { Field } from '../primitives';
import { navigate } from '../console/router';
import { PROVIDERS_PATH } from '../console/routes';

/* ---- the upstream identity providers ---- */

/**
 * The directories this issuer will sign people in THROUGH — the other end of the registry
 * below. "Applications" holds the apps that send people here; this holds the providers this
 * issuer itself is a relying party of.
 *
 * The catalogue is closed on purpose (`src/providers.ts`): each entry is a provider Better
 * Auth ships endpoints and a profile mapping for, so enabling one is a credential and two
 * decisions rather than a form full of URLs to get subtly wrong.
 *
 * A list, and almost only a list: every provider with an id — configured or merely offered by
 * the catalogue — is a screen of its own at `/providers/<id>`, which is a place a link can
 * point at. The one editor still here is the custom OIDC provider nobody has named yet: its id
 * is the first field of the form, so until it is saved there is no URL for it to be at.
 */
export function ProvidersPanel({ issuer }: { issuer: string | null }) {
  const [catalogue, setCatalogue] = useState<ProviderCatalogueEntry[] | null>(null);
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [addingCustom, setAddingCustom] = useState(false);
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
                <tr><th>Provider</th><th>Client ID</th><th>Status</th></tr>
              </thead>
              <tbody>
                {providers.map((provider) => {
                  const entry = catalogue.find((e) => e.id === provider.id);
                  return (
                    <tr key={provider.id}>
                      <td>
                        <div>
                          <ProviderLink id={provider.id}>
                            {entry?.label ?? provider.label ?? provider.id}
                          </ProviderLink>
                          {provider.issuer && !entry && <span className="tag">custom OIDC</span>}
                          {provider.allowSignup && <span className="tag">creates accounts</span>}
                          {provider.trustEmail && <span className="tag">trusted email</span>}
                        </div>
                        {provider.tenantId && <code className="client-id">{provider.tenantId}</code>}
                        {provider.issuer && <code className="client-id">{provider.issuer}</code>}
                      </td>
                      <td><code>{provider.clientId}</code></td>
                      <td>{provider.disabled ? 'Disabled' : 'Enabled'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {!addingCustom && (
            <div className="add-provider">
              {/* A catalogue entry already HAS its id, so enabling it is the same screen as
                  editing it — and therefore a link rather than a button that unfolds a form. */}
              {unconfigured.map((entry) => (
                <ProviderLink key={entry.id} id={entry.id} className="btn">
                  + {entry.label}
                </ProviderLink>
              ))}
              <button className="btn" onClick={() => setAddingCustom(true)}>+ Custom (OIDC)</button>
            </div>
          )}
          {addingCustom && (
            <ProviderEditor
              issuer={issuer}
              entry={null}
              provider={null}
              onCancel={() => setAddingCustom(false)}
              onSaved={(id) => {
                setAddingCustom(false);
                // Straight to the screen the new provider now has: it has an id, so from here
                // on it is edited where a link can point, like every other row.
                navigate(`${PROVIDERS_PATH}/${id}`);
              }}
            />
          )}
          {providers.length > 0 && (
            <p className="muted small">
              Open a provider to change its credentials, disable it or remove it. Removing one
              leaves the people who signed in with it needing another way in.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * A real anchor to `/providers/<id>`, not a click handler on a cell: the row's whole point is
 * that it is now a place, so it has to be copyable, middle-clickable and openable in a tab. The
 * plain click stays same-document.
 */
function ProviderLink({
  id, className, children,
}: { id: string; className?: string; children: ReactNode }) {
  const href = `${PROVIDERS_PATH}/${id}`;
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
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
export function ProviderEditor({
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
  /** Absent on the detail screen: there is nothing to back out to, the screen IS the form. */
  onCancel?: () => void;
  /** Handed the id that was saved — the custom case is the only caller that did not know it. */
  onSaved: (id: string) => void | Promise<void>;
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
  const [saved, setSaved] = useState(false);

  const providerId = entry?.id ?? provider?.id ?? customId.trim();
  const displayName = entry?.label ?? provider?.label ?? (label.trim() || 'custom provider');

  const save = async () => {
    setErr(null);
    setSaved(false);
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
      await onSaved(providerId);
      // On the detail screen the form is the screen, so nothing closes to signal the save
      // happened. Said out loud instead — and only after the await, so it is a report rather
      // than a hope. Cleared by the next edit, below.
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      // Reset either way: on the list this component unmounts and the write is a no-op, but on
      // the detail screen it stays mounted, and a `busy` never cleared is a Save button that
      // never comes back.
      setBusy(false);
    }
  };

  return (
    <div className="editor" onInput={() => setSaved(false)}>
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
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        {saved && <span className="muted small">Saved.</span>}
      </div>
    </div>
  );
}
