import { useEffect, useState } from 'react';
import { api, ApiError, getSite, type CreatedInvite, type InvitesResult, type Site } from './api';
import { Avatar, Button, Card, ColHead, Empty, MicroLabel, Mono, relativeTime } from './ui';

// Group C — Members & roles (design screen 13). Roles are held PER SITE: the same
// login is a different authority in each scope (K-22). The member table shows the
// signed-in member plus pending invites; the rail proves the per-site story with the
// caller's real role in every site.

const VIEWER_COLOR = { fg: 'var(--st-draft-fg)', bg: 'var(--st-draft-bg)' };
const ROLE_COLOR: Record<string, { fg: string; bg: string }> = {
  admin: { fg: 'var(--accent)', bg: 'var(--accent-soft)' },
  publisher: { fg: 'var(--st-published-fg)', bg: 'var(--st-published-bg)' },
  editor: { fg: 'var(--st-approved-fg)', bg: 'var(--st-approved-bg)' },
  author: { fg: 'var(--st-review-fg)', bg: 'var(--st-review-bg)' },
  viewer: VIEWER_COLOR,
};
function RoleChip({ role }: { role?: string | null }) {
  if (!role) return <span style={{ color: 'var(--faint)', fontSize: 12 }}>—</span>;
  const c = ROLE_COLOR[role] ?? VIEWER_COLOR;
  return <span style={{ fontSize: 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 'var(--r-pill)', color: c.fg, background: c.bg, textTransform: 'capitalize' }}>{role}</span>;
}

const RoleLadder = () => (
  <Card>
    <MicroLabel>The role ladder</MicroLabel>
    <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.8 }}>
      <li><strong>Author</strong> — drafts &amp; submits</li>
      <li><strong>Editor</strong> — + reviews</li>
      <li><strong>Publisher</strong> — + publishes</li>
      <li><strong>Admin</strong> — + manages members &amp; models</li>
      <li><strong>Viewer</strong> — read only</li>
    </ul>
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)', fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5 }}>
      Each transition checks the op's permission in this scope — the ladder is enforced by the kernel, not the UI.
    </div>
  </Card>
);

/** The "roles are per site" proof — the caller's actual role in every site of the tenant. */
function PerSiteRoles() {
  const [rows, setRows] = useState<{ site: Site; role: string | null }[]>([]);
  useEffect(() => {
    (async () => {
      const sites = await api.sites().catch(() => []);
      const out: { site: Site; role: string | null }[] = [];
      for (const site of sites) out.push({ site, role: (await api.meForSite(site.slug).catch(() => ({ role: null }))).role });
      setRows(out);
    })().catch(() => undefined);
  }, []);
  if (rows.length < 2) return null;
  return (
    <Card>
      <MicroLabel>Roles are per site</MicroLabel>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}>Your role in each of this tenant's sites:</div>
      {rows.map(({ site, role }) => (
        <div key={site.slug} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <Mono style={{ fontSize: 12, color: 'var(--ink)' }}>{site.slug}</Mono>
          <RoleChip role={role} />
        </div>
      ))}
      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5 }}>
        The role chip in the top bar always reflects the active site — the same person sees different chrome per scope.
      </div>
    </Card>
  );
}

