import type { ApplicationTab } from '../console/paths';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState } from '@substrat-run/ui';
import {
  APPLICATION_TYPES,
  createOAuthClient,
  deleteOAuthClient,
  issuerSettings,
  listOAuthClients,
  rotateOAuthClientSecret,
  setupState,
  updateOAuthClient,
  type ApplicationType,
  type ClientDraft,
  type IssuerSettings,
  type MachineClientDraft,
  type PublicProvider,
  type RegisteredClient,
} from '../api';
import { Field } from '../primitives';
import { SignInPolicyEditor } from './SignInPolicyEditor';
import { draftFromStored, draftProblems, draftToStored, resolveAny, type PolicyDraft } from './sign-in-draft';
import { navigate } from '../console/router';
import { APPLICATIONS_PATH } from '../console/routes';

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
 * `/applications/:clientId` — one relying party, which the console has never had. Everything
 * an application is was edited in a form that unfolded UNDER the table: eight or so fields, a
 * theme, a sign-in policy and two URI lists, with no URL of its own. So the settings an
 * operator was reading could not be linked to, survived neither a reload nor a sign-in, and
 * sat on top of the list they were trying to compare it against.
 *
 * The read is the same list the table uses — there is no per-client GET on the admin API and
 * this screen deliberately does not add one: an issuer's registry is a handful of rows, and a
 * second server surface for a `find` is a surface to authorize, test and keep in step for no
 * new fact.
 *
 * The nav is not the gate here — every call below is refused server-side by session + the
 * `admin` role, and this component simply is not rendered for anyone else.
 */
