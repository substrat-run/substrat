import { Fragment, useEffect, useState } from 'react';
import { Button, Dialog, Input, Select } from '@substrat-run/ui';
import {
  api,
  ApiError,
  type AccountIntegration,
  type AppIntegration,
  type AppRow,
  type ConnectionActivityView,
  type ConnectionFact,
  type ConnectionProbeView,
  type ConnectionView,
  type ProviderField,
} from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import {
  MOCK_APP_INTEGRATIONS,
  MOCK_ACCOUNT_INTEGRATIONS,
  MOCK_CONNECTION_ACTIVITY,
  MOCK_CONNECTION_PROBE,
  MOCK_PROVIDER_DOCUMENTS,
} from '../lib/demo';
import { Page } from '../components/layout';
import { card, HonestyBanner, MonoTag, PageTitle, Pill, type PillKind } from '../components/ui';
import { relativeTime } from '../lib/format';

/**
 * Integrations (dashboard-ui.md §4.8) — the connection store, tenant-facing. Two
 * surfaces over the same API: the per-app Settings tab (`AppIntegrations`, the subset
 * the app's vertical declares via manifest `requires:`) and the account-level page
 * (`Integrations`, every provider + every connection). The credential form is
 * server-driven (`fields`, the same move as the env spec); secrets are write-only —
 * connect and rotate are the same act on the same row, and nothing is ever echoed back.
 */

const STATUS: Record<ConnectionView['status'], { kind: PillKind; label: string }> = {
  active: { kind: 'success', label: 'Connected' },
  error: { kind: 'danger', label: 'Error' },
  expired: { kind: 'warning', label: 'Expired' },
  revoked: { kind: 'neutral', label: 'Disconnected' },
};

