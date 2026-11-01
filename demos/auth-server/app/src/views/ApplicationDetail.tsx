import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Badge, Button, DetailHeader, EmptyState, LinkTabs, SubIcon, SubIcons } from '@substrat-run/ui';
import {
  deleteOAuthClient,
  listOAuthClients,
  rotateOAuthClientSecret,
  updateOAuthClient,
  type RegisteredClient,
} from '../api';
import { navigate } from '../console/router';
import { APPLICATIONS_PATH, APPLICATION_TABS, applicationPath, type ApplicationTab } from '../console/routes';
import { LogTable } from './Logs';
import { RawJson } from './RawJson';
import { CopyId } from './applications/CopyId';
import { SecretOnce } from './applications/SecretOnce';
import { useCoreForm, useSignInForm, useThemeForm, withKey } from './applications/client-forms';

const TAB_LABELS: Record<ApplicationTab, string> = {
  settings: 'Settings',
  connections: 'Connections',
  branding: 'Branding',
  logs: 'Logs',
  raw: 'Raw',
};

/** The tabs that hold a form, and so can hold an edit that has not been saved yet. */
type FormTab = 'settings' | 'connections' | 'branding';

/**
 * `/applications/:clientId[/<tab>]` — one relying party. Everything an application is used to
 * be edited in a form that unfolded UNDER the table, with no URL of its own; then in one long
 * form on this screen. Now it is Auth0's shape: a header naming the record and holding the
 * levers that act on all of it, over tabs that are places (spec/console-redesign.md §3).
 *
 * The read is the same list the table uses — there is no per-client GET on the admin API and
 * this screen deliberately does not add one: an issuer's registry is a handful of rows, and a
 * second server surface for a `find` is a surface to authorize, test and keep in step for no
 * new fact. It is read ONCE per record: the view is keyed by client id at its call site and the
 * tab is a prop, so moving between tabs re-reads nothing.
 *
 * Each form tab saves only its own fields, and the three form tabs stay mounted while another is
 * shown. Together that is what keeps a tab switch from either dropping a half-edited form (it is
 * still there when you come back, and its tab says so) or submitting one (no save names another
 * tab's fields — `metadata` is re-assembled from the stored row with only the saving tab's keys
 * swapped).
 *
 * The nav is not the gate here — every call below is refused server-side by session + the
 * `admin` role, and this component simply is not rendered for anyone else.
 */
export function ApplicationDetailView({ clientId, tab }: { clientId: string; tab: ApplicationTab }) {
  const [client, setClient] = useState<RegisteredClient | null | 'missing'>(null);
  const [err, setErr] = useState<string | null>(null);
  /** A freshly minted secret, held until dismissed — the only moment it is knowable. */
  const [secret, setSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [dirty, setDirty] = useState<ReadonlySet<FormTab>>(new Set());
  const markDirty = useCallback((t: FormTab, on: boolean) => {
    setDirty((cur) => {
      if (cur.has(t) === on) return cur;
      const next = new Set(cur);
      if (on) next.add(t);
      else next.delete(t);
      return next;
    });
  }, []);

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
      {err && <p className="error">{err}</p>}
      {/* A failed read is an error state, not a pending one. Saying "Loading…" underneath the
          error would tell an operator to keep waiting for a request that already came back. */}
      {client === null ? (
        !err && <p className="muted">Loading this application…</p>
      ) : (
        <>
          <ApplicationHeader client={client} onSecret={setSecret} onChanged={reload} />
          {/* Above the tabs rather than on one: a rotated secret is the one value that cannot be
              read again, so it must not disappear behind a tab switch. */}
          {secret && <SecretOnce {...secret} onDismiss={() => setSecret(null)} />}
          <LinkTabs
            label="Application"
            value={tab}
            onNavigate={navigate}
            tabs={APPLICATION_TABS.map((t) => ({
              value: t,
              // Said in the label because the form behind it is kept, not dropped: an edit left
              // on another tab is otherwise invisible until somebody goes back for it.
              label: dirty.has(t as FormTab) ? `${TAB_LABELS[t]} (unsaved)` : TAB_LABELS[t],
              href: applicationPath(clientId, t),
            }))}
          />
          <div hidden={tab !== 'settings'}>
            <SettingsTab client={client} onSaved={reload} onDirty={(on) => markDirty('settings', on)} />
          </div>
          <div hidden={tab !== 'connections'}>
            {client.application_type === 'machine' ? (
              <MachineNote>
                A machine application has no person signing in, so there are no sign-in methods to choose.
              </MachineNote>
            ) : (
              <ConnectionsTab client={client} onSaved={reload} onDirty={(on) => markDirty('connections', on)} />
            )}
          </div>
          <div hidden={tab !== 'branding'}>
            {client.application_type === 'machine' ? (
              <MachineNote>
                A machine application never sends anyone to a sign-in screen, so it has nothing to brand.
              </MachineNote>
            ) : (
              <BrandingTab client={client} onSaved={reload} onDirty={(on) => markDirty('branding', on)} />
            )}
          </div>
          {tab === 'logs' && <LogTable clientId={clientId} />}
          {tab === 'raw' && <RawJson value={client} />}
        </>
      )}
    </>
  );
}

function MachineNote({ children }: { children: ReactNode }) {
  return (
    <section className="panel">
      <p className="muted" style={{ margin: 0 }}>{children}</p>
    </section>
  );
}

/* ---- what this application is, and the levers that act on all of it ---- */

