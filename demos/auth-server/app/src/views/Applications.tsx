import { useCallback, useEffect, useState } from 'react';
import { Button, PageHeader } from '@substrat-run/ui';
import { createOAuthClient, listOAuthClients, type ClientDraft, type MachineClientDraft, type RegisteredClient } from '../api';
import { navigate } from '../console/router';
import { applicationPath } from '../console/routes';
import { SecretOnce } from './applications/SecretOnce';
import { useCoreForm, useSignInForm, useThemeForm, withKey } from './applications/client-forms';

/* ---- the relying-party registry ---- */

/**
 * The applications this issuer will answer for. Better Auth registers clients (dynamically,
 * or from `trustedClients` in code) but offers no way to see or change them afterwards — so
 * before this screen, the only record of a registered app was a row in the platform's
 * read-only Data tab.
 *
 * A list, and only a list: every setting an application has is a screen of its own at
 * `/applications/<client id>`, which is a place a link can point at. The one thing edited here
 * is a client that does not exist yet — it has no id, so there is no URL for it to be at, and
 * it stays here afterwards too: registering mints the one secret nobody can read a second
 * time, and that is not a thing to put behind a navigation.
 */
export function ClientsPanel() {
  const [clients, setClients] = useState<RegisteredClient[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
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

  return (
    <>
      <PageHeader
        title="Applications"
        description="The relying parties this issuer signs people in for, and the services that fetch tokens of their own."
        actions={!registering && <Button onClick={() => setRegistering(true)}>Create application</Button>}
      />
      {err && <p className="error">{err}</p>}
      {/* Shown here rather than on the new client's own screen: it is the one value that
          cannot be read again, so it must not depend on a navigation completing. */}
      {secret && <SecretOnce {...secret} onDismiss={() => setSecret(null)} />}
      {registering && (
        <section className="panel">
          <CreateApplication
            onCancel={() => setRegistering(false)}
            onCreated={async (result) => {
              setRegistering(false);
              setSecret(result);
              await reload();
            }}
          />
        </section>
      )}
      <section className="panel">
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
              <tr><th>Name</th><th>Type</th><th>Client ID</th><th>Callback URLs</th><th>Status</th></tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.client_id}>
                  <td>
                    {/* A real anchor, not a click handler on a cell: the row's whole point is
                        that it is a place, so it has to be copyable, middle-clickable and
                        openable in a tab. The plain click stays same-document. */}
                    <a
                      href={applicationPath(client.client_id)}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        navigate(applicationPath(client.client_id));
                      }}
                    >
                      {client.client_name ?? 'Unnamed application'}
                    </a>
                    {!client.builtin && client.skip_consent && <span className="tag">no consent screen</span>}
                    {!client.builtin && client.enable_end_session && <span className="tag">can sign out</span>}
                    {!client.builtin && !client.user_id && <span className="tag">self-registered</span>}
                  </td>
                  <td>
                    {client.builtin ? <span className="tag">this issuer</span> : <span className="tag">{client.application_type ?? 'web'}</span>}
                  </td>
                  <td><code className="client-id">{client.client_id}</code></td>
                  <td className="uris">
                    {client.builtin ? (
                      <span className="muted">the admin console — signs in here, never redirects</span>
                    ) : client.application_type === 'machine' ? (
                      <span className="muted">none — a service, nobody is sent back to it</span>
                    ) : (
                      client.redirect_uris.map((uri) => <div key={uri}><code>{uri}</code></div>)
                    )}
                  </td>
                  <td>
                    {client.disabled ? <span className="tag warn">disabled</span> : 'active'}
                    {!client.builtin && !client.client_secret_set && <span className="tag">public</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          Each application connects with its own client ID, so the login and consent screens can
          tell them apart — the name and icon there are what a person sees when that application
          asks them to sign in. Open one to edit it, rotate its secret, disable it or remove it.
          <code>console</code> is this issuer&apos;s own admin screen rather than a registered
          application; open it to theme or narrow the sign-in you are looking at.
        </p>
      </section>
    </>
  );
}

/**
 * Registering an application: the three halves an existing one keeps on separate tabs
 * (Settings, Connections, Branding), in one form and one request — a client that does not
 * exist yet has no tabs to spread them over.
 */
function CreateApplication({
  onCancel, onCreated,
}: {
  onCancel: () => void;
  onCreated: (secret: { clientId: string; clientSecret: string }) => void | Promise<void>;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const core = useCoreForm(null, setErr);
  const signIn = useSignInForm(null);
  const theme = useThemeForm(null);

  const register = async () => {
    setErr(null);
    const built = core.build();
    if (!built.ok) return setErr(built.error);
    let metadata = built.value.extra;
    if (!built.value.machine) {
      const policy = signIn.build();
      if (!policy.ok) return setErr(policy.error);
      metadata = withKey(withKey(metadata, 'theme', theme.build(null)), 'signIn', policy.value);
    }
    setBusy(true);
    try {
      const created = await createOAuthClient({
        ...built.value.columns,
        metadata,
        disabled: false,
      } as ClientDraft | MachineClientDraft);
      await onCreated({ clientId: created.client.client_id, clientSecret: created.clientSecret });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <h3>Register an application</h3>
      {core.view}
      {/* A machine client has no sign-in, so neither half below applies: hidden, and never sent. */}
      {!core.machine && (
        <>
          {signIn.view}
          {theme.view}
        </>
      )}
      {err && <p className="error">{err}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy || (!core.machine && signIn.blocked)} onClick={() => void register()}>
          {busy ? 'Saving…' : 'Register'}
        </button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
