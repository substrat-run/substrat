import { useEffect, useState, type ReactNode } from 'react';
import {
  APPLICATION_TYPES,
  issuerSettings,
  setupState,
  type ApplicationType,
  type ClientDraft,
  type IssuerSettings,
  type MachineClientDraft,
  type PublicProvider,
  type RegisteredClient,
} from '../../api';
import { Field } from '../../primitives';
import { SignInPolicyEditor } from '../SignInPolicyEditor';
import { draftFromStored, draftProblems, draftToStored, resolveAny, type PolicyDraft } from '../sign-in-draft';

/**
 * An application's form, in the three halves the detail screen's tabs save separately —
 * Settings (the core fields), Connections (`metadata.signIn`) and Branding (`metadata.theme`).
 * Registering a new application composes all three into one request, as the single form used
 * to; an existing one saves each half on its own tab.
 *
 * Each half is a hook returning its fields and a `build()` that turns them into what it owns,
 * or the first reason it cannot. A half never writes a key it does not own: `metadata` is ONE
 * column the PATCH replaces whole, so every save re-assembles it from the stored row with only
 * its own keys swapped (`withKey`, below).
 */

export type Built<T> = { ok: true; value: T } | { ok: false; error: string };

const lines = (text: string): string[] => text.split('\n').map((u) => u.trim()).filter(Boolean);

/** The stored metadata with one key replaced, or removed when `value` is undefined. */
export function withKey(stored: Record<string, unknown> | undefined, key: string, value: unknown): Record<string, unknown> {
  const { [key]: _old, ...rest } = stored ?? {};
  return value === undefined ? rest : { ...rest, [key]: value };
}

/* ---- Settings: the core fields ---- */

/** What the core half writes: plain columns, plus the metadata keys nobody else owns. */
export interface CoreValue {
  columns: Partial<ClientDraft> | Partial<MachineClientDraft>;
  /** The metadata JSON textarea — every key but `theme` and `signIn`. */
  extra: Record<string, unknown>;
  machine: boolean;
}

