import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Input, Table } from '../components';
import type { TableColumn } from '../components';
import type { Api, MembersReading, StaffMember } from '../lib/api';

/**
 * Members — who may act on the control plane (the nav item that was "Planned"
 * until the write path existed).
 *
 * One list on purpose: the staff roster (`staff_actor`, #42) — this console,
 * the CLI, every audited admin capability. Each human gets a stable
 * `PlatformActorId` the admin log names them by, minted on first grant and
 * never reused; re-granting a revoked member keeps their actor so
 * pre-revocation history stays attributed.
 *
 * What is deliberately NOT here: builder-studio access. That is the `builder`
 * ENTITLEMENT on the tenant (granted from the tenant's detail page like any
 * SKU) — access to the studio follows the team that holds the product, never a
 * platform-side email list, and it grants nothing on the control plane.
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

/** The add form — email (required) + display name, then one grant call. */
function AddMember({
  busy,
  onAdd,
}: {
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
        Grant platform access
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
  const grantedBy = (actor: string | null) => {
    if (!actor) return <span style={{ color: 'var(--text-placeholder)' }}>—</span>;
    const s = reading?.staff.find((r) => r.actor === actor);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title="Platform staff"
        description="May act on the control plane — this console, the CLI, every audited admin capability. Each member acts under their own actor id; the admin log names them by it. Staff also enter the builder studio for any of their teams."
      >
        <AddMember
          busy={busy}
          onAdd={(email, name) =>
            run(() => api.grantStaffAccess(email, name), 'Platform access granted', email)
          }
        />
        <Table columns={staffColumns} rows={reading?.staff ?? []} />
      </Card>

      <Card title="Builder studio access">
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', maxWidth: 560, lineHeight: '19px' }}>
          Not an email list. The studio is a product a <em>team</em> holds: grant the{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>builder</code> entitlement on the tenant
          (Tenants → tenant → Grant entitlement) and every member of that team can build — with no
          control-plane access implied. Revoke the entitlement (or let a trial expire) and the studio
          closes for the whole team.
        </p>
      </Card>
    </div>
  );
}
