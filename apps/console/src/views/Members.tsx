import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Input, Table } from '../components';
import type { TableColumn } from '../components';
import type { Api, BuilderMember, MembersReading, StaffMember } from '../lib/api';

/**
 * Members — who has access to what (the nav item that was "Planned" until the
 * write path existed).
 *
 * Two lists, deliberately separate because they grant DIFFERENT things:
 *
 * - **Platform staff** (`staff_actor`, #42): may act on the control plane —
 *   this console, the CLI, every audited admin capability. Each human gets a
 *   stable `PlatformActorId` the admin log names them by, minted on first
 *   grant and never reused; re-granting a revoked member keeps their actor so
 *   pre-revocation history stays attributed.
 * - **Builder studio** (`builder_access`, migration 0003): may sign in to
 *   builder.substrat.net — and nothing else. This is the interim for customer
 *   access to the builder until the plan-entitlement flag exists
 *   (builder-plane.md §7). Staff have implicit studio access, so nobody needs
 *   to appear in both lists.
 *
 * Revocation tombstones rather than deletes (K-21): revoked rows stay listed —
 * "who has access" must also answer "who HAD access, and when did it end".
 * The API refuses to revoke the last active staff member (an empty roster
 * locks everyone out, including this surface).
 */

export interface MembersProps {
  api: Api;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

const when = (iso: string) => new Date(iso).toLocaleDateString();

function StatusCell({ revokedAt }: { revokedAt: string | null }) {
  return revokedAt === null ? (
    <Badge status="success">active</Badge>
  ) : (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Badge status="neutral">revoked</Badge>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{when(revokedAt)}</span>
    </span>
  );
}

function MemberCell({ email, name }: { email: string; name: string | null }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column' }}>
      {name && <span style={{ fontWeight: 500 }}>{name}</span>}
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: name ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
        {email}
      </span>
    </span>
  );
}

/** One list's add form — email (required) + display name, then one grant call. */
function AddMember({
  label,
  busy,
  onAdd,
}: {
  label: string;
  busy: boolean;
  onAdd: (email: string, name?: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const submit = async () => {
    const e = email.trim().toLowerCase();
    if (!e) return;
    await onAdd(e, name.trim() || undefined);
    setEmail('');
    setName('');
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}
    >
      <div style={{ width: 260 }}>
        <Input value={email} placeholder="email@company.com" onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div style={{ width: 180 }}>
        <Input value={name} placeholder="Name (optional)" onChange={(e) => setName(e.target.value)} />
      </div>
      <Button disabled={busy || !email.trim()} onClick={() => void submit()}>
        {label}
      </Button>
    </form>
  );
}

export function Members({ api, onToast }: MembersProps) {
  const [reading, setReading] = useState<MembersReading | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listMembers()
      .then(setReading)
      .catch((e: Error) => onToast('Failed to load members', e.message, 'danger'));
  }, [api, onToast]);

  // Every mutation returns the fresh reading — apply it, one round trip.
  const run = useCallback(
    async (fn: () => Promise<MembersReading>, title: string, detail?: string) => {
      setBusy(true);
      try {
        setReading(await fn());
        onToast(title, detail, 'success');
      } catch (e) {
        onToast('Failed', (e as Error).message, 'danger');
      } finally {
        setBusy(false);
      }
    },
    [onToast],
  );

  // The roster doubles as the actor directory: `addedBy` (a PlatformActorId)
  // renders as the granting member's name/email where the roster knows it.
  const byActor = useMemo(() => {
    const m = new Map<string, StaffMember>();
    for (const s of reading?.staff ?? []) if (s.actor) m.set(s.actor, s);
    return m;
  }, [reading]);

  const grantedBy = (actor: string | null) => {
    if (!actor) return <span style={{ color: 'var(--text-placeholder)' }}>—</span>;
    const s = byActor.get(actor);
    return s ? (
      <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{s.name ?? s.email}</span>
    ) : (
      <span title={actor} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>
        {`${actor.slice(0, 4)}…${actor.slice(-4)}`}
      </span>
    );
  };

  const staffColumns: TableColumn<StaffMember>[] = [
    { header: 'Member', render: (r) => <MemberCell email={r.email} name={r.name} /> },
    {
      header: 'Actor',
      // The admin log names staff by this ULID — the roster is where it resolves.
      render: (r) =>
        r.actor ? (
          <span title={r.actor} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {`${r.actor.slice(0, 4)}…${r.actor.slice(-4)}`}
          </span>
        ) : (
          <Badge status="danger">malformed</Badge>
        ),
    },
    { header: 'Added', render: (r) => <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{when(r.addedAt)}</span> },
    { header: 'By', render: (r) => grantedBy(r.addedBy) },
    { header: 'Status', render: (r) => <StatusCell revokedAt={r.revokedAt} /> },
    {
      header: '',
      align: 'right',
      render: (r) =>
        r.revokedAt === null ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void run(() => api.revokeStaffAccess(r.email), 'Platform access revoked', r.email)
            }
          >
            Revoke
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() =>
              void run(
                () => api.grantStaffAccess(r.email),
                'Platform access re-granted',
                `${r.email} · same actor, history stays attributed`,
              )
            }
          >
            Re-grant
          </Button>
        ),
    },
  ];

  const builderColumns: TableColumn<BuilderMember>[] = [
    { header: 'Member', render: (r) => <MemberCell email={r.email} name={r.name} /> },
    { header: 'Added', render: (r) => <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>{when(r.addedAt)}</span> },
    { header: 'By', render: (r) => grantedBy(r.addedBy) },
    { header: 'Status', render: (r) => <StatusCell revokedAt={r.revokedAt} /> },
    {
      header: '',
      align: 'right',
      render: (r) =>
        r.revokedAt === null ? (
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void run(() => api.revokeBuilderAccess(r.email), 'Builder access revoked', r.email)
            }
          >
            Revoke
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() =>
              void run(() => api.grantBuilderAccess(r.email), 'Builder access re-granted', r.email)
            }
          >
            Re-grant
          </Button>
        ),
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title="Platform staff"
        description="May act on the control plane — this console, the CLI, every audited admin capability. Each member acts under their own actor id; the admin log names them by it."
      >
        <AddMember
          label="Grant platform access"
          busy={busy}
          onAdd={(email, name) =>
            run(() => api.grantStaffAccess(email, name), 'Platform access granted', email)
          }
        />
        <Table columns={staffColumns} rows={reading?.staff ?? []} />
      </Card>

      <Card
        title="Builder studio"
        description="May sign in to the hosted builder studio — and nothing else. The interim for customer access until the plan entitlement exists (builder-plane.md §7); platform staff have implicit access and are not listed here."
      >
        <AddMember
          label="Grant builder access"
          busy={busy}
          onAdd={(email, name) =>
            run(() => api.grantBuilderAccess(email, name), 'Builder access granted', email)
          }
        />
        <Table
          columns={builderColumns}
          rows={reading?.builder ?? []}
          emptyText="No builder invites yet. Grant one to admit someone to the studio without any control-plane access."
        />
      </Card>
    </div>
  );
}