export function useCoreForm(client: RegisteredClient | null, onError: (message: string) => void) {
  /**
   * The issuer's own console (`src/console-client.ts`). Everything OAuth-shaped is absent
   * from this row on purpose — it holds no redirect URI, no secret and no consent decision,
   * because the console signs in over its own session and never redirects. So the fields
   * that describe a redirect flow are hidden rather than shown empty, and the save names only
   * the keys that mean something here.
   */
  const builtin = Boolean(client?.builtin);
  const [name, setName] = useState(client?.client_name ?? '');
  const [type, setType] = useState<ApplicationType>((client?.application_type as ApplicationType | undefined) ?? 'web');
  const [icon, setIcon] = useState(client?.logo_uri ?? '');
  const [uris, setUris] = useState((client?.redirect_uris ?? []).join('\n'));
  const [skipConsent, setSkipConsent] = useState(Boolean(client?.skip_consent));
  const [endSession, setEndSession] = useState(Boolean(client?.enable_end_session));
  const [logoutUris, setLogoutUris] = useState((client?.post_logout_redirect_uris ?? []).join('\n'));
  /**
   * A machine client: no sign-in, so none of the redirect, consent, logout, sign-in-policy or
   * appearance fields apply to it — they are hidden, and never sent. A client's kind is fixed
   * once it is registered (the API refuses the move either way), so an existing client is only
   * offered the kinds on its own side of that line.
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
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  }, [machine, ceiling, onError]);
  const [meta, setMeta] = useState(() => {
    const { theme: _theme, signIn: _signIn, ...rest } = client?.metadata ?? {};
    return Object.keys(rest).length ? JSON.stringify(rest, null, 2) : '';
  });

  const build = (): Built<CoreValue> => {
    let extra: Record<string, unknown> = {};
    if (meta.trim()) {
      try {
        const value: unknown = JSON.parse(meta);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('must be a JSON object');
        extra = value as Record<string, unknown>;
      } catch (e) {
        return { ok: false, error: `Metadata: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    // The textarea does not own `theme` or `signIn` (its hint says so) — a raw one pasted
    // there must not survive past the tabs that do.
    delete extra.theme;
    delete extra.signIn;
    // The console's row: the two keys its form owns. Naming the rest would not merely be noise:
    // its `redirect_uris` is empty and the PATCH schema refuses an empty list — rightly, for
    // every row that rule was written for.
    if (builtin) return { ok: true, value: { columns: { client_name: name.trim() }, extra, machine: false } };
    const common = {
      client_name: name.trim(),
      // An EDIT always names `logo_uri`, empty included: the PATCH reads `''` as "clear it"
      // and an absent key as "leave it alone", so omitting a field the operator just emptied
      // is how a logo becomes unremovable — the box goes blank, the save succeeds, and the
      // consent screen keeps the icon. Registration still omits it: the plugin's own
      // registration body is the one that validates the URI, and `''` is not one.
      ...(icon.trim() ? { logo_uri: icon.trim() } : client ? { logo_uri: '' } : {}),
    };
    if (machine) {
      if (!ceiling) return { ok: false, error: 'Scopes: still loading the issuer’s machine scopes — try again in a moment.' };
      // A held scope that has left MACHINE_SCOPES is dropped rather than sent: the API refuses
      // any scope outside the list, and the token endpoint already stopped granting it.
      const kept = scopes.filter((s) => ceiling.machineScopes.includes(s));
      if (!kept.length) return { ok: false, error: 'Scopes: tick at least one — a machine client with none could never get a token.' };
      return {
        ok: true,
        value: { columns: { ...common, application_type: 'machine' as const, client_credentials_scopes: kept }, extra, machine: true },
      };
    }
    return {
      ok: true,
      value: {
        columns: {
          ...common,
          application_type: type as ClientDraft['application_type'],
          redirect_uris: lines(uris),
          skip_consent: skipConsent,
          enable_end_session: endSession,
          post_logout_redirect_uris: lines(logoutUris),
        },
        extra,
        machine: false,
      },
    };
  };

  const view: ReactNode = (
    <>
      {builtin && (
        <p className="muted small">
          This is this issuer&apos;s own admin console — the screen you signed in on. It is not a
          registered application: it has no redirect URIs and no secret, and its Connections and
          Branding tabs decide how <em>this</em> sign-in screen looks and which methods it offers.
          Narrowing it only changes the buttons drawn: unlike a relying party&apos;s policy, nothing
          enforces this one at the authorize endpoint. If you lock yourself out, sign in at{' '}
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
          {machine && <MachineScopes ceiling={ceiling} chosen={scopes} onChange={setScopes} />}
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
      <label className="field">
        <span>Metadata (JSON)</span>
        <textarea rows={4} value={meta} onChange={(e) => setMeta(e.target.value)} placeholder={'{\n  "plan": "internal"\n}'} />
        <em className="hint">
          Stored as-is on the client. The <code>theme</code> and <code>signIn</code> keys are owned by the
          Branding and Connections {client ? 'tabs' : 'sections'} (further theme keys: <code>colorInput</code>,{' '}
          <code>colorText</code>, <code>colorMutedText</code>, <code>borderRadius</code> — settable via the API);
          everything else the issuer never reads.
        </em>
      </label>
    </>
  );

  return { view, build, machine };
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

/* ---- Connections: the sign-in policy ---- */

/**
 * The stored sign-in policy (`metadata.signIn` — `src/sign-in-policy.ts`). Absent is the
 * default and means every method the issuer offers; present means exactly the ones ticked.
 *
 * The choices come from `setupState()`, the same public read the login screen uses, so this
 * form can only offer providers that actually exist — a policy naming one that does not is a
 * client nobody can sign into, and it should not be possible to write it here.
 */
export function useSignInForm(client: RegisteredClient | null) {
  const builtin = Boolean(client?.builtin);
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFromStored(client?.metadata?.signIn));
  /**
   * The issuer's live providers — `null` until the read below answers, and that distinction is
   * load-bearing rather than tidy. `build` writes the policy as `offered ∩ methods`, so an
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

  /** The `signIn` value to store, or `undefined` for "no key at all". */
  const build = (): Built<unknown> => {
    // Unrestricted writes NO key at all rather than a permissive one: absent is the documented
    // default, and a stored `{providers: [...everything], password: true}` would silently stop
    // following the issuer as providers are added.
    if (!draft.restrict) return { ok: true, value: undefined };
    // Guarded, not defaulted: `offered` is what turns the ticked boxes into a provider list,
    // and an absent one would write "no providers" — a policy nobody chose.
    if (!offered) {
      return {
        ok: false,
        error: offeredError
          ? `Sign-in: the issuer's providers could not be read (${offeredError}), so this policy cannot be saved without changing it.`
          : 'Sign-in: still loading the issuer’s providers — try again in a moment.',
      };
    }
    const problems = draftProblems(draft, offered, builtin);
    if (problems.length) return { ok: false, error: `Sign-in: ${problems[0]}` };
    return { ok: true, value: draftToStored(draft, offered, builtin) };
  };

  const view: ReactNode = (
    <SignInPolicyEditor draft={draft} onChange={setDraft} offered={offered} offeredError={offeredError} builtin={builtin} />
  );
  /** Saving a restricted policy waits for the provider read (see `offered`). */
  const blocked = draft.restrict && !offered;
  return { view, build, blocked };
}

