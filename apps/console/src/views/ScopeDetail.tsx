import { useEffect, useState } from 'react';
import type { HostnameBinding, Scope, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, KeyValue } from '../components';
import { availableActions, effectiveStatus, scopeHandle, statusLabel, statusTone } from '../lib/fleet';
import { portalUrl } from '../lib/portal';
import type { Api } from '../lib/api';

export interface ScopeDetailProps {
  api: Api;
  scope: Scope;
  tenants: Map<TenantId, Tenant>;
  hostnames: HostnameBinding[];
  onBack: () => void;
  onChanged: () => void;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

/**
 * The routed scope detail — one scope's identity, lifecycle levers, and health, on
 * its own page (the Tenant → TenantDetail precedent). The list stays a list; this is
 * where a scope is acted on. Reap is the one irreversible lever, so it opens a
 * type-the-slug gate rather than acting on click.
 */
export function ScopeDetail({ api, scope, tenants, hostnames, onBack, onChanged, onToast }: ScopeDetailProps) {
  const [confirmReap, setConfirmReap] = useState(false);
  const [reapArmed, setReapArmed] = useState('');
  // Role-projection health (#321): fetched lazily on select so the fleet list stays
  // one directory read while this detail still reveals the silent "active but zero
  // roles" condition. Null = not-yet/unavailable (degrades to nothing shown).
  const [health, setHealth] = useState<{ roleProjectionEmpty: boolean; roleCount: number | null } | null>(null);

  const eff = effectiveStatus(scope, tenants.get(scope.tenantId));
  const actions = availableActions(eff);

  // Probe the scope's role projection. Only an ACTIVE scope can exhibit the silent-deny
  // condition; skip the call otherwise.
  useEffect(() => {
    setHealth(null);
    if (eff !== 'active') return;
    let cancelled = false;
    api
      .scopeHealth(scope.tenantId, scope.id)
      .then((h) => {
        if (!cancelled) setHealth({ roleProjectionEmpty: h.roleProjectionEmpty, roleCount: h.roleCount });
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, scope, eff]);

  async function run(fn: () => Promise<unknown>, title: string, detail?: string) {
    try {
      await fn();
      onChanged();
      onToast(title, detail);
    } catch (e) {
      onToast('Refused', (e as Error).message, 'danger');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card
        title={scope.name}
        description={`Scope detail — ${scopeHandle(scope, tenants)}`}
        actions={
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            {portalUrl(scope, hostnames) && (
              <a
                href={portalUrl(scope, hostnames)!}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--brand-700)', textDecoration: 'none', marginRight: 4 }}
              >
                Open portal ↗
              </a>
            )}
            {actions.includes('unsuspend') && (
              <Button onClick={() => run(() => api.unsuspendScope(scope.tenantId, scope.id), 'Scope unsuspended', scope.slug)}>
                Unsuspend
              </Button>
            )}
            {actions.includes('unarchive') && (
              <Button onClick={() => run(() => api.unarchiveScope(scope.tenantId, scope.id), 'Scope restored', `${scope.slug} · migrations replay on next access`)}>
                Restore scope
              </Button>
            )}
            {actions.includes('suspend') && (
              <Button variant="danger" onClick={() => run(() => api.suspendScope(scope.tenantId, scope.id), 'Scope suspended', `${scope.slug} fails closed`)}>
                Suspend
              </Button>
            )}
            {actions.includes('archive') && (
              <Button variant="secondary" onClick={() => run(() => api.archiveScope(scope.tenantId, scope.id), 'Scope archived', scope.slug)}>
                Archive
              </Button>
            )}
            {/* Reap frees the scope's DO storage for good — the one unrestorable action,
                so it opens the type-to-arm dialog instead of acting on click. */}
            {actions.includes('reap') && (
              <Button variant="danger" onClick={() => { setReapArmed(''); setConfirmReap(true); }}>
                Reap storage
              </Button>
            )}
            <Button variant="secondary" onClick={onBack}>
              All scopes
            </Button>
          </span>
        }
      >
        <KeyValue
          columns={4}
          items={[
            { label: 'Scope ID', value: scope.id, mono: true },
            { label: 'Tenant', value: tenants.get(scope.tenantId)?.name ?? '—' },
            { label: 'Vertical', value: scope.vertical ?? '—', mono: true },
            { label: 'Kind', value: scope.kind, mono: true },
            { label: 'Storage shape', value: `Shape ${scope.storageShape}` },
            // Fixed at provisioning (K-7) — displayed, never editable.
            {
              label: 'Jurisdiction',
              value:
                scope.jurisdiction === 'global'
                  ? 'Global — unconstrained'
                  : `${scope.jurisdiction.toUpperCase()} — fixed at provisioning`,
            },
            { label: 'Schema', value: scope.schemaVersion, mono: true },
            ...(scope.migrationFailure
              ? [
                  {
                    label: 'Migration failed',
                    value: scope.migrationFailure.version,
                    mono: true,
                  },
                  {
                    label: 'Attempts',
                    value: String(scope.migrationFailure.attempts),
                    mono: true,
                  },
                ]
              : []),
            { label: 'Created', value: scope.createdAt.slice(0, 10), mono: true },
            // Only meaningful once archived; drives the auto-reap age (§4.4).
            ...(scope.archivedAt
              ? [{ label: 'Archived', value: scope.archivedAt.slice(0, 10), mono: true }]
              : []),
          ]}
        />
        {health?.roleProjectionEmpty && (
          <div style={{ margin: '12px 0 0', display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <Badge status="danger">Empty role projection</Badge>
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: '18px' }}>
              This active scope serves traffic from a Durable Object whose <code>_substrat_roles</code>{' '}
              projection is empty — identity resolves but <strong>every permission check denies</strong>, so
              the app renders a no-access page (#321). Usually a scope stranded on a fresh serving script:
              re-project its roles, or run <code>substrat scope adopt-serving</code> if it never adopted.
            </p>
          </div>
        )}
        {eff === 'reaped' && (
          <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            Storage reaped — this scope's Durable Object was wiped (§4.4). The row is kept
            as a tombstone for the audit trail and to keep its slug burned; there is no
            restore.
          </p>
        )}
        {scope.migrationFailure && (
          <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            This scope failed closed and is serving nothing — the schema count above is
            what landed before <code>{scope.migrationFailure.version}</code> rolled back.
            Recovery is per-scope PITR plus a patched forward migration (kernel-design §5.3).
            Last attempt {scope.migrationFailure.lastAttemptAt.slice(0, 19).replace('T', ' ')}:{' '}
            {scope.migrationFailure.error}
          </p>
        )}
        {eff === 'suspended-via-tenant' && (
          <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            Suspended by a tenant-wide cascade — unsuspend the tenant to release it; per-scope unsuspend is not offered.
          </p>
        )}
        {(eff === 'provisioning' || eff === 'archiving') && (
          <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            Transient state — actions available when it settles.
          </p>
        )}
      </Card>

      {/* Reap confirmation — the type-to-arm gate (TenantDetail suspend precedent). Reap
          is the one scope action with no restore: it wipes the DO storage for good. The
          slug must be typed to enable Confirm; an unarmed dialog passes onConfirm=undefined,
          which the Dialog renders as a disabled button. */}
      <Dialog
        open={confirmReap}
        title={`Reap ${scopeHandle(scope, tenants)}?`}
        danger
        confirmLabel="Reap storage"
        width={520}
        onConfirm={
          reapArmed === scope.slug
            ? () => {
                setConfirmReap(false);
                setReapArmed('');
                void run(
                  () => api.reapScope(scope.tenantId, scope.id),
                  'Storage reaped',
                  `${scope.slug} · Durable Object wiped, tombstone kept`,
                );
              }
            : undefined
        }
        onCancel={() => {
          setConfirmReap(false);
          setReapArmed('');
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: '19px' }}>
            This permanently wipes the scope's Durable Object storage — every table, event,
            and migration record. It <strong>cannot be undone</strong>: unlike archive, there
            is no restore. The directory row is kept as a tombstone (audit trail + burned slug).
          </p>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {scope.vertical ? `Vertical ${scope.vertical}` : 'No vertical bound'}
            {scope.archivedAt ? ` · archived ${scope.archivedAt.slice(0, 10)}` : ''}
          </span>
          <Input
            label="Type the scope slug to arm this action"
            mono
            placeholder={scope.slug}
            value={reapArmed}
            onChange={(e) => setReapArmed(e.target.value)}
          />
        </div>
      </Dialog>
    </div>
  );
}
