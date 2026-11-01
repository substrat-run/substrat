import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, GridTable, PageHeader, Row } from '@substrat-run/ui';
import {
  bankidSettings,
  identityProviders,
  issuerSettings,
  listOAuthClients,
  type BankIdSettings,
  type ConfiguredProvider,
  type IssuerSettings,
  type ProviderCatalogueEntry,
  type RegisteredClient,
} from '../api';
import { navigate } from '../console/router';
import { connectionPath } from '../console/routes';
import { ConnectionLink } from './connections/ConnectionLink';
import { connectionStatus, connectionsFrom, enabledFor, signsIn, type Connection } from './connections/model';
import { ProviderEditor } from './connections/ProviderSettings';

const COLUMNS = 'minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1.6fr) 110px';

/**
 * Every source of identities this issuer has, in one list: the password database, each
 * configured upstream provider, and BankID. Three stores that grew apart as three screens; one
 * idea — "a source of identities that applications are enabled for" — and Auth0's name for it.
 *
 * The provider catalogue is closed on purpose (`src/providers.ts`): each entry is a provider
 * Better Auth ships endpoints and a profile mapping for, so enabling one is a credential and two
 * decisions rather than a form full of URLs to get subtly wrong.
 *
 * A list, and almost only a list: every connection with an id — configured or merely offered by
 * the catalogue — is a screen of its own at `/connections/<id>`. The one editor still here is
 * the custom OIDC upstream nobody has named yet: its id is the first field of the form, so until
 * it is saved there is no URL for it to be at.
 */
export function ConnectionsView({ issuer }: { issuer: string | null }) {
  const [catalogue, setCatalogue] = useState<ProviderCatalogueEntry[] | null>(null);
  const [providers, setProviders] = useState<ConfiguredProvider[]>([]);
  const [providersErr, setProvidersErr] = useState<string | null>(null);
  // `undefined` while loading, `null` when BankID is not configured — two different answers.
  const [bankid, setBankid] = useState<BankIdSettings | null>();
  const [bankidErr, setBankidErr] = useState<string | null>(null);
  const [settings, setSettings] = useState<IssuerSettings | null>(null);
  const [clients, setClients] = useState<RegisteredClient[] | null>(null);
  const [clientsErr, setClientsErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [addingCustom, setAddingCustom] = useState(false);

  const fail = (set: (m: string) => void) => (e: unknown) => set(e instanceof Error ? e.message : String(e));

  const reload = useCallback(async () => {
    setProvidersErr(null);
    try {
      const state = await identityProviders();
      setCatalogue(state.catalogue);
      setProviders(state.providers);
    } catch (e) {
      setProvidersErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    void bankidSettings().then(setBankid).catch(fail(setBankidErr));
    // Only the sign-up flag is read from this, and a failure is not worth a sentence: the row
    // says less, nothing is wrong.
    void issuerSettings().then(setSettings).catch(() => undefined);
    void listOAuthClients()
      .then((all) => setClients(all.filter(signsIn)))
      .catch(fail(setClientsErr));
  }, [reload]);

  const connections = connectionsFrom(catalogue ?? [], providers, bankid ?? null);
  const unconfigured = (catalogue ?? []).filter((entry) => !providers.some((p) => p.id === entry.id));
  const origin = (issuer ?? window.location.origin).replace(/\/$/, '');

  return (
    <>
      <PageHeader
        title="Connections"
        description="Sources of identities — passwords, upstream providers, BankID. Each application is enabled for the ones its users may sign in with."
        actions={
          <Button onClick={() => setCreating((open) => !open)} variant={creating ? 'secondary' : 'primary'}>
            {creating ? 'Close' : 'Create connection'}
          </Button>
        }
      />

      {creating && (
        <section className="panel">
          <div className="panel-head"><h2>Create connection</h2></div>
          <p className="muted">
            Enabling one adds a “Continue with …” button to the login screen — including for
            people a relying party sent here. BankID uses a certificate for Swedish e-ID sign-in.
            “Custom (OIDC)” takes any standards-compliant issuer by URL — Keycloak, Okta, Auth0,
            or another auth server like this one.
          </p>
          {!addingCustom && (
            <div className="add-provider">
              {/* A catalogue entry already HAS its id, so enabling it is the same screen as
                  editing it — and therefore a link rather than a button that unfolds a form. */}
              {unconfigured.map((entry) => (
                <ConnectionLink key={entry.id} id={entry.id} className="btn">
                  + {entry.label}
                </ConnectionLink>
              ))}
              {bankid === null && <ConnectionLink id="bankid" className="btn">+ BankID</ConnectionLink>}
              {catalogue && <button className="btn" onClick={() => setAddingCustom(true)}>+ Custom (OIDC)</button>}
              {!catalogue && !providersErr && <span className="muted">Loading the catalogue…</span>}
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
                setCreating(false);
                // Straight to the screen the new connection now has: it has an id, so from here
                // on it is edited where a link can point, like every other row.
                navigate(connectionPath(id));
              }}
            />
          )}
        </section>
      )}

      {providersErr && <p className="error">{providersErr}</p>}
      {bankidErr && <p className="error">Could not load BankID: {bankidErr}</p>}
      {clientsErr && <p className="error">Could not load applications: {clientsErr}</p>}

      <GridTable columns={COLUMNS} header={['Name', 'Strategy', 'Status', '~Applications']}>
        {connections.map((conn, i) => (
          <ConnectionRow
            key={conn.id}
            conn={conn}
            signups={conn.kind === 'database' ? (settings?.allowSignup ?? null) : null}
            enabled={clients ? clients.filter((c) => enabledFor(c, conn.id)).length : null}
            last={i === connections.length - 1 && catalogue !== null && (bankid !== undefined || bankidErr !== null)}
          />
        ))}
        {(!catalogue || (bankid === undefined && !bankidErr)) && !providersErr && (
          <Row columns={COLUMNS} last>
            <span className="muted">Loading connections…</span>
          </Row>
        )}
      </GridTable>

      {/* The one fact an operator needs before they can enable an upstream at all, and the one
          every upstream refuses on if it differs by a trailing slash. Each connection's own
          screen prints it in full for that id. */}
      <p className="muted small">
        Upstream providers redirect back to <code>{origin}/api/auth/callback/&lt;connection id&gt;</code>.
        Open a connection to change its credentials, see which applications use it, disable it or
        remove it. Removing one leaves the people who signed in with it needing another way in.
      </p>
    </>
  );
}

function ConnectionRow({
  conn, signups, enabled, last,
}: { conn: Connection; signups: boolean | null; enabled: number | null; last: boolean }) {
  const status = connectionStatus(conn);
  const provider = conn.kind === 'provider' ? conn.provider : null;
  return (
    <Row columns={COLUMNS} last={last}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <ConnectionLink id={conn.id} style={{ fontWeight: 500 }}>{conn.name}</ConnectionLink>
        {provider?.platform && <span className="tag">provided by Substrat</span>}
        {signups === false && <span className="tag">sign-ups off</span>}
      </span>
      <code style={{ color: 'var(--text-secondary)', fontSize: 12.5 }}>{conn.strategy}</code>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={status.label}>
        <Badge status={status.tone}>{status.label}</Badge>
      </span>
      <span style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>{enabled ?? '—'}</span>
    </Row>
  );
}
