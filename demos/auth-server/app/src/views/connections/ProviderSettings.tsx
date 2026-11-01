import { useState } from 'react';
import {
  removeIdentityProvider,
  saveIdentityProvider,
  type ConfiguredProvider,
  type ProviderCatalogueEntry,
  type ProviderDraft,
} from '../../api';
import { Field } from '../../primitives';
import { navigate } from '../../console/router';
import { CONNECTIONS_PATH } from '../../console/routes';

/* ---- an upstream provider's Settings tab ---- */

/**
 * The Settings tab of an upstream connection: the stored facts, the credentials form, and
 * Remove. Moved here from the old `/providers/<id>` screen with its behaviour intact; what
 * changed is only where it sits — under the connection's header and tabs rather than above a
 * back link.
 *
 * An id is a place whether or not it is configured yet. A catalogue entry nobody has enabled
 * has an id all the same, so `/connections/google` is the screen that enables Google — the same
 * screen that afterwards edits it.
 */
export function ProviderSettings({
  issuer, entry, provider, onSaved,
}: {
  issuer: string | null;
  entry: ProviderCatalogueEntry | null;
  provider: ConfiguredProvider | null;
  onSaved: () => Promise<void>;
}) {
  return (
    <>
      {provider && <ProviderFacts provider={provider} />}
      <section className="panel">
        <div className="panel-head">
          <h2>{provider?.platform ? 'Settings' : provider ? 'Credentials' : 'Enable this connection'}</h2>
        </div>
        {/* No key needed here: the whole detail view is keyed by the connection id at its call
            site, so one provider's unsaved credentials cannot outlive a move to another. */}
        <ProviderEditor issuer={issuer} entry={entry} provider={provider} onSaved={onSaved} />
      </section>
      {/* A platform row cannot be removed — it would be delivered again — only switched off. */}
      {provider && !provider.platform && <ProviderActions provider={provider} entry={entry} />}
    </>
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
  // A platform row (#1544): the credential, issuer and label are the platform's and are
  // re-delivered, so the server keeps them whatever is sent. Only the decisions are shown.
  const platform = provider?.platform === true;
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
      {platform && (
        <p className="muted">
          Provided by Substrat. The platform holds the credential for {displayName} and keeps it
          up to date, so there is nothing to register or paste. People see Substrat’s name on
          {' '}{displayName}’s consent screen; to show your own, add {displayName} with your own
          client instead.
        </p>
      )}
      {!entry && !platform && (
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
      {!platform && (<>
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
      </>)}
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
            Separate from the sign-up switch on the Username-Password connection, which is about
            passwords.
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
          <em className="hint">
            {platform
              ? 'Off by default. Untick to add the button to the login screen.'
              : 'Keeps the credentials but takes the button off the login screen.'}
          </em>
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

/* ---- what is stored ---- */

function ProviderFacts({ provider }: { provider: ConfiguredProvider }) {
  return (
    <section className="panel">
      {/* Not the provider's name: the connection header above already says it, with its kind.
          This panel is the stored row, the form below it is what replaces the row, and the
          heading is what tells the two apart. */}
      <div className="panel-head"><h2>Stored configuration</h2></div>
      <dl className="kv">
        <dt>Provider ID</dt>
        {/* The callback path segment, and therefore the one string that has to match what was
            registered upstream. Fixed once saved, which is why it is a fact here rather than a
            field below. */}
        <dd><code>{provider.id}</code></dd>
        <dt>Status</dt>
        <dd>
          {provider.disabled ? <span className="tag warn">disabled</span> : 'enabled'}
          {provider.allowSignup && <span className="tag">creates accounts</span>}
          {provider.trustEmail && <span className="tag">trusted email</span>}
          {provider.attention && <span className="tag warn">not offered</span>}
        </dd>
        {provider.attention && (
          <>
            <dt>Needs attention</dt>
            <dd>{provider.attention}</dd>
          </>
        )}
        <dt>Client ID</dt>
        <dd><code>{provider.clientId}</code></dd>
        {provider.issuer && (
          <>
            <dt>Issuer URL</dt>
            <dd><code>{provider.issuer}</code></dd>
          </>
        )}
        {provider.tenantId && (
          <>
            <dt>Tenant</dt>
            <dd><code>{provider.tenantId}</code></dd>
          </>
        )}
        {/* No redirect URI here: the editor below already prints it, with the sentence that
            makes it useful ("register this exactly, matched character for character"). Saying
            it twice on one screen invites a reader to check whether the two agree. */}
        <dt>Last changed</dt>
        {/* `updatedAt` is epoch milliseconds, and null for a row that predates the column. */}
        <dd>{provider.updatedAt ? new Date(provider.updatedAt).toLocaleString() : '—'}</dd>
      </dl>
    </section>
  );
}

/* ---- the lever that is not a field ---- */

function ProviderActions({
  provider, entry,
}: { provider: ConfiguredProvider; entry: ProviderCatalogueEntry | null }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = entry?.label ?? provider.label ?? provider.id;

  return (
    <section className="panel">
      <div className="panel-head"><h2>Actions</h2></div>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button
          className="btn danger"
          disabled={busy}
          onClick={() =>
            void (async () => {
              if (!window.confirm(`Remove ${name}? People who signed in with it will need another way in.`)) return;
              setBusy(true);
              setErr(null);
              try {
                await removeIdentityProvider(provider.id);
                // Back to the list rather than staying on a screen whose row is gone. A
                // catalogue entry's screen would still be a place — it would offer to enable
                // the provider again — which is the wrong answer to a removal just made.
                navigate(CONNECTIONS_PATH);
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
                setBusy(false);
              }
            })()
          }
        >
          Remove
        </button>
      </div>
      <p className="muted small">
        Removing takes the button off the login screen and forgets the credentials. To keep them
        and only hide the button, tick <strong>Disabled</strong> above instead.
      </p>
    </section>
  );
}