/* ---- Branding: the per-client theme ---- */

/**
 * The stored theme (`metadata.theme` — the vocabulary src/branding.ts sanitizes). The common
 * keys get a field each; theme keys without one (colorInput, colorText, …) are carried through
 * a save untouched, read from the row as it is when the save happens.
 */
const THEME_FIELDS = ['title', 'logoUrl', 'colorPrimary', 'colorPrimaryForeground', 'colorBackground', 'colorPanel'] as const;
type ThemeField = (typeof THEME_FIELDS)[number];

const themeOf = (client: RegisteredClient | null): Record<string, unknown> =>
  (client?.metadata?.theme ?? {}) as Record<string, unknown>;

export function useThemeForm(client: RegisteredClient | null) {
  const builtin = Boolean(client?.builtin);
  const [values, setValues] = useState<Record<ThemeField, string>>(() => {
    const stored = themeOf(client);
    return Object.fromEntries(
      THEME_FIELDS.map((key) => [key, typeof stored[key] === 'string' ? (stored[key] as string) : '']),
    ) as Record<ThemeField, string>;
  });
  const field = (key: ThemeField) => ({ value: values[key], onChange: (v: string) => setValues((cur) => ({ ...cur, [key]: v })) });

  /** The `theme` value to store, or `undefined` for "no key" (the issuer's default look). */
  const build = (stored: RegisteredClient | null): unknown => {
    // Reassemble the theme: the untouched extra keys, then the fields (empty = remove).
    const theme: Record<string, unknown> = Object.fromEntries(
      Object.entries(themeOf(stored)).filter(([key]) => !(THEME_FIELDS as readonly string[]).includes(key)),
    );
    for (const key of THEME_FIELDS) if (values[key].trim()) theme[key] = values[key].trim();
    return Object.keys(theme).length ? theme : undefined;
  };

  const view: ReactNode = (
    <>
      <h3>Appearance</h3>
      <p className="muted small">
        {builtin
          ? 'How this console’s own sign-in screen looks. '
          : 'How the sign-in, sign-up and consent screens look when this application sends someone here. '}
        Colors are hex (<code>#0a6847</code>); blank means the issuer&apos;s default.
      </p>
      <Field label="Sign-in title" {...field('title')} hint="Replaces “Substrat Auth” as the sign-in heading." />
      <Field label="Logo URL" {...field('logoUrl')} hint="https:// or data:image/ — shown above the heading." />
      <Field label="Primary color" {...field('colorPrimary')} hint="Buttons and links." />
      <Field label="Primary text color" {...field('colorPrimaryForeground')} hint="Text on the primary color — keep the contrast readable." />
      <Field label="Background color" {...field('colorBackground')} />
      <Field label="Card color" {...field('colorPanel')} />
    </>
  );
  return { view, build };
}
