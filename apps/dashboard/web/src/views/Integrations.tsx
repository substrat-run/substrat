import { Fragment, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, Input, RadioGroup, Select, Textarea } from '@substrat-run/ui/wa';
import {
  api,
  teamApi,
  isApiError,
  type AccountIntegration,
  type AppIntegration,
  type AppIntegrationsView,
  type AppRow,
  type CertificateView,
  type ConnectionActivityView,
  type ConnectionFact,
  type ConnectionIntentView,
  type UnreadableIntentView,
  type ConnectionProbeView,
  type ConnectionView,
  type SweepRunView,
  type ConnectLinkView,
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
import { card, HonestyBanner, MonoTag, PageTitle, Pill, type PillKind , SweepStrip } from '../components/ui';
import { relativeTime, untilTime } from '../lib/format';
import { MailInCard } from './MailInCard';
import { ApiError as TeamApiError } from '../lib/api.generated';

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

const INTENT_STATUS: Record<ConnectionIntentView['status'], { kind: PillKind; label: string }> = {
  pending: { kind: 'warning', label: 'Retrying' },
  done: { kind: 'success', label: 'Delivered' },
  failed: { kind: 'danger', label: 'Failed' },
};

/**
 * Who refused this delivery, and — when it was us — the grant that explains it (#841).
 *
 * The drawer already held both halves of this diagnosis and never joined them. `permission
 * denied: protocol:read` was rendered under a caption saying Scrive had refused, while the
 * list of grants directly above it did not contain `protocol:read`. Both facts on one screen,
 * inches apart, and nothing said that one was the other's answer. The operator went to audit
 * their Scrive account, pressed **Test connection** (which passes — the credential is fine),
 * and lost an afternoon to a platform that was telling them the wrong thing confidently.
 *
 * The join is mechanical, not inferred: the drain records the permission key the refusal
 * named, and this asks whether the connection holds it. When the key IS held the sentence is
 * deliberately not written — a refusal that names a grant the connection has is a different
 * bug, and guessing at it here would rebuild the wall this removes.
 */
function IntentAttribution({
  intent,
  providerName,
  held,
}: {
  intent: ConnectionIntentView;
  providerName: string;
  held: Set<string>;
}) {
  // Nothing to attribute: a success, or a row settled before anyone classified it. Silence
  // is the honest rendering — the previous caption's whole failure was speaking anyway.
  if (intent.status !== 'failed' || !intent.failure) return null;
  const { origin, permission } = intent.failure;
  const missing = permission !== null && !held.has(permission);
  return (
    <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
      {origin === 'provider'
        ? `Refused by ${providerName}. This is their answer, quoted in full.`
        : origin === 'platform'
          ? `Refused by this platform before anything was sent — ${providerName} never saw this request, and its credential is not implicated.`
          : `Refused before this delivery completed; the origin could not be attributed.`}
      {missing && (
        <>
          {' '}
          <span style={{ color: 'var(--status-danger-fg)' }}>
            This connection does not hold <code style={{ fontFamily: 'var(--font-mono)' }}>{permission}</code> — it is
            absent from the grants listed above.
          </span>
        </>
      )}
    </div>
  );
}

/**
 * **What the platform tried to send, and what came back** (#618).
 *
 * The card above this one used to be the whole diagnosis available for a broken connector:
 * `Error · scrive · Last error 7m ago: HTTP 409 from scrive`. The sentence that actually named
 * the bug — "Authentication to sign for participant #1 requires valid personal number field" —
 * was journaled correctly on the intent row and reachable only by opening the read-only SQL
 * console with system tables toggled on. So: one row per delivery, and the error printed in
 * full. Truncating it here would rebuild the exact wall this section exists to remove.
 *
 * `Retrying` and `Failed` are different facts and are kept apart: a failed delivery is over —
 * the platform is not coming back to it — and a 4xx now settles that way on the first attempt
 * rather than after two days of identical retries.
 */
export function IntentLedger({
  intents,
  unreadable,
  providerName,
  grants,
}: {
  intents: ConnectionIntentView[];
  /** #1637: records the platform could not read whole — named, so none goes missing silently. */
  unreadable: UnreadableIntentView[];
  providerName: string;
  /** The live grants rendered directly above — the other half of the join. */
  grants: string[];
}) {
  if (intents.length === 0 && unreadable.length === 0) return null;
  const held = new Set(grants);
  const failed = intents.filter((i) => i.status === 'failed').length;
  // Only a delivery the drain actually attributed to the provider may be quoted as their
  // words. An unattributed one (older plane or older vertical) says nothing about origin
  // rather than guessing — saying less is the fix, not a weaker version of it.
  const quotable = intents.some((i) => i.status === 'failed' && i.failure?.origin === 'provider');
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
        Delivery attempts
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {intents.map((i) => {
          const s = INTENT_STATUS[i.status];
          return (
            <div key={i.id} style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <Pill kind={s.kind}>{s.label}</Pill>
                {i.eventType && <MonoTag>{i.eventType}</MonoTag>}
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  sent {relativeTime(i.requestedAt)}
                  {i.settledAt ? `, settled ${relativeTime(i.settledAt)}` : ''}
                  {i.attempts > 1 ? ` · ${i.attempts} attempts` : ''}
                </span>
              </div>
              {i.lastError && (
                <div
                  style={{
                    fontSize: 12,
                    lineHeight: 1.5,
                    fontFamily: 'var(--font-mono)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: i.status === 'failed' ? 'var(--status-danger-fg)' : 'var(--status-warning-fg)',
                  }}
                >
                  {i.lastError}
                </div>
              )}
              <IntentAttribution intent={i} providerName={providerName} held={held} />
            </div>
          );
        })}
        {unreadable.map((u, n) => (
          <div key={`unreadable-${n}`} style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <Pill kind="danger">Unreadable</Pill>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                stored as {u.id ?? 'no id'} · status {u.status ?? 'none'} · sent {u.requestedAt ?? 'at an unknown time'}
              </span>
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5, fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>
              {u.decodeError}
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
              This record could not be read whole, so it is shown as stored. The platform never runs a record it cannot read.
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
        {failed === 0
          ? `What this platform sent to ${providerName} on this app's behalf, newest first.`
          : quotable
            ? `A failed delivery is not retried. Where the refusal came from ${providerName}, it is quoted in full and the same bytes would be refused again.`
            : `A failed delivery is not retried. Each one says above whether ${providerName} refused it or this platform did.`}
      </div>
    </div>
  );
}

/**
 * A test message through a mail connection (#2343). Mail cannot be tested without sending, so
 * this sends one from a chosen sender address to the signed-in person's own address (the server
 * takes it from the session; there is nothing to type). A refusal is shown in the connector's
 * words, and a success marks that address verified.
 */
function SendTest({
  teamId,
  provider,
  scopeId,
  connectionId,
  senders,
  onSent,
}: {
  teamId: string;
  provider: string;
  scopeId: string;
  connectionId: string;
  senders: string[];
  onSent: () => void;
}) {
  const [from, setFrom] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const chosen = from || senders[0] || '';
  if (senders.length === 0) return null;

  const send = async () => {
    if (sending) return;
    setSending(true);
    setResult(null);
    try {
      const r = DEV_MOCK
        ? { ok: true, error: null }
        : await teamApi(teamId).sendTestAppConnection({ scopeId, provider, connectionId, from: chosen });
      setResult(r);
      if (r.ok) onSent();
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    setSending(false);
  };

  return (
    <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>Send a test message</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        Mail is verified by sending. This sends one short message to your own address.
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
        <Select
          label="From"
          options={senders.map((s) => ({ value: s, label: s }))}
          value={chosen}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setFrom(e.target.value)}
          style={{ width: 320 }}
        />
        <Button variant="secondary" size="sm" onClick={send} disabled={sending}>
          {sending ? 'Sending…' : 'Send test'}
        </Button>
      </div>
      {result && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Pill kind={result.ok ? 'success' : 'danger'}>{result.ok ? 'Sent' : 'Refused'}</Pill>
          {result.error && <span style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{result.error}</span>}
        </div>
      )}
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
  teamId,
  provider,
  scopeId,
  connection,
  onRotate,
  onClose,
}: {
  teamId: string;
  provider: { provider: string; name: string; monogram: string; description: string; sendsMail?: boolean };
  /** The app whose vertical owns the connection — the routes are per-app by design. */
  scopeId: string;
  connection: ConnectionView;
  /** `held`: the keys of the stored credential's summary, so the dialog starts on the method the connection holds (#3281). */
  onRotate: (held: string[]) => void;
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
  // Bumped after a send test, so the credential view re-reads which senders are verified.
  const [refresh, setRefresh] = useState(0);

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
    teamApi(teamId)
      // By id: in a fleet the provider's routes would otherwise answer for another company.
      .getAppConnectionActivity({ scopeId, provider: provider.provider, connectionId: connection.id, ...(live ? { live: '1' } : {}), source })
      .then((v) => {
        if (!alive) return;
        setActivity(v as unknown as ConnectionActivityView);
        setHealth(v.connection as ConnectionView); // read in that same request
      })
      .catch((e) => alive && setActivityErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [teamId, scopeId, provider.provider, connection.id, live, source, refresh]);

  const verify = async () => {
    if (probing) return;
    setProbing(true);
    setProbeErr(null);
    try {
      if (DEV_MOCK) setProbe(MOCK_CONNECTION_PROBE);
      else {
        const result = await teamApi(teamId).verifyAppConnection({ scopeId, provider: provider.provider, connectionId: connection.id });
        setProbe(result as ConnectionProbeView);
        // The probe just wrote health; show what it wrote, not what we loaded before it.
        if (result.connection) setHealth(result.connection as ConnectionView);
      }
    } catch (e) {
      setProbeErr(e instanceof Error ? e.message : String(e));
    }
    setProbing(false);
  };

  const s = STATUS[health.status];
  // #2422: a fresh probe's answer over the recorded one, which can predate a re-consent.
  const consent = probe?.consent ?? activity?.consent ?? null;
  const reconsent = health.status !== 'revoked' && consent !== null && consent.missing.length > 0 ? consent : null;
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
              {reconsent && <Pill kind="warning">Needs re-consent</Pill>}
              <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{health.label}</span>
            </div>
            <HealthLine conn={health} />
            <SweepStrip runs={activity?.sweepRuns ?? []} skippedNote="nothing polls this connection" />
          </div>
          <Button variant="secondary" size="sm" onClick={() => onRotate(activity?.credential.map((f) => f.key) ?? [])}>
            Rotate
          </Button>
        </div>

        {/* #2422: the consent is short of what the platform asks for. Not a refused credential —
            the keys work — so the repair offered is a new consent round, not new keys. */}
        {reconsent && (
          <div style={{ ...card, padding: 12, display: 'flex', alignItems: 'center', gap: 12, borderColor: 'var(--status-warning-fg)' }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-primary)' }}>
              The {provider.name} consent does not cover <strong>{reconsent.missing.join(', ')}</strong>, so what needs{' '}
              {reconsent.missing.length === 1 ? 'it' : 'them'} will not run. The credential works: the company approving the
              connection again grants {reconsent.missing.length === 1 ? 'it' : 'them'}.
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                Granted: {reconsent.granted.join(', ') || 'nothing'} · checked {relativeTime(reconsent.checkedAt)}. After
                re-consenting, Test connection checks again.
              </div>
            </div>
            <Button variant="primary" size="sm" onClick={() => onRotate(activity?.credential.map((f) => f.key) ?? [])}>
              Re-consent
            </Button>
          </div>
        )}

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
              {probe.consent && probe.consent.missing.length > 0 ? (
                <Pill kind="warning">Needs re-consent</Pill>
              ) : (
                <Pill kind={probe.ok ? 'success' : 'danger'}>{probe.ok ? 'Credential accepted' : 'Refused'}</Pill>
              )}
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

        {provider.sendsMail && (
          <SendTest
            teamId={teamId}
            provider={provider.provider}
            scopeId={scopeId}
            connectionId={connection.id}
            senders={activity?.mailSenders ?? []}
            onSent={() => setRefresh((n) => n + 1)}
          />
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
            {/* #3281: a client secret's end, when the owner gave it. Nothing renews it. */}
            {clientSecretEnd(activity.credential) && (
              <ExpiryNotice notAfter={clientSecretEnd(activity.credential)!} subject="client secret" />
            )}
          </div>
        )}

        {/* #2100: the certificate the platform generated for this connection. Public — the
            private key never leaves the plane — and the tenant's next step until it is uploaded.
            #3281: or the owner's own, which the platform does not renew, so its end is a warning. */}
        {activity?.certificate && (
          <div>
            {activity.certificate.supplied ? (
              <>
                <CertificateCard
                  title="Certificate (yours, supplied)"
                  certificate={activity.certificate}
                  note="You supplied this certificate and its private key; the platform does not renew it. The thumbprint Entra shows under Certificates & secrets should match the one above."
                />
                <ExpiryNotice notAfter={activity.certificate.notAfter} subject="certificate" />
              </>
            ) : (
              <CertificateCard
                title="Certificate"
                certificate={activity.certificate}
                download={{ label: 'Download certificate (.cer)', filename: provider.provider }}
                note="Upload it to your app registration under Certificates & secrets, then test the connection. The thumbprint Entra shows should match the one above. The private key stays with the platform."
              />
            )}
            {activity.certificate.next && (
              <div style={{ marginTop: 10 }}>
                <CertificateCard
                  title="New certificate"
                  certificate={activity.certificate.next}
                  download={{ label: 'Download new certificate (.cer)', filename: `${provider.provider}-new` }}
                  note={`Upload it beside the current one before ${activity.certificate.notAfter.slice(0, 10)}, then save the connection: it switches to the new certificate once Entra accepts it, and you can then remove the old one from the app registration. Until then the current certificate keeps signing.`}
                />
              </div>
            )}
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

        {/* Above the ledger on purpose: when something is broken this is the answer, and it
            should not be below a list of documents that all look fine. */}
        {activity && (
          <IntentLedger
            intents={activity.intents ?? []}
            unreadable={activity.unreadableIntents ?? []}
            providerName={provider.name}
            grants={activity.grants}
          />
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
 *
 * A provider with `connectFlow: 'redirect'` (#1220) leads with the consent round
 * instead: **Continue to {name}** mints a single-use connect link and follows it, and
 * **Copy connect link** mints one to hand to whoever administers the provider account —
 * they need no dashboard login. The credential form stays behind a toggle as the
 * operator fallback. Rotation is the same consent round again (it rotates the live
 * connection in place), so the dialog is identical either way.
 *
 * A `multiAccount` provider (#1267) keys a connection on the company the approver picks,
 * so each round connects ONE company and a new company is a new connection — never a
 * rotation. A bureau mails one link per client, which is why the copy says so.
 */
function ConnectDialog({
  teamId,
  provider,
  rotate,
  held,
  scopeId,
  pickTarget,
  onDone,
  onClose,
}: {
  teamId: string;
  provider: {
    provider: string;
    name: string;
    monogram: string;
    fields: ProviderField[];
    connectFlow?: 'redirect' | null;
    multiAccount?: boolean;
  };
  rotate: boolean;
  /** #3281: the stored credential's summary keys, from the connection the dialog was opened on. */
  held?: string[];
  /** The fixed target app (the per-app tab). Omit to render the account-level picker. */
  scopeId?: string;
  pickTarget?: Array<{ scopeId: string; name: string; connected: boolean }>;
  onDone: () => void;
  onClose: () => void;
}) {
  const redirect = provider.connectFlow === 'redirect';
  const fleet = provider.multiAccount === true;
  const unit = fleetUnit(provider);
  const [manual, setManual] = useState(!redirect);
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(provider.fields, held));
  /**
   * #3281: which file a field's value was read from, kept with the value rather than in the field:
   * switching method unmounts the field, and a remounted one that forgot would draw the key.
   */
  const [loadedFrom, setLoadedFrom] = useState<Record<string, string | null>>({});
  /** #3281: fields whose file is still being read; Connect waits for them, so it never sends the file before. */
  const [reading, setReading] = useState<Record<string, boolean>>({});
  const form: FormState = { values, rotate, held, fields: provider.fields };
  const [target, setTarget] = useState<string>(scopeId ?? pickTarget?.[0]?.scopeId ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** The provider rejected these credentials — distinct from "the save failed". */
  const [refusal, setRefusal] = useState<{ message: string; probe?: ConnectionProbeView } | null>(null);
  /** The PLATFORM can't store a credential here (503) — nothing to do with what was typed. */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  /** Outstanding consent links for this app+provider — each revocable while unused. */
  const [links, setLinks] = useState<ConnectLinkView[]>([]);
  /** The link just minted for sharing — shown once; listing never returns the URL. */
  const [minted, setMinted] = useState<{ url: string; expiresAt: string; copied: boolean } | null>(null);
  const shown = (f: ProviderField) => fieldShown(f, values);
  const complete =
    provider.fields.every((f) => !fieldRequired(f, form) || (values[f.key] ?? '').trim() !== '') &&
    !Object.values(reading).some(Boolean) &&
    target !== '';

  useEffect(() => {
    if (!redirect || DEV_MOCK || target === '') return;
    let live = true;
    teamApi(teamId)
      .listAppConnectLinks({ scopeId: target, provider: provider.provider })
      .then((v) => live && setLinks(v.links))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [redirect, teamId, target, provider.provider]);

  const refreshLinks = async () => {
    const refreshed = await teamApi(teamId)
      .listAppConnectLinks({ scopeId: target, provider: provider.provider })
      .catch(() => null);
    if (refreshed) setLinks(refreshed.links);
  };

  /** Mint a fresh single-use link and follow it — the Connect button's whole journey. */
  const goConnect = async () => {
    if (target === '' || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // Short-lived on purpose: this link is spent within seconds, by this browser.
      const link = await teamApi(teamId).mintAppConnectLink({ scopeId: target, provider: provider.provider, ttlMs: 10 * 60 * 1000 });
      window.location.assign(link.url);
    } catch (e) {
      if (e instanceof TeamApiError && e.status === 503) setUnavailable(e.message);
      else setErr(e instanceof TeamApiError ? e.message : String(e));
      setBusy(false);
    }
  };

  /** Mint a shareable link (the 7-day default) for a provider admin with no login here. */
  const copyLink = async () => {
    if (target === '' || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const link = await teamApi(teamId).mintAppConnectLink({ scopeId: target, provider: provider.provider });
      // The clipboard write can be refused (no permission, insecure context) — the URL
      // is shown below either way, but the message must not claim a copy that failed.
      const copied = await navigator.clipboard.writeText(link.url).then(() => true, () => false);
      setMinted({ url: link.url, expiresAt: link.expiresAt, copied });
      await refreshLinks();
    } catch (e) {
      if (e instanceof TeamApiError && e.status === 503) setUnavailable(e.message);
      else setErr(e instanceof TeamApiError ? e.message : String(e));
    }
    setBusy(false);
  };

  const revokeLink = async (linkId: string) => {
    try {
      await teamApi(teamId).revokeAppConnectLink({ scopeId: target, provider: provider.provider, linkId });
    } catch {
      // The refetch shows the surviving state either way.
    }
    await refreshLinks();
    setMinted(null);
  };

  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    setErr(null);
    setRefusal(null);
    setUnavailable(null);
    try {
      // An optional field left empty is left out, not sent as '' (#2100), and so is one its
      // choice hides (#3281): a key typed before switching to a client secret is not sent.
      const secret = Object.fromEntries(
        provider.fields.flatMap((f) => {
          const v = (values[f.key] ?? '').trim();
          return v && shown(f) ? [[f.key, v]] : [];
        }),
      );
      await teamApi(teamId).connectAppIntegration({ scopeId: target, provider: provider.provider, secret });
      onDone();
    } catch (e) {
      // A 422 is the provider itself refusing the credential — nothing was stored, so the
      // dialog stays open with what was typed and says which field to look at. The old
      // behaviour (store, close, call it Connected) is what let a bad key sit until the
      // first signing request failed.
      if (e instanceof TeamApiError && e.status === 422) {
        setRefusal({ message: e.message, probe: (e.body as { probe?: ConnectionProbeView } | null)?.probe });
      }
      // A 503 is the platform saying it cannot store credentials on this deployment
      // (#603) — the key may be perfect. Saying so beats "Couldn’t save — 500", which
      // is what this used to be and reads as "your credential is bad".
      else if (e instanceof TeamApiError && e.status === 503) setUnavailable(e.message);
      else setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={rotate ? `Rotate ${provider.name}` : fleet ? `Connect a ${provider.name} ${unit.one}` : `Connect ${provider.name}`}
      confirmLabel={
        redirect && !manual
          ? busy
            ? 'Opening…'
            : `Continue to ${provider.name}`
          : busy
            ? 'Saving…'
            : rotate
              ? 'Rotate credentials'
              : 'Connect'
      }
      confirmDisabled={redirect && !manual ? target === '' || busy : !complete || busy}
      onCancel={onClose}
      onConfirm={redirect && !manual ? goConnect : submit}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Monogram text={provider.monogram} size={32} />
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            {redirect && !manual && fleet ? (
              <>
                Each approval at {provider.name} connects ONE company — the one its administrator picks there — and
                seals the credential in the connection vault. To add more companies, mint more links: one per company.
                {rotate
                  ? ' Re-approving as the same company keeps its connection and every grant on it; approving a different company adds that company instead.'
                  : ''}
              </>
            ) : redirect && !manual ? (
              <>
                Connecting happens at {provider.name}: an administrator of your {provider.name} account approves once,
                and the credential is sealed in the connection vault — nothing is typed here.
                {rotate ? ' Re-approving keeps the same connection; every grant on it survives.' : ''}
              </>
            ) : fleet ? (
              <>
                Checked with {provider.name} before it is stored, then sealed in the connection vault — apps use it,
                never see it. It is kept per {provider.name} {unit.one}: a credential for a connected {unit.one} replaces
                its credential and keeps every grant on it, and one for another {unit.one} adds a connection.
              </>
            ) : (
              <>
                Checked with {provider.name} before it is stored, then sealed in the connection vault — apps use it,
                never see it.{rotate ? ' Rotating keeps the same connection; every grant on it survives.' : ''}
              </>
            )}
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
        {/* Not the credential: the deployment. Kept separate from the refusal above so a
            correct key is never presented as the thing to fix — the only way out is an
            operator setting the plane's seal key. */}
        {unavailable && (
          <div style={{ ...card, padding: 12, display: 'flex', flexDirection: 'column', gap: 6, borderColor: 'var(--status-warning-fg)' }}>
            <div style={{ fontSize: 12.5, color: 'var(--status-warning-fg)' }}>
              This deployment can’t store credentials right now — nothing was saved, and nothing was sent to{' '}
              {provider.name}.
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{unavailable}</div>
          </div>
        )}
        {scopeId === undefined && pickTarget && (
          <Select
            label="Connect for"
            // A fleet provider's new company is a new connection, so nothing is rotated.
            options={pickTarget.map((t) => ({
              value: t.scopeId,
              label: t.connected && !fleet ? `${t.name} (rotates the existing connection)` : t.name,
            }))}
            value={target}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTarget(e.target.value)}
            style={{ width: 320 }}
          />
        )}

        {/* The shareable half of the consent round: the person who administers the
            provider account is often not a member here, so the round travels as a URL —
            single-use, expiring, and revocable below until someone spends it. */}
        {redirect && !manual && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* For a fleet the link IS the main path — one mailed per client company. */}
              <Button variant={fleet ? 'secondary' : 'ghost'} size="sm" onClick={copyLink} disabled={target === '' || busy}>
                Copy connect link
              </Button>
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                {fleet
                  ? `One link per company — send each company's ${provider.name} administrator their own. No dashboard login needed. Single-use, valid 7 days.`
                  : `For whoever administers ${provider.name} — no dashboard login needed. Single-use, valid 7 days.`}
              </span>
            </div>
            {minted && (
              <div style={{ ...card, padding: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div
                  style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', wordBreak: 'break-all', color: 'var(--text-secondary)', userSelect: 'all' }}
                >
                  {minted.url}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {minted.copied ? 'Copied to the clipboard.' : 'Clipboard access was blocked — copy the URL above by hand.'}{' '}
                  Shown once — mint a new link if it is lost. Valid {untilTime(minted.expiresAt)}.
                </div>
              </div>
            )}
            {links.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)' }}>Outstanding links</div>
                {links.map((l) => (
                  <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-secondary)' }}>
                    <span>
                      created {relativeTime(l.createdAt)}, valid {untilTime(l.expiresAt)}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => revokeLink(l.id)}>
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(!redirect || manual) &&
          provider.fields.filter(shown).map((f) =>
            f.choices ? (
              <ChoiceField
                key={f.key}
                field={f}
                rotate={rotate}
                value={values[f.key] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
              />
            ) : f.file ? (
              <FileField
                key={f.key}
                field={f}
                suffix={fieldSuffix(f, form)}
                value={values[f.key] ?? ''}
                loaded={loadedFrom[f.key] ?? null}
                onReading={(on) => setReading((prev) => ({ ...prev, [f.key]: on }))}
                onChange={(v, from) => {
                  setValues((prev) => ({ ...prev, [f.key]: v }));
                  setLoadedFrom((prev) => ({ ...prev, [f.key]: from }));
                }}
              />
            ) : f.toggle ? (
              <Checkbox
                key={f.key}
                label={f.label}
                checked={values[f.key] === 'yes'}
                onChange={(on) => setValues((v) => ({ ...v, [f.key]: on ? 'yes' : '' }))}
              />
            ) : (
              <Input
                key={f.key}
                label={`${f.label}${fieldSuffix(f, form)}`}
                type={f.input === 'date' ? 'date' : f.secret ? 'password' : 'text'}
                placeholder={f.placeholder ?? (f.secret ? '••••••••' : '')}
                value={values[f.key] ?? ''}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                mono
              />
            ),
          )}
        {redirect && (
          <div>
            <Button variant="ghost" size="sm" onClick={() => setManual((m) => !m)}>
              {manual ? `Use the ${provider.name} consent flow instead` : 'Enter credentials manually'}
            </Button>
          </div>
        )}
        {err && <div style={{ fontSize: 12.5, color: 'var(--status-danger-fg)' }}>Couldn’t save — {err}</div>}
      </div>
    </Dialog>
  );
}

/**
 * #3281: what the form starts with. A choice starts on the method the connection holds — the first
 * whose `heldWhen` names a key of its stored credential's summary — and otherwise on its first
 * option, so a save that corrects one field never changes how the connection signs in.
 */
function initialValues(fields: ProviderField[], held: string[] | undefined): Record<string, string> {
  return Object.fromEntries(
    fields.flatMap((f) => {
      const choice = f.choices?.find((c) => c.heldWhen?.some((k) => held?.includes(k))) ?? f.choices?.[0];
      return choice ? [[f.key, choice.value]] : [];
    }),
  );
}

/** Shown, and sent, only while its choice holds one of the values that show it. */
function fieldShown(f: ProviderField, values: Record<string, string>): boolean {
  return !f.showWhen || f.showWhen.values.includes(values[f.showWhen.field] ?? '');
}

/** What the dialog's requirement rules read: the form, and the connection it was opened on. */
interface FormState {
  values: Record<string, string>;
  rotate: boolean;
  /** The stored credential's summary keys, when the dialog was opened on a connection. */
  held?: string[];
  fields: ProviderField[];
}

/**
 * Whether the dialog holds Connect until the field is filled. A `requiredWhen` field (a client
 * secret, the owner's own key and certificate) is required, except when rotating a connection that
 * holds the chosen method already: left empty there, the connector keeps what it holds. A pair of
 * files is replaced whole, so once one of them is given, the other is required too.
 */
function fieldRequired(f: ProviderField, form: FormState): boolean {
  if (!fieldShown(f, form.values) || f.toggle || f.choices) return false;
  if (!f.optional) return true;
  if (!f.showWhen) return false;
  const chosen = form.values[f.showWhen.field] ?? '';
  if (!(f.requiredWhen ?? []).includes(chosen)) return false;
  if (!keepsChosen(f.showWhen.field, chosen, form)) return true;
  return f.file !== undefined && form.fields.some(
    (g) => g.file && g.showWhen?.field === f.showWhen!.field && (g.requiredWhen ?? []).includes(chosen) && (form.values[g.key] ?? '').trim() !== '',
  );
}

/** Is the dialog rotating a connection that already signs in the chosen way, so empty keeps it? */
function keepsChosen(choiceField: string, chosen: string, form: FormState): boolean {
  if (!form.rotate) return false;
  const choice = form.fields.find((g) => g.key === choiceField)?.choices?.find((c) => c.value === chosen);
  return choice?.heldWhen?.some((k) => form.held?.includes(k)) ?? false;
}

/** What follows a field's label: nothing when required, what empty means otherwise. */
function fieldSuffix(f: ProviderField, form: FormState): string {
  if (fieldRequired(f, form)) return '';
  return f.requiredWhen && f.showWhen && keepsChosen(f.showWhen.field, form.values[f.showWhen.field] ?? '', form)
    ? ' (empty keeps the one stored)'
    : ' (optional)';
}

/** #3281: one choice between alternatives — Microsoft 365's sign-in method — and what it means. */
function ChoiceField({
  field,
  rotate,
  value,
  onChange,
}: {
  field: ProviderField;
  rotate: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const hint = field.choices?.find((c) => c.value === value)?.hint;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <RadioGroup
        label={field.label}
        options={(field.choices ?? []).map((c) => ({ value: c.value, label: c.label }))}
        value={value}
        onChange={onChange}
      />
      {hint && (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {hint}
          {rotate ? ' Fields left empty keep what the connection holds.' : ''}
        </div>
      )}
    </div>
  );
}

/** The largest file read: a key or a certificate is a few KB; the connector refuses past 64 KB too. */
const MAX_FILE_BYTES = 64 * 1024;

/**
 * #3281: a value read from a file in the browser, or pasted. A text file (PEM) is sent as its
 * text; a binary one (a DER `.cer`) as the base64 of its bytes, which the connector reads as DER.
 * A secret read from a file is never drawn: the field says which file it came from, nothing more.
 */
function FileField({
  field,
  suffix,
  value,
  loaded,
  onReading,
  onChange,
}: {
  field: ProviderField;
  /** What follows the label: nothing when required, what empty means otherwise. */
  suffix: string;
  value: string;
  /** The file the value was read from, held by the dialog so it outlives this field; null when typed or pasted. */
  loaded: string | null;
  /** Whether a file is being read for this field, so the dialog can hold Connect until it is. */
  onReading: (reading: boolean) => void;
  onChange: (value: string, loadedFrom: string | null) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The current read. Every pick, paste, clear and unmount starts a new one, so a slow read that
   * finishes after a newer choice is dropped instead of overwriting it.
   */
  const attempt = useRef(0);
  const supersede = () => {
    attempt.current += 1;
    onReading(false);
  };
  // Hidden by another method: a read still running must neither land nor hold Connect.
  useEffect(() => () => supersede(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const read = async (file: File | undefined) => {
    setProblem(null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setProblem(`${file.name} is larger than 64 KB — that is not one key or certificate.`);
      return;
    }
    const mine = ++attempt.current;
    onReading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (mine === attempt.current) onChange(fileValue(bytes), file.name);
    } catch {
      if (mine === attempt.current) setProblem(`${file.name} could not be read — choose it again, or paste its contents below.`);
    } finally {
      if (mine === attempt.current) onReading(false);
    }
  };
  const clear = () => {
    supersede();
    setProblem(null);
    onChange('', null);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
        {field.label}
        {suffix}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ fontSize: 12, cursor: 'pointer' }}>
          <input
            type="file"
            aria-label={`${field.label}: choose a file`}
            accept={field.file?.accept}
            style={{ fontSize: 12 }}
            onChange={(e) => {
              void read(e.target.files?.[0]);
              // The same file chosen again after Clear still fires.
              e.target.value = '';
            }}
          />
        </label>
        {loaded && (
          <>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Read from {loaded}</span>
            <Button variant="ghost" size="sm" onClick={clear}>
              Clear
            </Button>
          </>
        )}
      </div>
      {!loaded && (
        <Textarea
          ariaLabel={`${field.label} — or paste it here`}
          placeholder={`…or paste it here: ${field.placeholder ?? ''}`}
          rows={3}
          mono
          spellCheck={false}
          value={value}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
            supersede();
            setProblem(null);
            onChange(e.target.value, null);
          }}
        />
      )}
      {field.secret && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          Read in your browser and sent once to be sealed with the connection; it is never shown again. Once the
          connection works, delete your local copy.
        </div>
      )}
      {problem && <div style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{problem}</div>}
    </div>
  );
}

/** A file's bytes as the value the connector reads: PEM as text, anything else as base64. */
function fileValue(bytes: Uint8Array): string {
  let text: string | null = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = null;
  }
  if (text !== null && text.includes('-----BEGIN')) return text;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * What one connection of a fleet provider is called: a company where a consent round connects it
 * (Fortnox, #1267), an account where a pasted key does and the platform tells accounts apart by
 * what the provider says about the key (Stripe, #3211).
 */
function fleetUnit(provider: { connectFlow?: 'redirect' | null }): { one: string; many: string } {
  return provider.connectFlow === 'redirect' ? { one: 'company', many: 'companies' } : { one: 'account', many: 'accounts' };
}

/**
 * A fleet provider's connections on one app (#1267) — one row per connected company, each
 * addressed by its own id, so Details and Disconnect act on that company and no other.
 */
function FleetRows({
  provider,
  onDetail,
  onDisconnect,
}: {
  provider: AppIntegration;
  onDetail: (c: ConnectionView) => void;
  onDisconnect: (c: ConnectionView) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
      {provider.connections.map((c) => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
          <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, flexWrap: 'wrap' }}>
              <Pill kind={STATUS[c.status].kind}>{STATUS[c.status].label}</Pill>
              <span style={{ color: 'var(--text-primary)' }}>{c.label}</span>
              {c.externalAccountRef && <MonoTag>{c.externalAccountRef}</MonoTag>}
              {c.ownerScopeId && <Pill kind="info">This app's own</Pill>}
            </div>
            <HealthLine conn={c} />
          </div>
          <Button variant="ghost" size="sm" onClick={() => onDetail(c)}>
            Details
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onDisconnect(c)}>
            Disconnect
          </Button>
        </div>
      ))}
    </div>
  );
}

/** The per-app Settings → Integrations tab. */
export function AppIntegrations({ teamId, app }: { teamId: string; app: AppRow }) {
  const [view, setView] = useState<AppIntegration[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ provider: AppIntegration; rotate: boolean; held?: string[] } | null>(null);
  const [detail, setDetail] = useState<{ provider: AppIntegration; connection: ConnectionView } | null>(null);
  /**
   * `addressed` disconnects that one row by id (a fleet's company); otherwise the
   * provider's single connection, through the un-addressed route as before.
   */
  const [disconnect, setDisconnect] = useState<{ provider: AppIntegration; connection: ConnectionView; addressed: boolean } | null>(null);
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
    teamApi(teamId)
      .getAppIntegrations({ scopeId: app.app_scope_id })
      .then((v) => live && setView((v as unknown as AppIntegrationsView).providers))
      .catch((e) => live && setErr(isApiError(e) ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [teamId, app.app_scope_id, nonce]);

  if (err) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load integrations — {err}</div>;
  if (!view) return <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading integrations…</div>;

  const confirmDisconnect = async () => {
    if (!disconnect || busy) return;
    setBusy(true);
    try {
      const input = { scopeId: app.app_scope_id, provider: disconnect.provider.provider };
      if (disconnect.addressed) await teamApi(teamId).disconnectAppConnection({ ...input, connectionId: disconnect.connection.id });
      else await teamApi(teamId).disconnectAppIntegration(input);
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
      <div className="m-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
        {view.map((p) => {
          if (p.multiAccount) {
            const n = p.connections.length;
            const unit = fleetUnit(p);
            const unhealthy = p.connections.filter((c) => c.status !== 'active').length;
            const s: { kind: PillKind; label: string } =
              n === 0
                ? { kind: 'neutral', label: 'Not connected' }
                : {
                    kind: unhealthy > 0 ? 'warning' : 'success',
                    label: `${n} ${n === 1 ? unit.one : unit.many}${unhealthy > 0 ? ` · ${unhealthy} need${unhealthy === 1 ? 's' : ''} attention` : ''}`,
                  };
            return (
              // Full width: a bureau's fleet is a list, and it grows one client at a time.
              <div key={p.provider} style={{ ...card, padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start', gridColumn: '1 / -1' }}>
                <Monogram text={p.monogram} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</span>
                    <Pill kind={s.kind}>{s.label}</Pill>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{p.description}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                    {p.connectFlow === 'redirect'
                      ? `One connection per ${p.name} company. Each connect link connects one company; mint another for the next.`
                      : `One connection per ${p.name} account. A credential for another account adds one; a credential for a connected account replaces its credential.`}
                  </div>
                  {n === 0 && p.required && (
                    <div style={{ fontSize: 11.5, color: 'var(--status-warning-fg)' }}>
                      Required by this app — work for {unit.one === 'company' ? 'a company' : 'an account'} waits until that{' '}
                      {unit.one} is connected, then delivers.
                    </div>
                  )}
                  <FleetRows
                    provider={p}
                    onDetail={(c) => setDetail({ provider: p, connection: c })}
                    onDisconnect={(c) => setDisconnect({ provider: p, connection: c, addressed: true })}
                  />
                </div>
                <Button variant="secondary" size="sm" onClick={() => setDialog({ provider: p, rotate: false })}>
                  {n === 0 ? `Connect ${unit.one === 'company' ? 'a company' : 'an account'}` : `Connect another ${unit.one}`}
                </Button>
              </div>
            );
          }
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
                  onClick={() =>
                    p.connection ? setDetail({ provider: p, connection: p.connection }) : setDialog({ provider: p, rotate: false })
                  }
                >
                  {p.connection ? 'Details' : 'Connect'}
                </Button>
                {p.connection && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDisconnect({ provider: p, connection: p.connection!, addressed: false })}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <MailInCard teamId={teamId} app={app} />

      {dialog && (
        <ConnectDialog
          teamId={teamId}
          scopeId={app.app_scope_id}
          provider={dialog.provider}
          rotate={dialog.rotate}
          held={dialog.held}
          onDone={() => {
            setDialog(null);
            setNonce((n) => n + 1);
          }}
          onClose={() => setDialog(null)}
        />
      )}

      {detail && (
        <IntegrationDetail
          teamId={teamId}
          provider={detail.provider}
          scopeId={app.app_scope_id}
          connection={detail.connection}
          onRotate={(held) => {
            // From a fleet row this is a re-consent for that same company.
            setDialog({ provider: detail.provider, rotate: true, held });
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
        title={disconnect ? (disconnect.addressed ? `Disconnect ${disconnect.connection.label}` : `Disconnect ${disconnect.provider.name}`) : ''}
        confirmLabel={busy ? 'Disconnecting…' : 'Disconnect'}
        danger
        onCancel={() => setDisconnect(null)}
        onConfirm={confirmDisconnect}
      >
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          {disconnect?.addressed ? (
            <>
              {disconnect.connection.label}
              {disconnect.connection.externalAccountRef ? ` (${disconnect.connection.externalAccountRef})` : ''} loses its{' '}
              {disconnect.provider.name} connection: the stored credential is deleted and every grant it carried is revoked —
              this cannot be undone. Every other connected {fleetUnit(disconnect.provider).one} is unaffected. Deliveries
              already queued for this {fleetUnit(disconnect.provider).one} stay queued and resume if it is connected again.
              Other apps of the same kind share this connection and lose it too.
            </>
          ) : (
            'The stored credential is deleted and every grant it carried is revoked — this cannot be undone. Deliveries already queued stay queued and resume if you reconnect. Other apps of the same kind share this connection and lose it too.'
          )}
        </div>
      </Dialog>
    </div>
  );
}

/** The account-level Integrations page: every provider, every connection, every app that can connect one. */
export function Integrations({ teamId }: { teamId: string }) {
  const [view, setView] = useState<AccountIntegration[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<AccountIntegration | null>(null);
  /**
   * #3281: set when the dialog rotates a connection opened in Details — its app, and its stored
   * credential's summary keys, so the dialog starts on its method and keeps what is left empty.
   * Unset for Connect, which is a new connection.
   */
  const [rotation, setRotation] = useState<{ scopeId: string; held: string[] } | null>(null);
  const openConnect = (p: AccountIntegration) => {
    setRotation(null);
    setDialog(p);
  };
  const [detail, setDetail] = useState<{ provider: AccountIntegration; scopeId: string; connection: ConnectionView } | null>(null);
  // Addressed by the connection's own id at the team's door, which needs no serving app: a
  // connection can outlive every app it served, and the page lists it all the same.
  const [disconnect, setDisconnect] = useState<{
    provider: AccountIntegration;
    connection: AccountIntegration['connections'][number];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnectErr, setDisconnectErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const confirmDisconnect = async () => {
    if (!disconnect || busy) return;
    const id = disconnect.connection.id;
    setBusy(true);
    setDisconnectErr(null);
    let failure: string | null = null;
    try {
      await teamApi(teamId).disconnectTeamConnection({ connectionId: id });
    } catch (e) {
      failure = e instanceof TeamApiError ? e.message : String(e);
    }
    if (failure !== null) {
      // The plane may have revoked it before its answer was lost, so a failed request is a
      // failure only while the row is still live. Unreadable counts as still live: say so and
      // let the person retry, rather than close on a guess.
      const stillLive = await api
        .integrations(teamId)
        .then((v) => v.providers.some((p) => p.connections.some((c) => c.id === id)))
        .catch(() => true);
      if (stillLive) {
        setBusy(false);
        setDisconnectErr(failure);
        return;
      }
    }
    setBusy(false);
    setDisconnect(null);
    setNonce((n) => n + 1);
  };

  useEffect(() => {
    if (DEV_MOCK) {
      setView(MOCK_ACCOUNT_INTEGRATIONS.providers);
      return;
    }
    let live = true;
    setView(null);
    setErr(null);
    api
      .integrations(teamId)
      .then((v) => live && setView(v.providers))
      .catch((e) => live && setErr(isApiError(e) ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [teamId, nonce]);

  return (
    <Page>
      <PageTitle
        title="Integrations"
        subtitle="Connections your apps can use. Credentials are stored sealed; a secret is never shown again, only recognised by its last four characters."
      />
      {err && <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--status-danger-fg)' }}>Couldn’t load integrations — {err}</div>}
      {!err && !view && <div style={{ ...card, padding: 20, fontSize: 13, color: 'var(--text-tertiary)' }}>Loading integrations…</div>}
      {view && (
        <div className="m-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          {view.map((p, i) => {
            const connected = p.connections.length > 0;
            // A vertical-defined provider no vertical declares any more: no form to connect or
            // rotate with, and nothing to inspect — the one thing left is withdrawing it.
            const formless = p.fields.length === 0;
            return (
              <div key={`${p.provider}:${i}`} style={{ ...card, padding: 16, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <Monogram text={p.monogram} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{p.name}</span>
                    <Pill kind={connected ? 'success' : 'neutral'}>{connected ? 'Connected' : 'Not connected'}</Pill>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{p.description}</div>
                  {p.connections.map((c) => (
                    <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
                        <Pill kind={STATUS[c.status].kind}>{STATUS[c.status].label}</Pill>
                        <span style={{ color: 'var(--text-primary)' }}>{c.label}</span>
                        <span style={{ color: 'var(--text-tertiary)' }}>
                          used by {c.apps.length > 0 ? c.apps.map((a) => a.name).join(', ') : c.vertical}
                        </span>
                        {/* Detail is per-APP because the routes are: a connection is keyed to a
                            vertical, and any app of that vertical is a valid door to it. */}
                        {c.apps[0] && !formless && (
                          <Button variant="ghost" size="sm" onClick={() => setDetail({ provider: p, scopeId: c.apps[0]!.scopeId, connection: c })}>
                            Details
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => {
                            setDisconnectErr(null);
                            setDisconnect({ provider: p, connection: c });
                          }}>
                          Disconnect
                        </Button>
                      </div>
                      <HealthLine conn={c} />
                      <SweepStrip runs={c.sweepRuns ?? []} skippedNote="nothing polls this connection" />
                    </div>
                  ))}
                  {p.connectTargets.length === 0 && !connected && (
                    <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>No installed app declares this integration yet.</div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                  {/* Manage used to open the empty connect form, which read as "your
                      credentials are gone". A connected provider opens its detail; the
                      rotate form is one click further in, where replacing a credential
                      belongs. A formless card has neither: its rows' Disconnect is all. */}
                  {!formless && <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const first = p.connections[0];
                      const scope = first?.apps[0]?.scopeId ?? p.connectTargets.find((t) => t.connected)?.scopeId;
                      if (first && scope) setDetail({ provider: p, scopeId: scope, connection: first });
                      else openConnect(p);
                    }}
                    disabled={p.connectTargets.length === 0 && !connected}
                  >
                    {connected ? 'Manage' : 'Connect'}
                  </Button>}
                  {/* A fleet provider (#1267) keeps growing: Manage opens one company, so
                      adding the next one needs its own door. */}
                  {p.multiAccount && connected && p.connectTargets.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => openConnect(p)}>
                      Connect another
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {detail && (
        <IntegrationDetail
          teamId={teamId}
          provider={detail.provider}
          scopeId={detail.scopeId}
          connection={detail.connection}
          onRotate={(keys) => {
            setRotation({ scopeId: detail.scopeId, held: keys });
            setDialog(detail.provider);
            setDetail(null);
          }}
          onClose={() => {
            setDetail(null);
            setNonce((n) => n + 1);
          }}
        />
      )}

      <Dialog
        open={!!disconnect}
        title={disconnect ? `Disconnect ${disconnect.connection.label}` : ''}
        confirmLabel={busy ? 'Disconnecting…' : disconnectErr ? 'Try again' : 'Disconnect'}
        danger
        busy={busy}
        onCancel={() => {
          setDisconnect(null);
          setDisconnectErr(null);
        }}
        onConfirm={confirmDisconnect}
      >
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          {disconnectErr && (
            <div style={{ color: 'var(--status-danger-fg)', marginBottom: 8 }}>
              Couldn’t disconnect — the connection is still live: {disconnectErr}
            </div>
          )}
          {disconnect && (
            <>
              The stored {disconnect.provider.name} credential is deleted and every grant it carried is revoked — this cannot
              be undone.{' '}
              {disconnect.connection.apps.length > 0
                ? `Every app it serves loses it (${disconnect.connection.apps.map((a) => a.name).join(', ')}).`
                : 'No app of this team uses it any more.'}{' '}
              Deliveries already queued stay queued and resume if it is connected again.
            </>
          )}
        </div>
      </Dialog>

      {dialog && (
        <ConnectDialog
          teamId={teamId}
          provider={dialog}
          rotate={rotation !== null}
          held={rotation?.held}
          // A rotation is of the connection it was opened on; a new connection picks its app.
          {...(rotation ? { scopeId: rotation.scopeId } : { pickTarget: dialog.connectTargets })}
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

/** The client secret's end the stored credential's summary names (`YYYY-MM-DD`), if it names one. */
function clientSecretEnd(credential: ConnectionActivityView['credential']): string | undefined {
  const v = credential.find((f) => f.key === 'clientSecretExpiresAt')?.value;
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : undefined;
}

/** How far ahead an end nothing renews is warned of — the platform's own rotation window. */
const EXPIRY_WARNING_DAYS = 30;

/** #3281: what to do before an end the platform does not renew, by what ends. */
const RENEW = {
  certificate:
    'Before then, generate a new pair, have its certificate uploaded to the app registration, and rotate this connection with it under "Your own certificate" — or rotate to "Platform-generated certificate", which keeps yours signing until Entra accepts the new one.',
  'client secret':
    'Before then, create a new one under Certificates & secrets → Client secrets → New, and rotate this connection with it and its new end date. Delete the old one from the app registration once the connection works.',
} as const;

/**
 * #3281: the end of a credential the platform does not renew — a certificate the owner supplied,
 * or a client secret whose end they gave. From 30 days out it is a warning saying what to do;
 * until then, a line saying it.
 */
function ExpiryNotice({ notAfter, subject }: { notAfter: string; subject: keyof typeof RENEW }) {
  const days = Math.floor((Date.parse(notAfter) - Date.now()) / 86_400_000);
  const what = RENEW[subject];
  if (days > EXPIRY_WARNING_DAYS) {
    return <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{what}</div>;
  }
  return (
    <div style={{ ...card, padding: 10, marginTop: 8, borderColor: 'var(--status-warning-fg)', fontSize: 12, color: 'var(--text-secondary)' }}>
      <div style={{ color: 'var(--status-warning-fg)', marginBottom: 4 }}>
        {days < 0
          ? `Your ${subject} expired on ${notAfter.slice(0, 10)} — this connection cannot sign in.`
          : `Your ${subject} expires on ${notAfter.slice(0, 10)}, in ${days} day${days === 1 ? '' : 's'}.`}
      </div>
      {what}
    </div>
  );
}

/** One public certificate: its thumbprint and end, a download when it is ours to hand out, and what to do with it. */
function CertificateCard({
  title,
  certificate,
  download,
  note,
}: {
  title: string;
  certificate: CertificateView;
  /** Absent for a certificate the owner supplied: they hold it already. */
  download?: { label: string; filename: string };
  note: string;
}) {
  return (
    <>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', fontSize: 12 }}>
        <span style={{ color: 'var(--text-tertiary)' }}>Thumbprint</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
          {certificate.thumbprint}
        </span>
        <span style={{ color: 'var(--text-tertiary)' }}>Expires</span>
        <span style={{ color: 'var(--text-secondary)' }}>{certificate.notAfter.slice(0, 10)}</span>
      </div>
      {download && (
        <div style={{ marginTop: 6 }}>
          <Button variant="secondary" size="sm" onClick={() => downloadCertificate(certificate.pem, download.filename)}>
            {download.label}
          </Button>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{note}</div>
    </>
  );
}

/** Save a PEM certificate as a `.cer` file — Entra's upload accepts PEM under that name. */
function downloadCertificate(pem: string, provider: string): void {
  const url = URL.createObjectURL(new Blob([pem], { type: 'application/x-x509-ca-cert' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `substrat-${provider}.cer`;
  a.click();
  // Some browsers start the download after `click()` returns; revoking now can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