function Monogram({ text, size = 36 }: { text: string; size?: number }) {
  return (
    <span style={{ width: size, height: size, borderRadius: 8, background: 'var(--surface-inset)', border: '1px solid var(--border-subtle)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: size > 32 ? 14 : 13, fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>
      {text}
    </span>
  );
}

/** One line of connection health — last success, or the last error when unhealthy. */
function HealthLine({ conn }: { conn: ConnectionView }) {
  if (conn.status === 'error' && conn.lastError) {
    return <div style={{ fontSize: 11.5, color: 'var(--status-danger-fg)' }}>Last error {conn.lastErrorAt ? relativeTime(conn.lastErrorAt) : ''}: {conn.lastError}</div>;
  }
  if (conn.lastOkAt) {
    return <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Last used {relativeTime(conn.lastOkAt)}</div>;
  }
  return <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Connected {relativeTime(conn.createdAt)} — not used yet</div>;
}

/** A label/value line — the shape both a probe's account detail and an activity row use. */
function Facts({ facts }: { facts: ConnectionFact[] }) {
  if (facts.length === 0) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px', fontSize: 11.5 }}>
      {facts.map((f, i) => (
        <Fragment key={`${f.label}-${i}`}>
          <span style={{ color: 'var(--text-tertiary)' }}>{f.label}</span>
          <span style={{ color: 'var(--text-secondary)', fontFamily: f.value.length > 40 ? 'var(--font-mono)' : undefined, wordBreak: 'break-all' }}>
            {f.value}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * The integration detail (#605) — what a connected provider is, what it may do, and
 * what it has actually done.
 *
 * Three reads, each answering a question the card alone could not:
 *
 * - **Verify** asks the provider to accept the credential right now. Health (§3.7) is
 *   written by whatever call happened last, so a freshly connected credential has no
 *   health at all until the first real dispatch — which for Scrive means a legal
 *   document going to real signatories. The primary action here is deliberately that
 *   probe, not "save": this dialog exists so a typo is found on the spot.
 * - **Grants** are the readable blast radius: exactly what a leaked provider token could
 *   invoke on this app, straight from the live tuples rather than the catalog's claim.
 * - **Activity** is the connector's own dispatch ledger, which is the only durable record
 *   that an outbound call ever happened — the audit log deliberately holds none of it.
 *   `Refresh from provider` re-reads current state; `live` is surfaced verbatim because
 *   the ledger's view and the provider's view are different facts.
 */
function IntegrationDetail({
  provider,
  scopeId,
  connection,
  onRotate,
  onClose,
}: {
  provider: { provider: string; name: string; monogram: string; description: string };
  /** The app whose vertical owns the connection — the routes are per-app by design. */
  scopeId: string;
  connection: ConnectionView;
  onRotate: () => void;
  onClose: () => void;
}) {
  /**
   * The row as of the last read, which is NOT the prop: the prop was captured when the
   * list page loaded, and a probe rewrites health (a success clears the error and lifts
   * the row out of `error`). Rendering the prop next to a fresh probe is how a screen
   * ends up saying "Error — last error 10m ago" directly above "Credential accepted".
   */
  const [health, setHealth] = useState<ConnectionView>(connection);
  const [probe, setProbe] = useState<ConnectionProbeView | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [activity, setActivity] = useState<ConnectionActivityView | null>(null);
  const [activityErr, setActivityErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  // Which question the list is answering: what we sent, or what the provider holds.
  const [source, setSource] = useState<'ledger' | 'provider'>('ledger');

  useEffect(() => {
    if (DEV_MOCK) {
      const mock = source === 'provider' ? MOCK_PROVIDER_DOCUMENTS : MOCK_CONNECTION_ACTIVITY;
      setActivity(mock);
      setHealth(mock.connection); // same path as the live read — the preview must not diverge
      return;
    }
    let alive = true;
    setActivity(null);
    setActivityErr(null);
    api
      .integrationActivity(scopeId, provider.provider, { live, source })
      .then((v) => {
        if (!alive) return;
        setActivity(v);
        setHealth(v.connection); // read in that same request
      })
      .catch((e) => alive && setActivityErr(e instanceof ApiError ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [scopeId, provider.provider, live, source]);

  const verify = async () => {
    if (probing) return;
    setProbing(true);
    setProbeErr(null);
    try {
      if (DEV_MOCK) setProbe(MOCK_CONNECTION_PROBE);
      else {
        const result = await api.verifyIntegration(scopeId, provider.provider);
        setProbe(result);
        // The probe just wrote health; show what it wrote, not what we loaded before it.
        if (result.connection) setHealth(result.connection);
      }
    } catch (e) {
      setProbeErr(e instanceof ApiError ? e.message : String(e));
    }
    setProbing(false);
  };

  const s = STATUS[health.status];
  return (
    <Dialog
      open
      title={provider.name}
      width={640}
      cancelLabel="Close"
      confirmLabel={probing ? 'Testing…' : 'Test connection'}
      confirmDisabled={probing}
      onCancel={onClose}
      onConfirm={verify}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxHeight: '60vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Monogram text={provider.monogram} size={32} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Pill kind={s.kind}>{s.label}</Pill>
              <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{health.label}</span>
            </div>
            <HealthLine conn={health} />
          </div>
          <Button variant="secondary" size="sm" onClick={onRotate}>
            Rotate
          </Button>
        </div>

        {/* The probe's answer. A refused credential is reported as the provider's own
            words — that difference is the reason this button exists. */}
        {probeErr && (
          <div style={{ ...card, padding: 12, fontSize: 12.5, color: 'var(--status-danger-fg)' }}>
            Couldn’t reach the provider — {probeErr}
          </div>
        )}
        {probe && (
          <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Pill kind={probe.ok ? 'success' : 'danger'}>{probe.ok ? 'Credential accepted' : 'Refused'}</Pill>
              {probe.accountLabel && <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{probe.accountLabel}</span>}
            </div>
            {probe.error && <div style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{probe.error}</div>}
            <Facts facts={probe.facts} />
            {probe.ok && health.externalAccountRef && probe.accountRef && health.externalAccountRef !== probe.accountRef && (
              <div style={{ fontSize: 11.5, color: 'var(--status-warning-fg)' }}>
                These credentials act as account {probe.accountRef}, but this connection was made for{' '}
                {health.externalAccountRef}.
              </div>
            )}
          </div>
        )}

        {/* The stored credential. Identifiers whole — an identifier that cannot be read
            identifies nothing — and secrets reduced to their last four by the connector,
            which is the only party that knows which of its fields are which. */}
        {activity && activity.credential.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
              Stored credentials
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: 12 }}>
              {activity.credential.map((f) => (
                <Fragment key={f.key}>
                  <span style={{ color: 'var(--text-tertiary)' }}>{f.label}</span>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      color: f.masked ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {f.value}
                  </span>
                </Fragment>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
              Secrets are shown only by their last four characters — enough to tell two credentials apart, never
              enough to use. Rotate to replace them.
            </div>
          </div>
        )}

        {/* What a leaked token could invoke — the live tuples, not the catalog's claim. */}
        {activity && activity.grants.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
              This connection may invoke
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {activity.grants.map((g) => (
                <MonoTag key={g}>{g}</MonoTag>
              ))}
            </div>
          </div>
        )}

        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              {source === 'provider' ? `All documents at ${provider.name}` : 'Sent from this app'}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              {/* Two questions, not two renderings of one: the ledger is complete for our
                  traffic and blind to the rest of the account; the archive is the reverse. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSource((s) => (s === 'ledger' ? 'provider' : 'ledger'))}
              >
                {source === 'ledger' ? `Show all at ${provider.name}` : 'Show what we sent'}
              </Button>
              {source === 'ledger' && (
                <Button variant="ghost" size="sm" onClick={() => setLive((v) => !v)}>
                  {live ? 'Showing provider state' : 'Refresh from provider'}
                </Button>
              )}
            </div>
          </div>
          {activityErr && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>Couldn’t load activity — {activityErr}</div>}
          {!activityErr && !activity && <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading…</div>}
          {activity && activity.entries.length === 0 && (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
              {source === 'provider'
                ? `No documents in this ${provider.name} account yet.`
                : 'Nothing has been sent through this connection yet.'}
            </div>
          )}
          {activity && activity.entries.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {live && !activity.live && (
                <div style={{ fontSize: 11.5, color: 'var(--status-warning-fg)' }}>
                  The provider couldn’t be reached — showing what this platform recorded sending.
                </div>
              )}
              {activity.entries.map((e) => (
                <div key={e.key} style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{e.title}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{e.status}</span>
                    {e.at && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>sent {relativeTime(e.at)}</span>}
                  </div>
                  <Facts facts={e.facts} />
                  {e.reference && (
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      Provider reference <MonoTag>{e.reference}</MonoTag>
                    </div>
                  )}
                </div>
              ))}
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {activity.source === 'provider'
                  ? `Everything in this ${provider.name} account, newest first — including documents created outside this app.`
                  : activity.live
                    ? 'Statuses read live from the provider.'
                    : 'What this platform recorded sending — the provider may have moved on since.'}
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The connect / rotate dialog: the provider's declared fields, all required (a provider
 * credential is a set, not a sum of options). `pickTarget` adds the account-level app
 * selector — the credential always lands on ONE app's vertical.
 */
function ConnectDialog({
  provider,
  rotate,
  scopeId,
  pickTarget,
  onDone,
  onClose,
}: {
  provider: { provider: string; name: string; monogram: string; fields: ProviderField[] };
  rotate: boolean;
  /** The fixed target app (the per-app tab). Omit to render the account-level picker. */
  scopeId?: string;
  pickTarget?: Array<{ scopeId: string; name: string; connected: boolean }>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<string>(scopeId ?? pickTarget?.[0]?.scopeId ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** The provider rejected these credentials — distinct from "the save failed". */
  const [refusal, setRefusal] = useState<{ message: string; probe?: ConnectionProbeView } | null>(null);
  const complete = provider.fields.every((f) => (values[f.key] ?? '').trim() !== '') && target !== '';

  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    setErr(null);
    setRefusal(null);
    try {
      const secret = Object.fromEntries(provider.fields.map((f) => [f.key, values[f.key]!.trim()]));
      await api.connectIntegration(target, provider.provider, { secret });
      onDone();
    } catch (e) {
      // A 422 is the provider itself refusing the credential — nothing was stored, so the
      // dialog stays open with what was typed and says which field to look at. The old
      // behaviour (store, close, call it Connected) is what let a bad key sit until the
      // first signing request failed.
      if (e instanceof ApiError && e.status === 422) setRefusal({ message: e.message, probe: e.probe });
      else setErr(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={`${rotate ? 'Rotate' : 'Connect'} ${provider.name}`}
      confirmLabel={busy ? 'Saving…' : rotate ? 'Rotate credentials' : 'Connect'}
      confirmDisabled={!complete || busy}
      onCancel={onClose}
      onConfirm={submit}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Monogram text={provider.monogram} size={32} />
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            Checked with {provider.name} before it is stored, then sealed in the connection vault — apps use it, never
            see it.{rotate ? ' Rotating keeps the same connection; every grant on it survives.' : ''}
          </div>
        </div>

        {/* The provider's refusal, in its own words. Nothing was written, so this is a
            correction prompt rather than an error report — and on a rotation it is the
            reason the live credential is still intact. */}
        {refusal && (
          <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 6, borderColor: 'var(--status-danger-fg)' }}>
            <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>
              {provider.name} rejected these credentials — nothing was saved.
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{refusal.message}</div>
            {refusal.probe && refusal.probe.facts.length > 0 && <Facts facts={refusal.probe.facts} />}
          </div>
        )}
        {scopeId === undefined && pickTarget && (
          <Select
            label="Connect for"
            options={pickTarget.map((t) => ({ value: t.scopeId, label: t.connected ? `${t.name} (rotates the existing connection)` : t.name }))}
            value={target}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTarget(e.target.value)}
            style={{ width: 320 }}
          />
        )}
        {provider.fields.map((f) => (
          <Input
            key={f.key}
            label={f.label}
            type={f.secret ? 'password' : 'text'}
            placeholder={f.placeholder ?? (f.secret ? '••••••••' : '')}
            value={values[f.key] ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            mono
          />
        ))}
        {err && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>Couldn’t save — {err}</div>}
      </div>
    </Dialog>
  );
}

/** The per-app Settings → Integrations tab. */
export function AppIntegrations({ app }: { app: AppRow }) {
  const [view, setView] = useState<AppIntegration[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ provider: AppIntegration; rotate: boolean } | null>(null);
  const [detail, setDetail] = useState<AppIntegration | null>(null);
  const [disconnect, setDisconnect] = useState<AppIntegration | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (DEV_MOCK) {
      setView(MOCK_APP_INTEGRATIONS.providers);
      return;
    }
    let live = true;
    setView(null);
    setErr(null);
    api
      .appIntegrations(app.app_scope_id)
      .then((v) => live && setView(v.providers))
      .catch((e) => live && setErr(e instanceof ApiError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [app.app_scope_id, nonce]);

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load integrations — {err}</div>;
  if (!view) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading integrations…</div>;

  const confirmDisconnect = async () => {
    if (!disconnect || busy) return;
    setBusy(true);
    try {
      await api.disconnectIntegration(app.app_scope_id, disconnect.provider);
    } catch {
      // The refetch below shows the surviving state either way.
    }
    setBusy(false);
    setDisconnect(null);
    setNonce((n) => n + 1);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <HonestyBanner>
        Credentials are stored sealed in the platform’s connection vault and used by the platform’s connectors on this
        app’s behalf. A secret is never shown again — Details lists the identifiers and the last four characters of each
        secret, which is enough to recognise a credential and not enough to use one; replacing it means rotating.
        Disconnecting is permanent, and reconnecting creates a new connection.
      </HonestyBanner>
      {view.length === 0 && (
        <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>
          This app declares no integrations — its vertical lists none in its manifest.
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
        {view.map((p) => {
          const s = p.connection ? STATUS[p.connection.status] : { kind: 'neutral' as PillKind, label: 'Not connected' };
          return (
            <div key={p.provider} style={{ ...card, padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <Monogram text={p.monogram} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</span>
                  <Pill kind={s.kind}>{s.label}</Pill>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{p.description}</div>
                {p.connection ? (
                  <HealthLine conn={p.connection} />
                ) : p.required ? (
                  <div style={{ fontSize: 11.5, color: 'var(--status-warning-fg)' }}>
                    Required by this app — signing requests wait until it’s connected, then deliver.
                  </div>
                ) : null}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => (p.connection ? setDetail(p) : setDialog({ provider: p, rotate: false }))}
                >
                  {p.connection ? 'Details' : 'Connect'}
                </Button>
                {p.connection && (
                  <Button variant="ghost" size="sm" onClick={() => setDisconnect(p)}>
                    Disconnect
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {dialog && (
        <ConnectDialog
          scopeId={app.app_scope_id}
          provider={dialog.provider}
          rotate={dialog.rotate}
          onDone={() => {
            setDialog(null);
            setNonce((n) => n + 1);
          }}
          onClose={() => setDialog(null)}
        />
      )}

      {detail?.connection && (
        <IntegrationDetail
          provider={detail}
          scopeId={app.app_scope_id}
          connection={detail.connection}
          onRotate={() => {
            setDialog({ provider: detail, rotate: true });
            setDetail(null);
          }}
          onClose={() => {
            setDetail(null);
            setNonce((n) => n + 1); // a verify inside the drawer may have repaired health
          }}
        />
      )}

      <Dialog
        open={!!disconnect}
        title={disconnect ? `Disconnect ${disconnect.name}` : ''}
        confirmLabel={busy ? 'Disconnecting…' : 'Disconnect'}
        danger
        onCancel={() => setDisconnect(null)}
        onConfirm={confirmDisconnect}
      >
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          The stored credential is deleted and every grant it carried is revoked — this cannot be undone. Deliveries already queued stay queued and resume if you reconnect. Other apps of the same kind share this connection and lose it too.
        </div>
      </Dialog>
    </div>
  );
}

/** The account-level Integrations page: every provider, every connection, every app that can connect one. */
export function Integrations() {
  const [view, setView] = useState<AccountIntegration[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AccountIntegration | null>(null);
  const [detail, setDetail] = useState<{ provider: AccountIntegration; scopeId: string; connection: ConnectionView } | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (DEV_MOCK) {
      setView(MOCK_ACCOUNT_INTEGRATIONS.providers);
      return;
    }
    let live = true;
    setView(null);
    setErr(null);
    api
      .integrations()
      .then((v) => live && setView(v.providers))
      .catch((e) => live && setErr(e instanceof ApiError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [nonce]);

  return (
    <Page>
      <PageTitle
        title="Integrations"
        subtitle="Connections your apps can use. Credentials are stored sealed; a secret is never shown again, only recognised by its last four characters."
      />
      {err && <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load integrations — {err}</div>}
      {!err && !view && <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading integrations…</div>}
      {view && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          {view.map((p) => {
            const connected = p.connections.length > 0;
            return (
              <div key={p.provider} style={{ ...card, padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <Monogram text={p.monogram} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</span>
                    <Pill kind={connected ? 'success' : 'neutral'}>{connected ? 'Connected' : 'Not connected'}</Pill>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{p.description}</div>
                  {p.connections.map((c) => (
                    <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                        <Pill kind={STATUS[c.status].kind}>{STATUS[c.status].label}</Pill>
                        <span style={{ color: 'var(--text-primary)' }}>{c.label}</span>
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          used by {c.apps.length > 0 ? c.apps.map((a) => a.name).join(', ') : c.vertical}
                        </span>
                        {/* Detail is per-APP because the routes are: a connection is keyed to a
                            vertical, and any app of that vertical is a valid door to it. */}
                        {c.apps[0] && (
                          <Button variant="ghost" size="sm" onClick={() => setDetail({ provider: p, scopeId: c.apps[0]!.scopeId, connection: c })}>
                            Details
                          </Button>
                        )}
                      </div>
                      <HealthLine conn={c} />
                    </div>
                  ))}
                  {p.connectTargets.length === 0 && !connected && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>No installed app declares this integration yet.</div>
                  )}
                </div>
                {/* Manage used to open the empty connect form, which read as "your
                    credentials are gone". A connected provider opens its detail; the
                    rotate form is one click further in, where replacing a credential
                    belongs. */}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const first = p.connections[0];
                    const scope = first?.apps[0]?.scopeId ?? p.connectTargets.find((t) => t.connected)?.scopeId;
                    if (first && scope) setDetail({ provider: p, scopeId: scope, connection: first });
                    else setDialog(p);
                  }}
                  disabled={p.connectTargets.length === 0 && !connected}
                >
                  {connected ? 'Manage' : 'Connect'}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {detail && (
        <IntegrationDetail
          provider={detail.provider}
          scopeId={detail.scopeId}
          connection={detail.connection}
          onRotate={() => {
            setDialog(detail.provider);
            setDetail(null);
          }}
          onClose={() => {
            setDetail(null);
            setNonce((n) => n + 1);
          }}
        />
      )}

      {dialog && (
        <ConnectDialog
          provider={dialog}
          rotate={false}
          pickTarget={dialog.connectTargets}
          onDone={() => {
            setDialog(null);
            setNonce((n) => n + 1);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </Page>
  );
}