function ApplicationHeader({
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
    <>
      <DetailHeader
        icon={<SubIcon d={SubIcons.layers} size={20} />}
        title={client.client_name ?? 'Unnamed application'}
        meta={
          <>
            {client.builtin ? <span className="tag">this issuer</span> : <span className="tag">{client.application_type ?? 'web'}</span>}
            {/* Copyable because it is the string the application itself is configured with, and
                matching "our login stopped working" to a row here starts with it. */}
            <CopyId value={client.client_id} label="client id" />
            {client.disabled ? <Badge status="warning">disabled</Badge> : <Badge status="success">active</Badge>}
            {!client.builtin && !client.client_secret_set && <span className="tag">public</span>}
            {!client.builtin && client.skip_consent && <span className="tag">no consent screen</span>}
            {!client.builtin && client.enable_end_session && <span className="tag">can sign out</span>}
            {!client.builtin && !client.user_id && <span className="tag">self-registered</span>}
            {/* `client_id_issued_at` is RFC 7591's seconds-since-epoch, not milliseconds — the
                two are a factor of a thousand apart and one of them renders as 1970. */}
            {client.client_id_issued_at ? <span>registered {new Date(client.client_id_issued_at * 1000).toLocaleString()}</span> : null}
          </>
        }
        actions={
          <>
            {client.client_secret_set && (
              <Button
                variant="secondary"
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
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await updateOAuthClient(client.client_id, { disabled: !client.disabled });
                })
              }
            >
              {client.disabled ? 'Enable' : 'Disable'}
            </Button>
            {/* The console's row is this issuer's own and the API refuses to delete it (a blank one
                would be seeded back on the next boot, minus the theme and policy an operator put on
                it). Disable, beside this, is the reversible verb that means what a delete here
                would be reaching for. */}
            {!client.builtin && (
              <Button
                variant="danger"
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
              </Button>
            )}
          </>
        }
      />
      {err && <p className="error">{err}</p>}
    </>
  );
}

/* ---- the form tabs ---- */

interface TabProps {
  client: RegisteredClient;
  onSaved: () => Promise<void>;
  onDirty: (dirty: boolean) => void;
}

/**
 * One form tab's frame: its fields, its error, and a save that reports itself. On a detail
 * screen the form is the screen, so nothing closes to signal the save happened — "Saved." says
 * so instead, only after the await, so it is a report rather than a hope. Any edit clears it.
 */
function FormTab({
  children, onSave, blocked, onDirty, err, setErr,
}: {
  children: ReactNode;
  onSave: () => Promise<boolean>;
  blocked?: boolean;
  onDirty: (dirty: boolean) => void;
  err: string | null;
  setErr: (err: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <section className="panel">
      <div
        className="editor"
        onInput={() => {
          setSaved(false);
          onDirty(true);
        }}
      >
        {children}
        {err && <p className="error">{err}</p>}
        <div className="row">
          <button
            className="btn primary"
            disabled={busy || blocked}
            onClick={async () => {
              setErr(null);
              setSaved(false);
              setBusy(true);
              try {
                if (await onSave()) {
                  setSaved(true);
                  onDirty(false);
                }
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          {saved && <span className="muted small">Saved.</span>}
        </div>
      </div>
    </section>
  );
}

/**
 * Settings: the core fields and the free-form metadata. Writes those columns, and `metadata`
 * with `theme` and `signIn` carried over from the stored row as they are — those two keys are
 * the Branding and Connections tabs' to change.
 *
 * Redirect URIs are one per line and must match the application's callback EXACTLY — the
 * issuer compares them as strings, so a trailing slash is a different URI.
 */
function SettingsTab({ client, onSaved, onDirty }: TabProps) {
  const [err, setErr] = useState<string | null>(null);
  const core = useCoreForm(client, setErr);
  return (
    <FormTab
      err={err}
      setErr={setErr}
      onDirty={onDirty}
      onSave={async () => {
        const built = core.build();
        if (!built.ok) {
          setErr(built.error);
          return false;
        }
        let metadata = withKey(built.value.extra, 'theme', client.metadata?.theme);
        metadata = withKey(metadata, 'signIn', client.metadata?.signIn);
        await updateOAuthClient(client.client_id, { ...built.value.columns, metadata });
        await onSaved();
        return true;
      }}
    >
      {core.view}
    </FormTab>
  );
}

/**
 * Connections: which sign-in methods this application offers (`metadata.signIn`). Writes only
 * `metadata`, with every other key as stored. The server still has the last word — the
 * console's row is held to "leaves a way in HERE" on every metadata write.
 */
function ConnectionsTab({ client, onSaved, onDirty }: TabProps) {
  const [err, setErr] = useState<string | null>(null);
  const signIn = useSignInForm(client);
  return (
    <FormTab
      err={err}
      setErr={setErr}
      onDirty={onDirty}
      blocked={signIn.blocked}
      onSave={async () => {
        const built = signIn.build();
        if (!built.ok) {
          setErr(built.error);
          return false;
        }
        await updateOAuthClient(client.client_id, { metadata: withKey(client.metadata, 'signIn', built.value) });
        await onSaved();
        return true;
      }}
    >
      {signIn.view}
    </FormTab>
  );
}

/** Branding: the per-client theme (`metadata.theme`). Writes only `metadata`, every other key as stored. */
function BrandingTab({ client, onSaved, onDirty }: TabProps) {
  const [err, setErr] = useState<string | null>(null);
  const theme = useThemeForm(client);
  return (
    <FormTab
      err={err}
      setErr={setErr}
      onDirty={onDirty}
      onSave={async () => {
        await updateOAuthClient(client.client_id, { metadata: withKey(client.metadata, 'theme', theme.build(client)) });
        await onSaved();
        return true;
      }}
    >
      {theme.view}
    </FormTab>
  );
}
