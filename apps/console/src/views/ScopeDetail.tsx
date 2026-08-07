import { useEffect, useState } from 'react';
import type { HostnameBinding, Scope, Tenant, TenantId } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, KeyValue } from '../components';
import { availableActions, effectiveStatus, scopeHandle, statusLabel, statusTone } from '../lib/fleet';
import { boundHostnames, portalUrl } from '../lib/portal';
import {
  d1DatabaseUrl,
  dispatchScriptUrl,
  doNamespaceUrl,
  durableObjectsUrl,
  r2BucketUrl,
  scopeDoName,
  storesForScope,
  type DoNamespace,
  type PlatformRuntime,
  type TenantStores,
} from '../lib/cf-links';
import { walkAll, type Api } from '../lib/api';

export interface ScopeDetailProps {
  api: Api;
  scope: Scope;
  tenants: Map<TenantId, Tenant>;
  hostnames: HostnameBinding[];
  /** Where this platform runs — turns the refs below into dashboard links. Null = none. */
  runtime: PlatformRuntime | null;
  onBack: () => void;
  onChanged: () => void;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

/** A ref with a dashboard link when we can build one, and the bare ref when we cannot —
 *  the ONE rendering rule for every Cloudflare identifier on this page. Clipped to its
 *  column (a deterministic bucket name runs long) with the full value on hover: the ref
 *  is here to be FOLLOWED, and the link already carries it in full. */
function RefLink({ href, children }: { href: string | null; children: string }) {
  const mono = {
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const;
  if (!href)
    return (
      <span title={children} style={mono}>
        {children}
      </span>
    );
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={children}
      style={{ ...mono, color: 'var(--brand-700)' }}
    >
      {children} ↗
    </a>
  );
}

/**
 * The routed scope detail — one scope's identity, lifecycle levers, and health, on
 * its own page (the Tenant → TenantDetail precedent). The list stays a list; this is
 * where a scope is acted on. Reap is the one irreversible lever, so it opens a
 * type-the-slug gate rather than acting on click.
 */
export function ScopeDetail({ api, scope, tenants, hostnames, runtime, onBack, onChanged, onToast }: ScopeDetailProps) {
  const [confirmReap, setConfirmReap] = useState(false);
  const [reapArmed, setReapArmed] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  // Role-projection health (#321): fetched lazily on select so the fleet list stays
  // one directory read while this detail still reveals the silent "active but zero
  // roles" condition. Null = not-yet/unavailable (degrades to nothing shown).
  const [health, setHealth] = useState<{ roleProjectionEmpty: boolean; roleCount: number | null } | null>(null);
  // The script this scope's DO actually lives in. `servingRef` when it has adopted the
  // stable serving script (#286); otherwise the BOUND version's own script — the same
  // ladder introspection walks, because a scope's storage is in the deployment it was
  // provisioned on, never in whatever prod points at now.
  const [boundRef, setBoundRef] = useState<string | null>(null);
  // The tenant's per-tenant stores (#301/#473), narrowed below to this scope's vertical.
  const [stores, setStores] = useState<TenantStores | null>(null);
  // The DO namespaces defined in that script, scope-class first. Null = not resolved (no
  // lookup configured, the read failed, or no script yet) — the link falls back to the list.
  const [doNamespaces, setDoNamespaces] = useState<DoNamespace[] | null>(null);

  const eff = effectiveStatus(scope, tenants.get(scope.tenantId));
  const actions = availableActions(eff);
  // The hostnames this scope resolves — the load-bearing fact for both destructive
  // levers here. Archive takes them dark (an outage); reap is refused until they're
  // released (#500/#501). A serving scope always has ≥1, which is what makes it live.
  const bound = boundHostnames(scope, hostnames);

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

  // The Cloudflare coordinates: the serving script (looked up only when the scope has not
  // adopted one) and the tenant's stores. Both are best-effort — this card is navigation
  // aid, so a failed read costs a link and never an error banner.
  useEffect(() => {
    let cancelled = false;
    setBoundRef(scope.servingRef ?? null);
    if (!scope.servingRef && scope.vertical && scope.verticalVersionId) {
      const vertical = scope.vertical;
      const versionId = scope.verticalVersionId;
      void walkAll((p) => api.listVersions(vertical, p))
        .then((versions) => {
          const ref = versions.find((v) => v.id === versionId)?.deploymentRef ?? null;
          if (!cancelled) setBoundRef(ref);
        })
        .catch(() => {});
    }
    setStores(null);
    api
      .tenantStores(scope.tenantId)
      .then((s) => {
        if (!cancelled) setStores(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, scope]);

  // Resolve the namespace only once the script is known — it is what the lookup keys on.
  useEffect(() => {
    setDoNamespaces(null);
    if (!boundRef) return;
    let cancelled = false;
    api
      .doNamespaces(boundRef)
      .then((ns) => {
        if (!cancelled) setDoNamespaces(ns);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, boundRef]);

  const scopeStores = storesForScope(stores, scope.vertical);
  // The scope class comes first from the API, so the head is the namespace holding this
  // scope's data. Nothing resolved ⇒ null ⇒ the DO link falls back to the list.
  const scopeNamespace = doNamespaces?.[0] ?? null;

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
            {/* Archive is reversible (Restore replays), but archiving a serving scope is
                an outage — it stops resolving. Confirm through a dialog that names the
                hostnames going dark rather than taking a live app offline on one click. */}
            {actions.includes('archive') && (
              <Button variant="secondary" onClick={() => setConfirmArchive(true)}>
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
            {
              label: 'Hostnames',
              value:
                bound.length === 0 ? (
                  '— none bound'
                ) : (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Badge status="info">Serving · {bound.length}</Badge>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {bound[0]!.hostname}
                      {bound.length > 1 ? ` +${bound.length - 1}` : ''}
                    </span>
                  </span>
                ),
            },
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
        {eff === 'provisioning' && (
          <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            Still provisioning — it should settle into <code>active</code> on its own. If it
            has stalled (a failed migration or a dispatch gap can strand a scope here), Archive
            abandons it; once archived it can be reaped. Restore replays from the start.
          </p>
        )}
        {eff === 'archiving' && (
          <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            Transient state — actions available when it settles.
          </p>
        )}
      </Card>

      {/* Where this scope physically lives. Every value here is a ref the console already
          knew; what it adds is the door — the script page carries the bindings and logs,
          the store links land on the exact database or bucket. Rendered whenever there is
          a ref to show, with or without links: on a control plane with no runtime
          configured (self-host) the same identifiers are still worth having in one place. */}
      {(boundRef || scopeStores.tenantStores.length > 0 || scopeStores.blobStores.length > 0) && (
        <Card
          title="Cloudflare"
          description={
            runtime
              ? `Account ${runtime.accountId} · dispatch namespace ${runtime.dispatchNamespace}`
              : 'No platform runtime configured — identifiers only, no dashboard links.'
          }
        >
          <KeyValue
            columns={2}
            items={[
              {
                label: 'Serving script',
                value: boundRef ? (
                  <RefLink href={dispatchScriptUrl(runtime, boundRef)}>{boundRef}</RefLink>
                ) : (
                  '— no script resolved'
                ),
              },
              {
                // There is no per-object page in the dashboard — a Durable Object is
                // addressed by a namespace (class × script) and found by NAME inside it.
                // So the value is the name, which is the scope id verbatim
                // (`SCOPE.idFromName(scopeId)`), and the link is the closest page that
                // exists: the namespace holding it, or the list when it cannot be resolved.
                label: scopeNamespace ? `Durable Object · ${scopeNamespace.className}` : 'Durable Object name',
                value: (
                  <RefLink
                    href={doNamespaceUrl(runtime, scopeNamespace?.id) ?? durableObjectsUrl(runtime)}
                  >
                    {scopeDoName(scope.id)}
                  </RefLink>
                ),
              },
              ...scopeStores.tenantStores.map((s) => ({
                label: `D1 · ${s.binding}`,
                value: <RefLink href={d1DatabaseUrl(runtime, s.ref)}>{s.ref}</RefLink>,
              })),
              ...scopeStores.blobStores.map((s) => ({
                label: `R2 · ${s.binding}`,
                value: <RefLink href={r2BucketUrl(runtime, s.ref)}>{s.ref}</RefLink>,
              })),
            ]}
          />
          <p style={{ margin: '12px 0 0', fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: '18px' }}>
            The scope's own tables live in that Durable Object, not in D1 — the databases
            above are the tenant-wide stores this scope's vertical declared (#301/#473), shared
            by every scope of this tenant running it. Neither is browsable from the dashboard:
            the scope's rows are reachable only through the admin-query surface (§5.4).
          </p>
        </Card>
      )}

      {/* Reap confirmation — the type-to-arm gate (TenantDetail suspend precedent). Reap
          is the one scope action with no restore: it wipes the DO storage for good. The
          slug must be typed to enable Confirm; an unarmed dialog passes onConfirm=undefined,
          which the Dialog renders as a disabled button. */}
      <Dialog
        open={confirmReap}
        title={`Reap ${scopeHandle(scope, tenants)}?`}
        danger
        confirmLabel={bound.length > 0 ? `Unbind ${bound.length} & reap` : 'Reap storage'}
        width={520}
        onConfirm={
          reapArmed === scope.slug
            ? () => {
                setConfirmReap(false);
                setReapArmed('');
                // The reap guard refuses while any hostname is bound, so release them
                // first — the same unbind→reap order the bulk Prune lever runs. With no
                // bindings this loop is empty and it is a plain reap.
                void run(
                  async () => {
                    for (const h of bound) await api.unbindHostname(h.hostname);
                    await api.reapScope(scope.tenantId, scope.id);
                  },
                  'Storage reaped',
                  bound.length > 0
                    ? `${scope.slug} · ${bound.length} hostname${bound.length === 1 ? '' : 's'} released, Durable Object wiped`
                    : `${scope.slug} · Durable Object wiped, tombstone kept`,
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
          {/* A serving scope can't be reaped while bound (#500/#501). Rather than let the
              operator hit a raw 409, name the hostnames this will release first — taking
              the app permanently offline — as part of the same armed action. */}
          {bound.length > 0 && (
            <div
              style={{
                border: '1px solid var(--status-warning-border, var(--border-subtle))',
                borderRadius: 6,
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <span style={{ fontSize: 12.5, color: 'var(--status-warning-fg)', lineHeight: '18px' }}>
                <strong>This scope is still serving.</strong> Reap is refused while a hostname
                is bound, so confirming first unbinds {bound.length === 1 ? 'it' : `all ${bound.length}`} —
                taking the app <strong>offline for good</strong> — then wipes storage.
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {bound.map((h) => (
                  <span key={h.hostname}>
                    {h.hostname}
                    {h.canonical ? ' · canonical' : ''}
                  </span>
                ))}
              </div>
            </div>
          )}
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

      {/* Archive confirmation — archive is reversible (Restore replays migrations on next
          access), but a serving scope stops resolving the moment it archives. Name the
          hostnames going dark so "Archive" on a live install is a decision, not a reflex. */}
      <Dialog
        open={confirmArchive}
        title={`Archive ${scopeHandle(scope, tenants)}?`}
        confirmLabel={bound.length > 0 ? 'Take offline & archive' : 'Archive'}
        width={520}
        onConfirm={() => {
          setConfirmArchive(false);
          void run(() => api.archiveScope(scope.tenantId, scope.id), 'Scope archived', scope.slug);
        }}
        onCancel={() => setConfirmArchive(false)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: '19px' }}>
            Archiving suspends the scope and starts its auto-reap clock (§4.4). It is{' '}
            <strong>reversible</strong> — Restore brings it back and replays migrations on next
            access — but the app goes offline until then.
          </p>
          {bound.length > 0 ? (
            <div
              style={{
                border: '1px solid var(--status-warning-border, var(--border-subtle))',
                borderRadius: 6,
                padding: '8px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <span style={{ fontSize: 12.5, color: 'var(--status-warning-fg)', lineHeight: '18px' }}>
                <strong>
                  {bound.length} hostname{bound.length === 1 ? ' goes' : 's go'} dark
                </strong>{' '}
                the moment this archives — the router stops resolving:
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                {bound.map((h) => (
                  <span key={h.hostname}>
                    {h.hostname}
                    {h.canonical ? ' · canonical' : ''}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              No hostnames bound — no live traffic is affected.
            </span>
          )}
        </div>
      </Dialog>
    </div>
  );
}