export function ApplicationDetailView({ clientId }: { clientId: string; tab: ApplicationTab }) {
  const [client, setClient] = useState<RegisteredClient | null | 'missing'>(null);
  const [err, setErr] = useState<string | null>(null);
  /** A freshly minted secret, held until dismissed — the only moment it is knowable. */
  const [secret, setSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const found = (await listOAuthClients()).find((c) => c.client_id === clientId);
      setClient(found ?? 'missing');
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [clientId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // A pasted link to an application that has since been un-registered. It is a real outcome of
  // the feature — the link outlives the row — so it gets an answer rather than a spinner that
  // never resolves.
  if (client === 'missing') {
    return (
      <EmptyState
        title="No such application"
        description={`Nothing registered here has the client id ${clientId}. It may have been removed since this link was shared.`}
        action={
          <button className="btn primary" style={{ width: 'auto' }} onClick={() => navigate(APPLICATIONS_PATH)}>
            Back to Applications
          </button>
        }
      />
    );
  }

  return (
    <>
      <button
        className="btn link"
        style={{ justifySelf: 'start', padding: 0 }}
        onClick={() => navigate(APPLICATIONS_PATH)}
      >
        ← Applications
      </button>
      {err && <p className="error">{err}</p>}
      {secret && <SecretOnce {...secret} onDismiss={() => setSecret(null)} />}
      {/* A failed read is an error state, not a pending one. Saying "Loading…" underneath the
          error would tell an operator to keep waiting for a request that already came back. */}
      {client === null ? (
        !err && <p className="muted">Loading this application…</p>
      ) : (
        <>
          <ApplicationHeader client={client} />
          <section className="panel">
            <div className="panel-head"><h2>Settings</h2></div>
            {/* No key needed here: the whole view is keyed by `clientId` at its call site, so
                one application's unsaved form cannot outlive a move to another. */}
            <ClientEditor
              client={client}
              onSaved={async () => {
                await reload();
              }}
            />
          </section>
          <ApplicationActions client={client} onSecret={setSecret} onChanged={reload} />
        </>
      )}
    </>
  );
}

/* ---- what this application is ---- */

function ApplicationHeader({ client }: { client: RegisteredClient }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          {client.client_name ?? 'Unnamed application'}{' '}
          {client.builtin ? (
            <span className="tag">this issuer</span>
          ) : (
            <span className="tag">{client.application_type ?? 'web'}</span>
          )}
        </h2>
      </div>
      <dl className="kv">
        <dt>Client ID</dt>
        <dd>
          {/* Copyable because it is the string the application itself is configured with, and
              matching "our login stopped working" to a row here starts with it. */}
          <code>{client.client_id}</code>{' '}
          <button
            className="btn tiny"
            onClick={async () => {
              // Only claim it was copied if it was. `navigator.clipboard` is absent outside a
              // secure context, and a button that says "Copied" over an empty clipboard is
              // worse than one that does nothing visible.
              try {
                await navigator.clipboard.writeText(client.client_id);
              } catch {
                return;
              }
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </dd>
        <dt>Status</dt>
        <dd>
          {client.disabled ? <span className="tag warn">disabled</span> : 'active'}
          {!client.builtin && !client.client_secret_set && <span className="tag">public</span>}
          {!client.builtin && client.skip_consent && <span className="tag">no consent screen</span>}
          {!client.builtin && client.enable_end_session && <span className="tag">can sign out</span>}
          {!client.builtin && !client.user_id && <span className="tag">self-registered</span>}
        </dd>
        {client.application_type === 'machine' ? (
          <>
            <dt>Scopes</dt>
            <dd>
              {(client.client_credentials_scopes ?? []).map((scope) => <code key={scope}>{scope} </code>)}
            </dd>
          </>
        ) : (
          <>
            <dt>Redirect URIs</dt>
            {/* No `uris` class: that one styles a table cell, and `.kv dd` already wraps a long
                URI the same way. */}
            <dd>
              {client.builtin ? (
                <span className="muted">the admin console — signs in here, never redirects</span>
              ) : client.redirect_uris.length === 0 ? (
                <span className="muted">none</span>
              ) : (
                client.redirect_uris.map((uri) => <div key={uri}><code>{uri}</code></div>)
              )}
            </dd>
          </>
        )}
        <dt>Registered</dt>
        <dd>
          {/* `client_id_issued_at` is RFC 7591's seconds-since-epoch, not milliseconds — the
              two are a factor of a thousand apart and one of them renders as 1970. */}
          {client.client_id_issued_at ? new Date(client.client_id_issued_at * 1000).toLocaleString() : '—'}
        </dd>
      </dl>
    </section>
  );
}

/* ---- the levers that are not a field ---- */

function ApplicationActions({
  client, onSecret, onChanged,
}: {
  client: RegisteredClient;
  onSecret: (secret: { clientId: string; clientSecret: string }) => void;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head"><h2>Actions</h2></div>
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button
          className="btn"
          disabled={busy}
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
            className="btn"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (!confirm(`Rotate the secret for “${client.client_name ?? client.client_id}”? The current one stops working immediately.`)) return;
                const rotated = await rotateOAuthClientSecret(client.client_id);
                onSecret({ clientId: rotated.client.client_id, clientSecret: rotated.clientSecret });
              })
            }
          >
            Rotate secret
          </button>
        )}
        {/* The console's row is this issuer's own and the API refuses to delete it (a blank one
            would be seeded back on the next boot, minus the theme and policy an operator put on
            it). Disable, above, is the reversible verb that means what a delete here would be
            reaching for. */}
        {!client.builtin && (
          <button
            className="btn danger"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                if (!confirm(`Remove “${client.client_name ?? client.client_id}”? Its tokens and consents go with it.`)) return;
                await deleteOAuthClient(client.client_id);
                // Back to the list rather than staying on a screen whose row is gone: the
                // reload this returns to would land on "No such application", which is the
                // right answer to a pasted link and the wrong one to a delete you just made.
                navigate(APPLICATIONS_PATH);
              })
            }
          >
            Remove
          </button>
        )}
      </div>
    </section>
  );
}