export function MembersView(props: { meName: string; meRole?: string; canAdmin: boolean }) {
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
  const revoke = async (principal: string) => {
    setErr('');
    try { await api.revokeInvite(principal); if (created?.principal === principal) setCreated(null); load(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  };

  const roles = data?.roles ?? ['viewer', 'author', 'editor', 'publisher', 'admin'];
  const invites = data?.invites ?? [];
  const memberCount = 1 + invites.length;
  const adminReason = props.canAdmin ? '' : 'Disabled: needs the admin permission in this site.';
  const td = { padding: '10px 14px', borderBottom: '1px solid var(--border)', fontSize: 13.5 } as const;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 26, fontWeight: 600, margin: 0 }}>Members &amp; roles</h1>
        <div style={{ color: 'var(--muted)', marginTop: 4 }}>
          {memberCount} member{memberCount === 1 ? '' : 's'} · roles apply to <Mono style={{ fontSize: 12 }}>{getSite()}</Mono> only
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 16, alignItems: 'start' }}>
        <div>
          {err && <div style={{ padding: '10px 14px', borderRadius: 'var(--r-input)', background: 'var(--st-danger-bg)', color: 'var(--st-danger-fg)', fontSize: 13, marginBottom: 14 }}>{err}</div>}

          {/* The invite row — email (optional, link-only invites work too) + role + Invite. */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <input
              placeholder="jonas@nordlys.studio"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void invite(); }}
              style={{ flex: 1, minWidth: 200, font: 'inherit', fontSize: 13.5, padding: '8px 11px', borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--ink)' }}
            />
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ font: 'inherit', fontSize: 13.5, padding: '8px 10px', borderRadius: 'var(--r-input)', border: '1px solid var(--border2)', background: 'var(--surface)', color: 'var(--ink)', textTransform: 'capitalize' }}>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Button variant="primary" disabled={!props.canAdmin} title={adminReason} onClick={() => void invite()}>Invite</Button>
          </div>

          {created && (
            <div style={{ marginBottom: 14, padding: 12, borderRadius: 'var(--r-input)', background: 'var(--accent-soft)' }}>
              <div style={{ fontSize: 12, color: 'var(--accent)', marginBottom: 6 }}>
                Share this link — it lets them join as <RoleChip role={created.roleKey} />
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Mono style={{ flex: 1, wordBreak: 'break-all', fontSize: 11.5, color: 'var(--ink)' }}>{created.acceptUrl}</Mono>
                <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(created.acceptUrl); setCopied(true); }}>{copied ? 'Copied' : 'Copy'}</Button>
              </div>
            </div>
          )}

          <Card style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr><ColHead>Member</ColHead><ColHead>Role here</ColHead><ColHead>Last active</ColHead><ColHead>{' '}</ColHead></tr>
              </thead>
              <tbody>
                <tr>
                  <td style={td}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                      <Avatar name={props.meName || 'You'} size={28} />
                      <span>
                        <span style={{ display: 'block', fontWeight: 600 }}>{props.meName || 'You'}</span>
                        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>you</span>
                      </span>
                    </span>
                  </td>
                  <td style={td}><RoleChip role={props.meRole ?? (props.canAdmin ? 'admin' : undefined)} /></td>
                  <td style={{ ...td, color: 'var(--muted)', fontSize: 12.5 }}>now</td>
                  <td style={td} />
                </tr>
                {invites.map((iv) => (
                  <tr key={iv.principal} style={{ background: 'var(--wash)' }}>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ width: 28, height: 28, borderRadius: 'var(--r-pill)', background: 'var(--surface)', border: '1px dashed var(--border2)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: 'var(--muted)' }}>✉</span>
                        <span>
                          <span style={{ display: 'block', fontWeight: 500 }}>{iv.email ?? <span style={{ color: 'var(--faint)' }}>(link only)</span>}</span>
                          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)' }}>invite pending · sent {relativeTime(iv.createdAt)}</span>
                        </span>
                      </span>
                    </td>
                    <td style={td}><RoleChip role={iv.roleKey} /></td>
                    <td style={{ ...td, color: 'var(--faint)', fontSize: 12.5 }}>—</td>
                    <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', gap: 8 }}>
                        <Button size="sm" disabled title="Invite links are single-use — cancel this one and invite again to re-send.">Resend</Button>
                        <Button size="sm" disabled={!props.canAdmin} title={adminReason} onClick={() => void revoke(iv.principal)}>Cancel</Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {invites.length === 0 && (
              <Empty title="No pending invites" hint="Invite a teammate above — they join by opening the link, with the role you picked, in this site only." />
            )}
          </Card>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <PerSiteRoles />
          <RoleLadder />
        </div>
      </div>
    </div>
  );
}
