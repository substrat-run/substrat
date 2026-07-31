import { useEffect, useState } from 'react';
import { api, ApiError, type CreatedInvite, type InvitesResult } from './api';
import { Button, Card, ColHead, Empty, Mono } from './ui';

// Group C — Members & roles (per site) and the Asset library.

const ROLE_COLOR: Record<string, { fg: string; bg: string }> = {
  admin: { fg: 'var(--accent)', bg: 'var(--accent-soft)' },
  publisher: { fg: 'var(--st-published-fg)', bg: 'var(--st-published-bg)' },
  editor: { fg: 'var(--st-approved-fg)', bg: 'var(--st-approved-bg)' },
  author: { fg: 'var(--st-review-fg)', bg: 'var(--st-review-bg)' },
  viewer: { fg: 'var(--st-draft-fg)', bg: 'var(--st-draft-bg)' },
};
function RoleChip({ role }: { role?: string }) {
  if (!role) return <span style={{ color: 'var(--faint)', fontSize: 12 }}>—</span>;
  const c = ROLE_COLOR[role] ?? ROLE_COLOR.viewer;
  return <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 'var(--r-pill)', color: c.fg, background: c.bg }}>{role}</span>;
}

const RoleLadder = () => (
  <Card>
    <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 10 }}>The role ladder</div>
    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.8 }}>
      <li><strong>Author</strong> — drafts &amp; submits</li>
      <li><strong>Editor</strong> — + reviews</li>
      <li><strong>Publisher</strong> — + publishes</li>
      <li><strong>Admin</strong> — + manages members &amp; models</li>
      <li><strong>Viewer</strong> — read only</li>
    </ul>
  </Card>
);

export function MembersView(props: { meName: string; canAdmin: boolean }) {
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>Members &amp; roles</h1>
        <div style={{ color: 'var(--muted)', marginTop: 4 }}>Roles are held <strong>per site</strong> — the same login is a different authority in each scope (K-22).</div>
      </div>
      <InviteManager meName={props.meName} canAdmin={props.canAdmin} />
    </div>
  );
}

// ── Hosted: invite teammates ─────────────────────────────────────────────────

function InviteManager({ meName, canAdmin }: { meName: string; canAdmin: boolean }) {
  const [data, setData] = useState<InvitesResult | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('author');
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState('');

  const load = () => api.listInvites().then(setData).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  useEffect(() => { load(); }, []);

  const invite = async () => {
    setErr(''); setCreated(null); setCopied(false);
    try {
      const c = await api.createInvite(email.trim() || undefined, role);
      setCreated(c); setEmail(''); load();
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  };
  const revoke = async (principal: string) => { setErr(''); try { await api.revokeInvite(principal); load(); } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); } };

  const roles = data?.roles ?? ['viewer', 'author', 'editor', 'publisher', 'admin'];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 16 }}>
      <div>
        {err && <div style={{ padding: '10px 14px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 14 }}>{err}</div>}

        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 10 }}>Members</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent)', display: 'grid', placeItems: 'center', fontWeight: 700 }}>{(meName || 'Y')[0].toUpperCase()}</span>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 600, fontSize: 13.5 }}>{meName || 'You'}</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>you</div></div>
            <RoleChip role="admin" />
          </div>
        </Card>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--faint)', marginBottom: 10 }}>Invite a teammate</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input placeholder="email (optional)" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1, minWidth: 180, font: 'inherit', fontSize: 13.5, padding: '8px 10px', borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--ink)' }} />
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ font: 'inherit', fontSize: 13.5, padding: '8px 10px', borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--ink)' }}>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Button variant="primary" disabled={!canAdmin} title={canAdmin ? '' : 'Disabled: needs the admin permission.'} onClick={invite}>Create invite</Button>
          </div>
          {created && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 'var(--r-input)', background: 'var(--wash)' }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Share this link — it lets them join as <RoleChip role={created.roleKey} /></div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Mono style={{ flex: 1, wordBreak: 'break-all', fontSize: 11.5, color: 'var(--ink)' }}>{created.acceptUrl}</Mono>
                <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(created.acceptUrl); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</Button>
              </div>
            </div>
          )}
        </Card>

        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--faint)', padding: '12px 14px 6px' }}>Pending invites</div>
          {!data ? (
            <div style={{ padding: 14, color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
          ) : data.invites.length === 0 ? (
            <Empty title="No pending invites" hint="Invite a teammate above — they join by opening the link." />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><ColHead>Email</ColHead><ColHead>Role</ColHead><ColHead>{' '}</ColHead></tr></thead>
              <tbody>
                {data.invites.map((iv) => (
                  <tr key={iv.principal}>
                    <td style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>{iv.email ?? <span style={{ color: 'var(--faint)' }}>(link only)</span>}</td>
                    <td style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}><RoleChip role={iv.roleKey} /></td>
                    <td style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', textAlign: 'right' }}><Button size="sm" disabled={!canAdmin} onClick={() => revoke(iv.principal)}>Revoke</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <RoleLadder />
    </div>
  );
}

export function AssetLibrary() {
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>Media</h1>
        <div style={{ color: 'var(--muted)', marginTop: 4 }}>Assets are referenced by <code>assetRef</code> fields and resolved at delivery.</div>
      </div>
      <Card>
        <Empty title="No asset store wired yet" hint="Media uploads land through an R2 storage connector (design phase 2). The grid below is the designed shell; assetRef fields accept ids in the meantime." />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 12, marginTop: 8 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ aspectRatio: '1', borderRadius: 'var(--r-input)', background: 'repeating-linear-gradient(45deg, var(--wash), var(--wash) 8px, var(--surface) 8px, var(--surface) 16px)', border: '1px solid var(--border)', display: 'flex', alignItems: 'flex-end', padding: 8 }}>
              <Mono style={{ fontSize: 10 }}>asset-{i + 1}.png</Mono>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
