import { useCallback, useEffect, useState } from 'react';
import { Badge, DetailHeader, EmptyState, LinkTabs } from '@substrat-run/ui';
import {
  bankidSettings,
  identityProviders,
  issuerSettings,
  listOAuthClients,
  setupState,
  type BankIdSettings,
  type ConfiguredProvider,
  type IssuerSettings,
  type ProviderCatalogueEntry,
  type PublicProvider,
  type RegisteredClient,
} from '../api';
import { navigate } from '../console/router';
import { CONNECTIONS_PATH, CONNECTION_TABS, connectionPath, type ConnectionTab } from '../console/routes';
import { BankIdSettingsTab } from './connections/BankIdSettings';
import { ConnectionApplications } from './connections/ConnectionApplications';
import { DatabaseSettings } from './connections/DatabaseSettings';
import {
  BANKID_ID,
  DATABASE_ID,
  connectionStatus,
  enabledFor,
  providerConnection,
  signsIn,
  type Connection,
} from './connections/model';
import { ProviderSettings } from './connections/ProviderSettings';
import { RawJson } from './RawJson';

const TAB_LABEL: Record<ConnectionTab, string> = { settings: 'Settings', applications: 'Applications', raw: 'Raw' };

/** What this id turned out to be, once read. BankID's `null` is "not configured yet". */
type ConnectionRead =
  | { kind: 'database'; settings: IssuerSettings }
  | { kind: 'bankid'; settings: BankIdSettings | null }
  | { kind: 'provider'; entry: ProviderCatalogueEntry | null; provider: ConfiguredProvider | null }
  | { kind: 'missing' };

/**
 * `/connections/<id>[/<tab>]` — one source of identities, whichever store holds it: the password
 * database (`password`), BankID (`bankid`), or an upstream provider (a catalogue slug or the id
 * an operator gave a generic OIDC upstream).
 *
 * `password` and `bankid` are always places — the database always exists, and BankID's screen
 * is where it is enabled. A catalogue id is a place too, configured or not: `/connections/google`
 * is the screen that enables Google and then edits it. Only an id that is none of those is "no
 * such connection", which is what a link to a since-removed custom upstream becomes.
 *
 * The provider read is the list read: `/api/admin/providers` returns the catalogue and the
 * configured rows together, and a per-provider GET would be a second surface to authorize and
 * keep in step for no new fact.
 *
 * The nav is not the gate — every call below is refused server-side by session + the `admin`
 * role, and this component simply is not rendered for anyone else.
 */
