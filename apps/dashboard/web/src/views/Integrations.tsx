import { useEffect, useState } from 'react';
import { Button, Dialog, Input, Select } from '@substrat-run/ui';
import {
  api,
  ApiError,
  type AccountIntegration,
  type AppIntegration,
  type AppRow,
  type ConnectionView,
  type ProviderField,
} from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { MOCK_APP_INTEGRATIONS, MOCK_ACCOUNT_INTEGRATIONS } from '../lib/demo';
import { Page } from '../components/layout';
import { card, HonestyBanner, PageTitle, Pill, type PillKind } from '../components/ui';
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
  const complete = provider.fields.every((f) => (values[f.key] ?? '').trim() !== '') && target !== '';

  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const secret = Object.fromEntries(provider.fields.map((f) => [f.key, values[f.key]!.trim()]));
      await api.connectIntegration(target, provider.provider, { secret });
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e));
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
            Stored sealed in the connection vault — apps use it, never see it.{rotate ? ' Rotating keeps the same connection; every grant on it survives.' : ''}
          </div>
        </div>
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
        Credentials are stored sealed in the platform’s connection vault and used by the platform’s connectors on this app’s behalf — they are never echoed back, and a reveal does not exist. Disconnecting is permanent; reconnecting creates a new connection.
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
                <Button variant="secondary" size="sm" onClick={() => setDialog({ provider: p, rotate: p.connection !== null })}>
                  {p.connection ? 'Rotate' : 'Connect'}
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
      <PageTitle title="Integrations" subtitle="Connections your apps can use. Credentials are stored once, sealed, and never shown again." />
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
                      </div>
                      <HealthLine conn={c} />
                    </div>
                  ))}
                  {p.connectTargets.length === 0 && !connected && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>No installed app declares this integration yet.</div>
                  )}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setDialog(p)}
                  disabled={p.connectTargets.length === 0}
                >
                  {connected ? 'Manage' : 'Connect'}
                </Button>
              </div>
            );
          })}
        </div>
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
