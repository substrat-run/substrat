import { useState } from 'react';
import { EmptyState, GridTable, Row, Switch } from '@substrat-run/ui';
import { updateOAuthClient, type PublicProvider, type RegisteredClient } from '../../api';
import { navigate } from '../../console/router';
import { APPLICATIONS_PATH, applicationPath } from '../../console/routes';
import { DATABASE_ID, enabledFor, followsEveryUpstream, routedDomains, toggledMetadata } from './model';

const COLUMNS = 'minmax(0, 1.4fr) minmax(0, 1.4fr) 110px';

/**
 * The Applications tab: every application a person signs into, with whether this connection is
 * open to it. Not new storage — a VIEW of each client's `metadata.signIn`, inverted
 * (spec/console-redesign.md §2), so the switch rewrites that client's policy through the same
 * PATCH the application's own sign-in form uses, and the enforcement point stays the
 * before-hook on `/oauth2/authorize`. The two screens therefore cannot disagree: they read and
 * write one value.
 *
 * Machine clients are not listed: they authenticate with their own secret and have no sign-in
 * for a connection to be enabled for.
 */
export function ConnectionApplications({
  connectionId, name, clients, offered, offeredError, offeredNow, onUpdated,
}: {
  connectionId: string;
  name: string;
  /** Already filtered to clients that sign in. */
  clients: RegisteredClient[];
  /** The issuer's live upstreams (`setupState`) — what an explicit list is made of. */
  offered: PublicProvider[] | null;
  offeredError: string | null;
  /** Whether the login screen draws this connection at all right now. */
  offeredNow: boolean;
  onUpdated: (client: RegisteredClient) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const upstream = connectionId !== DATABASE_ID;
  const following = upstream ? clients.filter(followsEveryUpstream).length : 0;

  const toggle = async (client: RegisteredClient, on: boolean) => {
    setErr(null);
    const label = client.client_name || client.client_id;
    let metadata: Record<string, unknown>;
    try {
      metadata = toggledMetadata(client, connectionId, on, offered);
    } catch (e) {
      setErr(`${label}: ${offeredError ? `the issuer’s connections could not be read (${offeredError})` : e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setBusy(client.client_id);
    try {
      // `metadata` alone: the built-in console row refuses most other keys (its redirect list is
      // empty and the PATCH schema refuses an empty one), and this switch owns nothing else.
      onUpdated(await updateOAuthClient(client.client_id, { metadata }));
    } catch (e) {
      // The server is the judge of a policy that leaves no way in — for any client, and more
      // strictly for the console's own — and its sentence says which rule was hit.
      setErr(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (clients.length === 0) {
    return (
      <EmptyState
        title="No applications yet"
        description="Applications that people sign into appear here, each with a switch for this connection."
        action={
          <button className="btn primary" style={{ width: 'auto' }} onClick={() => navigate(APPLICATIONS_PATH)}>
            Go to Applications
          </button>
        }
      />
    );
  }

  return (
    <>
      {!offeredNow && (
        <p className="muted">
          {name} is not on the login screen right now, so being enabled for an application has no
          effect until it is. The switches still record which applications should offer it.
        </p>
      )}
      {following > 0 && (
        <p className="muted">
          {following === 1 ? 'One application follows' : `${following} applications follow`} every
          connection this issuer offers. Turning {name} off for one of them writes an explicit list
          of the others onto it — so a connection added later is not enabled for that application
          automatically.
        </p>
      )}
      {err && <p className="error">{err}</p>}
      <GridTable columns={COLUMNS} header={['Application', 'Client ID', '~Enabled']}>
        {clients.map((client, i) => {
          const routed = upstream ? routedDomains(client, connectionId) : [];
          const href = applicationPath(client.client_id, 'connections');
          return (
            <Row key={client.client_id} columns={COLUMNS} last={i === clients.length - 1}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <a
                  href={href}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(href);
                  }}
                >
                  {client.client_name || client.client_id}
                </a>
                {/* A domain route is how a provider is offered to SOME addresses; it is edited on
                    the application, where its order and its lock are, so it is only named here. */}
                {routed.length > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-tertiary)' }}>
                    routed for {routed.map((d) => `@${d}`).join(', ')}
                  </span>
                )}
              </span>
              <code style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)', fontSize: 12.5 }}>
                {client.client_id}
              </code>
              <span style={{ justifySelf: 'end' }}>
                <Switch
                  aria-label={client.client_name || client.client_id}
                  checked={enabledFor(client, connectionId)}
                  disabled={busy !== null}
                  onChange={(on) => void toggle(client, on)}
                />
              </span>
            </Row>
          );
        })}
      </GridTable>
    </>
  );
}