export function ConnectionDetailView({ id, tab, issuer }: { id: string; tab: ConnectionTab; issuer: string | null }) {
  const [read, setRead] = useState<ConnectionRead | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [clients, setClients] = useState<RegisteredClient[] | null>(null);
  const [clientsErr, setClientsErr] = useState<string | null>(null);
  const [offered, setOffered] = useState<PublicProvider[] | null>(null);
  const [offeredErr, setOfferedErr] = useState<string | null>(null);

  const readOffered = useCallback(async () => {
    try {
      setOffered((await setupState()).providers);
      setOfferedErr(null);
    } catch (e) {
      setOfferedErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      if (id === DATABASE_ID) {
        setRead({ kind: 'database', settings: await issuerSettings() });
      } else if (id === BANKID_ID) {
        setRead({ kind: 'bankid', settings: await bankidSettings() });
      } else {
        const state = await identityProviders();
        const entry = state.catalogue.find((e) => e.id === id) ?? null;
        const provider = state.providers.find((p) => p.id === id) ?? null;
        // Neither half knows this id: not a provider this issuer ships an editor for, and not
        // one an operator configured. There is nothing to show and nothing to enable.
        setRead(entry || provider ? { kind: 'provider', entry, provider } : { kind: 'missing' });
      }
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    // Enabling, disabling or removing a connection changes what the login screen offers, which
    // is what the Applications tab's notes — and any explicit list it writes — are made of.
    await readOffered();
  }, [id, readOffered]);

  useEffect(() => {
    void reload();
    void listOAuthClients()
      .then((all) => setClients(all.filter(signsIn)))
      .catch((e: unknown) => setClientsErr(e instanceof Error ? e.message : String(e)));
  }, [reload]);

  // A pasted link to a custom upstream that has since been removed. It is a real outcome — the
  // link outlives the row — so it gets an answer rather than a spinner that never resolves.
  if (read?.kind === 'missing') {
    return (
      <EmptyState
        title="No such connection"
        description={`Nothing here is configured as “${id}”, and this issuer ships no editor for that name. It may have been removed since this link was shared.`}
        action={
          <button className="btn primary" style={{ width: 'auto' }} onClick={() => navigate(CONNECTIONS_PATH)}>
            Back to Connections
          </button>
        }
      />
    );
  }

  // A failed read is an error state, not a pending one: "Loading…" under the error would tell
  // an operator to keep waiting for a request that already came back.
  if (!read) return err ? <p className="error">{err}</p> : <p className="muted">Loading this connection…</p>;

  const conn: Connection | null =
    read.kind === 'database'
      ? { kind: 'database', id: DATABASE_ID, name: 'Username-Password', strategy: 'database' }
      : read.kind === 'bankid'
        ? read.settings && { kind: 'bankid', id: BANKID_ID, name: 'BankID', strategy: 'bankid', settings: read.settings }
        : read.provider && providerConnection(read.entry, read.provider);
  // Not configured yet: still a connection screen, named after what it would be.
  const name = conn?.name ?? (read.kind === 'provider' ? (read.entry?.label ?? id) : 'BankID');
  const strategy = conn?.strategy ?? (read.kind === 'provider' ? (read.entry?.id ?? 'oidc') : 'bankid');
  const status = conn ? connectionStatus(conn) : { label: 'Not configured', tone: 'neutral' as const };
  const enabled = clients?.filter((c) => enabledFor(c, id)) ?? null;
  const offeredNow = id === DATABASE_ID || (conn !== null && (offered?.some((p) => p.id === id) ?? true));
  const provider = read.kind === 'provider' ? read.provider : null;

  return (
    <>
      <DetailHeader
        icon={<span style={{ fontSize: 15, fontWeight: 600 }}>{name.slice(0, 1).toUpperCase()}</span>}
        title={name}
        meta={
          <>
            <code>{strategy}</code>
            <span aria-hidden>·</span>
            <code>{id}</code>
            <Badge status={status.tone}>{status.label}</Badge>
            {provider?.platform && <span className="tag">provided by Substrat</span>}
            {provider?.allowSignup && <span className="tag">creates accounts</span>}
            {provider?.trustEmail && <span className="tag">trusted email</span>}
            {read.kind === 'bankid' && read.settings?.allowSignup && <span className="tag">creates accounts</span>}
          </>
        }
      />
      <LinkTabs
        label="Connection"
        value={tab}
        onNavigate={(href) => navigate(href)}
        tabs={CONNECTION_TABS.map((t) => ({
          value: t,
          label: TAB_LABEL[t],
          href: connectionPath(id, t),
          ...(t === 'applications' && enabled ? { count: enabled.length } : {}),
        }))}
      />
      {err && <p className="error">{err}</p>}

      {tab === 'settings' &&
        (read.kind === 'database' ? (
          <DatabaseSettings settings={read.settings} onChanged={(settings) => setRead({ kind: 'database', settings })} />
        ) : read.kind === 'bankid' ? (
          <BankIdSettingsTab
            settings={read.settings}
            onChanged={reload}
            onTested={(settings) => {
              setRead({ kind: 'bankid', settings });
              // Through the relay, a passing test is what puts BankID on the login screen.
              void readOffered();
            }}
          />
        ) : (
          <ProviderSettings issuer={issuer} entry={read.entry} provider={read.provider} onSaved={reload} />
        ))}

      {tab === 'applications' &&
        (clientsErr ? (
          <p className="error">{clientsErr}</p>
        ) : !clients ? (
          <p className="muted">Loading applications…</p>
        ) : (
          <ConnectionApplications
            connectionId={id}
            name={name}
            clients={clients}
            offered={offered}
            offeredError={offeredErr}
            offeredNow={offeredNow}
            onUpdated={(updated) =>
              setClients((current) => current?.map((c) => (c.client_id === updated.client_id ? updated : c)) ?? current)
            }
          />
        ))}

      {tab === 'raw' && (
        <RawJson
          value={{
            id,
            name,
            strategy,
            status: status.label,
            // The inverse view, as Auth0 spells it: derived from each client's
            // `metadata.signIn`, not stored on the connection.
            enabled_clients: enabled?.map((c) => c.client_id) ?? null,
            // What the read behind this screen returned, as it returned it.
            options:
              read.kind === 'database'
                ? // The settings document's one key about this connection; the rest are not its.
                  { allowSignup: read.settings.allowSignup }
                : read.kind === 'bankid'
                  ? read.settings
                  : { catalogue: read.entry, configured: read.provider },
          }}
        />
      )}
    </>
  );
}
