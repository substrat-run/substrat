import { useState } from 'react';
import { Button, Dialog, Input, Select } from '@substrat-run/ui';
import { ROLE_MATRIX } from '../lib/demo';
import type { InviteRole, Member } from '../lib/api';
import { Ic } from '../lib/icons';
import { Avatar } from '../components/DashShell';
import { Page } from '../components/layout';
import { card, MonoTag, PageTitle, Pill } from '../components/ui';

const COLS = '2.4fr 1fr 1fr 1fr 140px';
const STATUS: Record<Member['status'], { kind: 'success' | 'warning' | 'neutral'; label: string }> = {
  active: { kind: 'success', label: 'Active' },
  invited: { kind: 'warning', label: 'Invited' },
  revoked: { kind: 'neutral', label: 'Revoked' },
};
const ROLE_OPTS: { value: InviteRole; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
];
const AVATAR_TONE: Record<string, 'brand' | 'cyan' | 'amber' | 'muted'> = {
  owner: 'brand',
  admin: 'cyan',
  member: 'amber',
  viewer: 'muted',
};

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso;
  }
}

/**
 * Team roster + invite. The roster is the dashboard's own projection (there is no
 * kernel "who holds a role here" query); an invite composes the invites engine and,
 * on accept, becomes a kernel role assignment. Email delivery is a later connector,
 * so an invite hands back a shareable link.
 */
export function Team({
  members,
  meEmail,
  canManage,
  onInvite,
  onResend,
  onRevoke,
  onRemove,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  members: Member[];
  meEmail: string;
  canManage: boolean;
  onInvite: (email: string, roleKey: InviteRole) => Promise<{ acceptUrl: string } | void>;
  onResend: (invitationId: string) => void;
  onRevoke: (invitationId: string) => void;
  onRemove: (memberId: string) => void;
  /** Older roster rows exist beyond the loaded page window (a non-null nextCursor). */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}) {
  const [invite, setInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [sending, setSending] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);

  const rows = members.filter((m) => m.status !== 'revoked');

  const reset = () => {
    setInvite(false);
    setEmail('');
    setRole('member');
    setLink(null);
    setCopied(false);
  };
  const send = async () => {
    if (!email.trim() || sending) return;
    setSending(true);
    try {
      const res = await onInvite(email.trim(), role);
      if (res && 'acceptUrl' in res) setLink(res.acceptUrl);
      else reset();
    } finally {
      setSending(false);
    }
  };

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
        <PageTitle title="Team" subtitle="An invitation is a grant — accepted invites become a role at the tenant, in the audit log." />
        <div style={{ flex: 1 }} />
        {canManage && <Button icon={<Ic name="plus" />} onClick={() => setInvite(true)}>Invite</Button>}
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
          <span>Member</span><span>Role</span><span>Status</span><span>Added</span><span />
        </div>
        {rows.length === 0 && (
          <div style={{ padding: '20px 16px', fontSize: 13, color: 'var(--text-tertiary)' }}>No members yet.</div>
        )}
        {rows.map((m, i) => {
          const s = STATUS[m.status];
          const you = m.email === meEmail;
          const name = m.email.split('@')[0] ?? m.email;
          return (
            <div key={m.id} style={{ display: 'grid', gridTemplateColumns: COLS, alignItems: 'center', height: 48, padding: '0 16px', fontSize: 13, borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar seed={name} tone={AVATAR_TONE[m.role_key] ?? 'muted'} size={26} />
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{name} {you && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 400 }}>(you)</span>}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>{m.email}</span>
                </span>
              </span>
              <span><MonoTag>{m.role_key}</MonoTag></span>
              <span><Pill kind={s.kind}>{s.label}</Pill></span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{fmtDate(m.joined_at ?? m.invited_at)}</span>
              <span style={{ textAlign: 'right' }}>
                {canManage && m.status === 'invited' && m.invitation_id && (
                  <span style={{ display: 'inline-flex', gap: 4, justifyContent: 'flex-end' }}>
                    <button
                      type="button"
                      onClick={() => onResend(m.invitation_id!)}
                      style={{ border: 0, background: 'transparent', color: 'var(--text-secondary)', fontSize: 12.5, cursor: 'pointer', padding: 4 }}
                    >
                      Resend
                    </button>
                    <button
                      type="button"
                      onClick={() => onRevoke(m.invitation_id!)}
                      style={{ border: 0, background: 'transparent', color: 'var(--status-danger-fg)', fontSize: 12.5, cursor: 'pointer', padding: 4 }}
                    >
                      Revoke
                    </button>
                  </span>
                )}
                {canManage && m.status === 'active' && m.role_key !== 'owner' && !you && (
                  <button
                    type="button"
                    onClick={() => onRemove(m.id)}
                    style={{ border: 0, background: 'transparent', color: 'var(--status-danger-fg)', fontSize: 12.5, cursor: 'pointer', padding: 4 }}
                  >
                    Remove
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {hasMore && onLoadMore && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 16px', borderTop: '1px solid var(--border-subtle)' }}>
            <Button variant="secondary" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <div onClick={() => setMatrixOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: matrixOpen ? '1px solid var(--border-subtle)' : 'none', cursor: 'pointer' }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Roles &amp; permissions</span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>what each role can do — mirrors PERMISSIONS.md</span>
          <div style={{ flex: 1 }} />
          <span style={{ display: 'inline-flex', transform: matrixOpen ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms' }}><Ic name="chevronDown" size={14} color="var(--text-tertiary)" /></span>
        </div>
        {matrixOpen && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '2.4fr 1fr 1fr 1fr 1fr', alignItems: 'center', height: 36, padding: '0 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-subtle)' }}>
              <span>Permission</span><span>Owner</span><span>Admin</span><span>Member</span><span>Viewer</span>
            </div>
            {ROLE_MATRIX.map((p, i) => (
              <div key={p.label} style={{ display: 'grid', gridTemplateColumns: '2.4fr 1fr 1fr 1fr 1fr', alignItems: 'center', height: 40, padding: '0 16px', fontSize: 13, color: 'var(--text-primary)', borderBottom: i === ROLE_MATRIX.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}>
                <span>{p.label}</span>
                {[p.owner, p.admin, p.member, p.viewer].map((v, j) => (
                  <span key={j} style={{ color: v ? 'var(--status-success-fg)' : 'var(--text-placeholder)' }}>{v ? '✓' : '—'}</span>
                ))}
              </div>
            ))}
          </>
        )}
      </div>

      <Dialog
        open={invite}
        title="Invite to your team"
        confirmLabel={link ? 'Done' : sending ? 'Sending…' : 'Create invite'}
        cancelLabel={link ? 'Invite another' : 'Cancel'}
        confirmDisabled={!link && (!email.trim() || sending)}
        onConfirm={() => (link ? reset() : void send())}
        onCancel={() => (link ? (setLink(null), setEmail(''), setCopied(false)) : reset())}
        width={480}
      >
        {link ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              Invite created. Email delivery is coming — for now, share this link with them:
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input value={link} mono style={{ flex: 1 }} onChange={() => {}} />
              <Button
                variant="secondary"
                onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); }}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              The link works only for the invited email, and expires in 14 days.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Input label="Email address" placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Select label="Role" options={ROLE_OPTS} value={role} onChange={(e) => setRole(e.target.value as InviteRole)} style={{ width: 220 }} />
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                You can only grant a role whose permissions you already hold.
              </div>
            </div>
          </div>
        )}
      </Dialog>
    </Page>
  );
}
