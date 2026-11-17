import { useEffect, useState } from 'react';
import { Button, Dialog, Textarea } from '@substrat-run/ui/wa';
import { teamApi, isApiError, type AppRow } from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { card, MonoTag, Pill } from '../components/ui';
import { relativeTime } from '../lib/format';

/**
 * An app's mail-in address (#2611), on its Settings → Integrations tab: the address people forward
 * mail to so it lands in the app, with what it has received, who may send to it, and the three acts
 * — get one, replace it, turn it off. Shown only for an app whose vertical declares a mail-in
 * landing (or that still holds an address), and only to someone who may manage integrations: the
 * address is a capability, so reading it is gated like changing it.
 */

type Standing = Awaited<ReturnType<ReturnType<typeof teamApi>['getAppMailIn']>>;
type Address = NonNullable<Standing['address']>;

const MOCK_STANDING: Standing = {
  address: {
    address: 'mail+books-k3m7q2xw9cdj4hpa@in.substrat.run',
    connectionId: '01JZ00000000000000000000MA',
    tenantId: '01JZ00000000000000000000TN',
    scopeId: '01JZ00000000000000000000SC',
    vertical: 'books',
    operation: 'books/receive-mail',
    permission: 'books:receive-mail',
    allowlist: ['@supplier.example'],
    createdAt: '2026-11-10T09:00:00.000Z',
    createdBy: '01JZ00000000000000000000PR',
    stats: { received: 14, delivered: 13, rejected: 2, deadLettered: 0, pending: 1, lastReceivedAt: '2026-11-17T08:12:00.000Z', lastRejectedAt: '2026-11-16T15:40:00.000Z', lastRejectReason: 'sender-not-allowed' },
  },
  landing: { operation: 'books/receive-mail', permission: 'books:receive-mail' },
  receiving: true,
};

/** What a refusal reason means to the person reading the card. */
const REJECT_REASON: Record<string, string> = {
  'too-large': 'over 25 MiB',
  'sender-not-allowed': 'a sender not on the list',
  'sender-unverified': 'a sender that could not be verified',
  malformed: 'a malformed message',
  'rate-limited': 'over the hourly limit',
  'over-daily-volume': 'over the daily volume',
};

type Confirm = 'rotate' | 'revoke' | null;