/** A minted secret, shown once. There is no route that can show it again — that is deliberate. */
export function SecretOnce({
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
 * The application's settings form. It lives here because this is the screen it belongs to;
 * `Applications.tsx` imports it for the one case that has no screen — registering a client
 * that does not exist yet, and therefore has no id and no URL to be at.
 *
 * Redirect URIs are one per line and must match the application's callback EXACTLY — the
 * issuer compares them as strings, so a trailing slash is a different URI. Metadata is
 * free-form JSON the issuer stores and never interprets; it is there for the login and consent
 * screens to read per client.
 */
export function ClientEditor({
  client, onCancel, onSaved,
}: {
  client: RegisteredClient | null;
  /** Absent on the detail screen: there is nothing to back out to, the screen IS the form. */
  onCancel?: () => void;
  onSaved: (secret: { clientId: string; clientSecret: string } | null) => void | Promise<void>;
}) {
  /**
   * The issuer's own console (`src/console-client.ts`). Everything OAuth-shaped is absent
   * from this row on purpose — it holds no redirect URI, no secret and no consent decision,
   * because the console signs in over its own session and never redirects. So the fields
   * that describe a redirect flow are hidden rather than shown empty, and the save below
   * names only the keys that mean something here.
   */
  const builtin = Boolean(client?.builtin);
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
   * A machine client: no sign-in, so none of the redirect, consent, logout, sign-in-policy or
   * appearance fields below apply to it — they are hidden, and never sent. A client's kind is
   * fixed once it is registered (the API refuses the move either way), so an existing client
   * is only offered the kinds on its own side of that line.
   */
  const machine = type === 'machine';
  const kinds = APPLICATION_TYPES.filter((t) => !client || (t === 'machine') === (client.application_type === 'machine'));
  const [scopes, setScopes] = useState<string[]>(client?.client_credentials_scopes ?? []);
  /** The issuer's `MACHINE_SCOPES` — what the scope boxes offer. `null` until read. */
  const [ceiling, setCeiling] = useState<IssuerSettings | null>(null);
  useEffect(() => {
    if (!machine || ceiling) return;
    void issuerSettings()
      .then(setCeiling)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, [machine, ceiling]);

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
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFromStored(client?.metadata?.signIn));
  /**
   * The issuer's live providers — `null` until the read below answers, and that distinction is
   * load-bearing rather than tidy. `save` writes the policy as `offered ∩ methods`, so an
   * empty list while the read is still in flight (or after it failed) serializes
   * `providers: []` — a valid policy the API accepts, and one that silently turns a
   * Microsoft-and-password client into a password-only one. So the editor has three states,
   * not two, and saving a RESTRICTED policy waits for this to be one of them.
   */
  const [offered, setOffered] = useState<PublicProvider[] | null>(null);
  const [offeredError, setOfferedError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const state = await setupState();
        setOffered(state.providers);
        // Absent `providers` means "any provider", shown as all of them ticked.
        setDraft((current) => resolveAny(current, state.providers));
      } catch (e) {
        // Said out loud rather than swallowed: without this list the form cannot show what
        // the stored policy contains, let alone write a new one.
        setOfferedError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  const [meta, setMeta] = useState(() => {
    const { theme: _theme, signIn: _signIn, ...rest } = client?.metadata ?? {};
    return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setErr(null);
    setSaved(false);
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
    const common = {
      client_name: name.trim(),
      metadata,
      disabled: client?.disabled ?? false,
      // An EDIT always names `logo_uri`, empty included: the PATCH reads `''` as "clear it"
      // and an absent key as "leave it alone", so omitting a field the operator just emptied
      // is how a logo becomes unremovable — the box goes blank, the save succeeds, and the
      // consent screen keeps the icon. Registration still omits it: the plugin's own
      // registration body is the one that validates the URI, and `''` is not one.
      ...(icon.trim() ? { logo_uri: icon.trim() } : client ? { logo_uri: '' } : {}),
    };
    if (machine) {
      if (!ceiling) return setErr('Scopes: still loading the issuer’s machine scopes — try again in a moment.');
      // A held scope that has left MACHINE_SCOPES is dropped rather than sent: the API refuses
      // any scope outside the list, and the token endpoint already stopped granting it.
      const kept = scopes.filter((s) => ceiling.machineScopes.includes(s));
      if (!kept.length) return setErr('Scopes: tick at least one — a machine client with none could never get a token.');
      return persist({ ...common, application_type: 'machine', client_credentials_scopes: kept });
    }
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
    if (draft.restrict) {
      // Guarded, not defaulted: `offered` is what turns the ticked boxes into a provider list,
      // and an absent one would write "no providers" — a policy nobody chose.
      if (!offered) {
        return setErr(
          offeredError
            ? `Sign-in: the issuer's providers could not be read (${offeredError}), so this policy cannot be saved without changing it.`
            : 'Sign-in: still loading the issuer’s providers — try again in a moment.',
        );
      }
      const problems = draftProblems(draft, offered, builtin);
      if (problems.length) return setErr(`Sign-in: ${problems[0]}`);
      metadata.signIn = draftToStored(draft, offered, builtin);
    }
    const clientDraft: ClientDraft = {
      ...common,
      application_type: type as ClientDraft['application_type'],
      redirect_uris: uris.split('\n').map((u) => u.trim()).filter(Boolean),
      skip_consent: skipConsent,
      enable_end_session: endSession,
      post_logout_redirect_uris: logoutUris.split('\n').map((u) => u.trim()).filter(Boolean),
    };
    return persist(clientDraft);
  };

  const persist = async (clientDraft: ClientDraft | MachineClientDraft) => {
    setBusy(true);
    try {
      if (builtin && client) {
        // The two keys the console's form owns. Naming the rest would not merely be noise:
        // its `redirect_uris` is empty and the PATCH schema refuses an empty list — rightly,
        // for every row that rule was written for.
        await updateOAuthClient(client.client_id, { client_name: clientDraft.client_name, metadata: clientDraft.metadata });
        await onSaved(null);
      } else if (client) {
        await updateOAuthClient(client.client_id, clientDraft);
        await onSaved(null);
      } else {
        const created = await createOAuthClient(clientDraft);
        await onSaved({ clientId: created.client.client_id, clientSecret: created.clientSecret });
      }
      // On the detail screen the form is the screen, so nothing closes to signal the save
      // happened. Said out loud instead — and only after the await, so it is a report rather
      // than a hope. Cleared by the next edit, below.
      if (client) setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor" onInput={() => setSaved(false)}>
      {!client && <h3>Register an application</h3>}
      {builtin && (
        <p className="muted small">
          This is this issuer&apos;s own admin console — the screen you signed in on. It is not a
          registered application: it has no redirect URIs and no secret, and the settings below
          decide how <em>this</em> sign-in screen looks and which methods it offers. Narrowing it
          only changes the buttons drawn: unlike a relying party&apos;s policy, nothing enforces
          this one at the authorize endpoint. If you lock yourself out, sign in at{' '}
          <code>/login?builtin=0</code> or disable this row to get the plain screen back.
        </p>
      )}
      <Field label="Name" value={name} onChange={setName} hint={builtin ? 'What this row is called on this screen.' : 'Shown on the consent screen — this is what people read.'} />
      {/* Everything below describes a redirect flow, and the console has none: no
          application type, no redirect URIs, no consent decision, no logout targets. Hidden
          rather than shown empty — an empty field invites someone to fill it in, and the
          PATCH would refuse the result. */}
      {!builtin && (
        <>
          <label className="field">
            <span>Application type</span>
            <select value={type} disabled={kinds.length === 1} onChange={(e) => setType(e.target.value as ApplicationType)}>
              {kinds.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <em className="hint">
              A <code>web</code> client keeps its secret on a server. A <code>native</code> one is public — PKCE, and
              loopback or private-scheme redirect URIs are allowed. A <code>machine</code> client is a service
              with no person signing in: it trades its own secret for a token (<code>client_credentials</code>).
              {client && ' Fixed once registered: register another application to change it.'}
            </em>
          </label>
          {machine && (
            <MachineScopes ceiling={ceiling} chosen={scopes} onChange={setScopes} />
          )}
          <Field
            label="Logo URL"
            value={icon}
            onChange={setIcon}
            hint={machine ? 'Optional. Shown beside the name in this console.' : 'Optional. Shown beside the name on the consent screen.'}
          />
        </>
      )}
      {!builtin && !machine && (
        <>
          <label className="field">
            <span>Redirect URIs</span>
            <textarea rows={3} value={uris} onChange={(e) => setUris(e.target.value)} />
            <em className="hint">One per line, matched exactly. A `web` client needs HTTPS unless it is on loopback.</em>
          </label>
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
                without it the issuer answers <em>&ldquo;The client is not allowed to initiate logout&rdquo;</em>.
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
        </>
      )}
      {!machine && (
        <>
          <SignInPolicyEditor draft={draft} onChange={setDraft} offered={offered} offeredError={offeredError} builtin={builtin} />
          <h3>Appearance</h3>
          <p className="muted small">
            {builtin
              ? 'How this console’s own sign-in screen looks. '
              : 'How the sign-in, sign-up and consent screens look when this application sends someone here. '}
            Colors are hex (<code>#0a6847</code>); blank means the issuer&apos;s default.
          </p>
          <Field label="Sign-in title" value={themeTitle} onChange={setThemeTitle} hint="Replaces “Substrat Auth” as the sign-in heading." />
          <Field label="Logo URL" value={themeLogo} onChange={setThemeLogo} hint="https:// or data:image/ — shown above the heading." />
          <Field label="Primary color" value={themePrimary} onChange={setThemePrimary} hint="Buttons and links." />
          <Field label="Primary text color" value={themePrimaryFg} onChange={setThemePrimaryFg} hint="Text on the primary color — keep the contrast readable." />
          <Field label="Background color" value={themeBackground} onChange={setThemeBackground} />
          <Field label="Card color" value={themePanel} onChange={setThemePanel} />
        </>
      )}
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
        <button className="btn primary" disabled={busy || (!machine && draft.restrict && !offered)} onClick={() => void save()}>
          {busy ? 'Saving…' : client ? 'Save changes' : 'Register'}
        </button>
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
        {saved && <span className="muted small">Saved.</span>}
      </div>
    </div>
  );
}

/**
 * The scopes a machine client may be granted, as boxes over the issuer's `MACHINE_SCOPES`
 * rather than free text: the list is the operator's ceiling, and a box can only offer what is
 * on it. A scope the client holds that has since left the list gets no box, but is named, so a
 * save that drops it is not a surprise — the token endpoint stopped granting it already.
 */
function MachineScopes({
  ceiling, chosen, onChange,
}: {
  ceiling: IssuerSettings | null;
  chosen: string[];
  onChange: (scopes: string[]) => void;
}) {
  if (!ceiling) return <p className="muted small">Loading this issuer&apos;s machine scopes…</p>;
  const offered = ceiling.machineScopes;
  if (!offered.length) {
    return (
      <p className="error">
        {ceiling.machineScopesError ??
          'This issuer grants no machine scopes: set MACHINE_SCOPES in its environment before registering a machine client.'}
      </p>
    );
  }
  const stale = chosen.filter((s) => !offered.includes(s));
  return (
    <fieldset className="field">
      <span>Scopes</span>
      {offered.map((scope) => (
        <label key={scope} className="toggle">
          <input
            type="checkbox"
            checked={chosen.includes(scope)}
            onChange={(e) => onChange(e.target.checked ? [...chosen, scope] : chosen.filter((s) => s !== scope))}
          />
          <span><code>{scope}</code></span>
        </label>
      ))}
      {stale.length > 0 && (
        <em className="hint">
          Also held, but no longer in MACHINE_SCOPES and so no longer granted: {stale.join(', ')}. Saving
          drops {stale.length === 1 ? 'it' : 'them'}.
        </em>
      )}
      <em className="hint">What this client may ask for. It gets all of them when it asks for none.</em>
    </fieldset>
  );
}