export function MailInCard({ teamId, app }: { teamId: string; app: AppRow }) {
  const [standing, setStanding] = useState<Standing | null>(null);
  const [hidden, setHidden] = useState(false);
  /** The standing could not be read. Cleared by the next read. */
  const [loadErr, setLoadErr] = useState<string | null>(null);
  /** The last act failed. Kept across the read that follows it, until the next act or a cancel. */
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [senders, setSenders] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (DEV_MOCK) {
      setStanding(MOCK_STANDING);
      return;
    }
    let live = true;
    setLoadErr(null);
    teamApi(teamId)
      .getAppMailIn({ scopeId: app.app_scope_id })
      .then((v) => live && setStanding(v))
      .catch((e) => {
        if (!live) return;
        // Someone who may not manage integrations sees no address, the same as on the other doors.
        if (isApiError(e) && e.status === 403) setHidden(true);
        else setLoadErr(isApiError(e) ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [teamId, app.app_scope_id, nonce]);

  const act = async (action: 'request' | 'rotate' | 'revoke', allowlist?: string[]) => {
    if (busy) return;
    setBusy(true);
    setActionErr(null);
    try {
      if (!DEV_MOCK) await teamApi(teamId).setAppMailIn({ scopeId: app.app_scope_id, action, ...(allowlist ? { allowlist } : {}) });
      setConfirm(null);
      setSenders(null);
    } catch (e) {
      // Shown in the dialog that is still open, or on the card when the act had none.
      setActionErr(isApiError(e) ? e.message : String(e));
    }
    setBusy(false);
    // Read again either way: a refused act may still mean the address changed under us.
    setNonce((n) => n + 1);
  };
  const dismiss = () => {
    setConfirm(null);
    setSenders(null);
    setActionErr(null);
  };

  if (hidden) return null;
  if (!standing) {
    // A read that failed is shown, with a way to try again; only a successful read hides the card.
    if (!loadErr) return null;
    return (
      <div style={{ ...card, padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div role="alert" style={{ flex: 1, fontSize: 13, color: 'var(--status-danger-fg)' }}>
          Couldn’t load inbound email — {loadErr}
        </div>
        <Button variant="secondary" size="sm" onClick={() => setNonce((n) => n + 1)}>
          Retry
        </Button>
      </div>
    );
  }
  const { address, landing, receiving } = standing;
  if (!address && !landing) return null;

  const copy = async () => {
    if (!address) return;
    await navigator.clipboard?.writeText(address.address).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Inbound email</span>
        <Pill kind={address ? 'success' : 'neutral'}>{address ? 'Receiving' : 'No address'}</Pill>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        An address you forward mail to — a supplier’s invoice, a signed form — so it lands in this app, with its attachments
        stored as files. Nothing else reaches it: it delivers into this app only.
      </div>
      {!receiving && (
        <div style={{ fontSize: 12, color: 'var(--status-warning-fg)' }}>Inbound email is not switched on for this platform yet.</div>
      )}
      {!address && landing && (
        <div>
          <Button variant="secondary" size="sm" disabled={busy || !receiving} onClick={() => act('request')}>
            {busy ? 'Getting an address…' : 'Get an address'}
          </Button>
        </div>
      )}
      {address && <AddressBody address={address} copied={copied} onCopy={copy} />}
      {address && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Button variant="secondary" size="sm" disabled={busy || !landing} onClick={() => setSenders(address.allowlist.join('\n'))}>
            Who may send
          </Button>
          <Button variant="secondary" size="sm" disabled={busy || !landing} onClick={() => setConfirm('rotate')}>
            Replace address
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm('revoke')}>
            Turn off
          </Button>
        </div>
      )}
      {address && !landing && (
        <div style={{ fontSize: 11.5, color: 'var(--status-warning-fg)' }}>
          The running version of this app no longer declares where mail lands. Turn the address off, or deploy a version that
          declares it.
        </div>
      )}
      {loadErr && <div role="alert" style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>Couldn’t refresh — {loadErr}</div>}
      {actionErr && senders === null && confirm === null && (
        <div role="alert" style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{actionErr}</div>
      )}

      <Dialog
        open={senders !== null}
        title="Who may send to this address"
        confirmLabel={busy ? 'Saving…' : 'Save'}
        onCancel={dismiss}
        onConfirm={() =>
          act(
            'request',
            (senders ?? '')
              .split(/[\s,]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          <div>
            One per line: a whole address, or <code>@domain</code> for anyone there. Leave it empty and anyone whose mail passes
            its domain’s checks can send. With a list, the sender must also be proven — a name in the From line is not enough.
          </div>
          <Textarea ariaLabel="Allowed senders" mono rows={5} placeholder={'me@example.com\n@supplier.example'} value={senders ?? ''} onChange={(e) => setSenders(e.target.value)} />
          {actionErr && <div role="alert" style={{ color: 'var(--status-danger-fg)' }}>{actionErr}</div>}
        </div>
      </Dialog>

      <Dialog
        open={confirm !== null}
        title={confirm === 'revoke' ? 'Turn off this address' : 'Replace this address'}
        confirmLabel={busy ? 'Working…' : confirm === 'revoke' ? 'Turn off' : 'Replace'}
        danger={confirm === 'revoke'}
        onCancel={dismiss}
        onConfirm={() => confirm && act(confirm)}
      >
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          {confirm === 'revoke'
            ? 'Mail to this address is refused from now on, and mail it accepted but has not yet delivered is deleted. Everything already delivered stays in the app. Getting an address again gives a new one.'
            : 'You get a new address with the same senders list. Mail to the old one is refused from now on; mail it accepted but has not yet delivered moves to the new one. Use this if the address has leaked.'}
          {actionErr && <div role="alert" style={{ marginTop: 8, color: 'var(--status-danger-fg)' }}>{actionErr}</div>}
        </div>
      </Dialog>
    </div>
  );
}

function AddressBody({ address, copied, onCopy }: { address: Address; copied: boolean; onCopy: () => void }) {
  const s = address.stats;
  const counts: [string, number][] = [
    ['received', s.received],
    ['delivered', s.delivered],
    ['waiting', s.pending],
    ['refused', s.rejected],
    ['failed', s.deadLettered],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <MonoTag>{address.address}</MonoTag>
        <Button variant="ghost" size="sm" onClick={onCopy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
        {counts.map(([label, n]) => `${n} ${label}`).join(' · ')}
        {s.lastReceivedAt ? ` · last ${relativeTime(s.lastReceivedAt)}` : ''}
      </div>
      {s.deadLettered > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--status-danger-fg)' }}>
          {s.deadLettered === 1 ? 'One message' : `${s.deadLettered} messages`} could not be delivered after every retry and{' '}
          {s.deadLettered === 1 ? 'is' : 'are'} kept for the platform operator.
        </div>
      )}
      {s.lastRejectedAt && (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          Last refused {relativeTime(s.lastRejectedAt)}
          {s.lastRejectReason ? `: ${REJECT_REASON[s.lastRejectReason] ?? s.lastRejectReason}` : ''}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        {address.allowlist.length === 0
          ? 'Anyone may send, as long as their mail passes its domain’s checks.'
          : `Only ${address.allowlist.join(', ')} may send, and must be proven.`}
      </div>
    </div>
  );
}
