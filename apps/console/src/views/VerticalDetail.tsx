import { useCallback, useEffect, useState } from 'react';
import type {
  ChannelName,
  OpsFailureEntry,
  PromotionAcknowledgement,
  Scope,
  ScopeId,
  Vertical,
  VerticalChannel,
  VerticalVersion,
} from '@substrat-run/contracts';
import { Badge, Button, Card, Checkbox, Dialog, Input, Select, SelectBox, Table, Tag } from '../components';
import type { TableColumn } from '../components';
import { walkAll } from '../lib/api';
import type { Api } from '../lib/api';
import { statusLabel, statusTone } from '../lib/fleet';

// `prod` is the only channel — dev/staging were retired (#509). A non-prod environment is
// a preview, not a second pointer at the same code.
const CHANNELS: readonly ChannelName[] = ['prod'];
const PAGE = 20;

const admissionTone = (a: VerticalVersion['admission']): 'success' | 'danger' | 'warning' =>
  a === 'admitted' ? 'success' : a === 'rejected' ? 'danger' : 'warning';

export interface VerticalDetailProps {
  api: Api;
  vertical: Vertical;
  onBack: () => void;
  /** Refresh the parent list so the row (listed/blocked/provisioner) reflects a mutation. */
  onChanged: () => void;
  /** Jump to Operations → Failures pre-narrowed to this vertical (#559). */
  onOpenFailures: (slug: string) => void;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

/**
 * The routed vertical detail — one vertical's versions, channels, bound installs, and
 * the two human checkpoints (admission + channel promotion), on its own page. Publishing
 * a version stays with CI/CLI; what this owns is the staff side: admit/reject a pending
 * version, promote a channel (refusing a changed permission/migration digest unless
 * acknowledged here), list/unlist, block installs, grant the provisioner capability,
 * retire bound scopes, and delete.
 */
export function VerticalDetail({ api, vertical, onBack, onChanged, onOpenFailures, onToast }: VerticalDetailProps) {
  const [versions, setVersions] = useState<VerticalVersion[]>([]);
  const [channels, setChannels] = useState<VerticalChannel[]>([]);
  // This vertical's recent operational failures (#559): the badge/strip below, and the
  // per-row explanation a stuck-`provisioning` preview joins against by scopeId.
  const [failures, setFailures] = useState<OpsFailureEntry[]>([]);
  // How much of the walked version list the TABLE shows (the Load-more window).
  const [versionsShown, setVersionsShown] = useState(PAGE);

  // The promote dialog: a target (channel, version) plus the acknowledgements the
  // digest diff requires. Null when closed.
  const [promote, setPromote] = useState<{ channel: ChannelName; versionId: string } | null>(null);
  const [ack, setAck] = useState<PromotionAcknowledgement>({});

  // The delete dialog's type-to-confirm guard. Null when closed.
  const [deleteInput, setDeleteInput] = useState<string | null>(null);

  // Scopes (installs) still bound to this vertical — what the delete refusal counts, and
  // what the retire panel below lets an operator clear. Excludes `reaped` tombstones
  // (terminal, they never block the delete). The retire dialog target + its hostnames,
  // plus a type-to-confirm guard because retiring a primary scope reaps it.
  const [boundScopes, setBoundScopes] = useState<Scope[]>([]);
  const [retire, setRetire] = useState<{ scope: Scope; hostnames: string[] } | null>(null);
  const [retireInput, setRetireInput] = useState('');

  // Bulk selection over the bound scopes, keyed by id so a reload never carries a stale
  // row into an action — everything derives from the current `boundScopes`.
  const [selectedIds, setSelectedIds] = useState<Set<ScopeId>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Move-to-vertical (the #389 update-rebind): target lineages come from the registry,
  // loaded when the dialog opens. `ack` is the migration-digest override the control
  // plane demands when the two lineages' migration histories differ.
  const [move, setMove] = useState<{ targets: { slug: string; name: string }[]; choice: string; ack: boolean } | null>(null);
  // Bulk retire: every selected scope with the hostnames each will release, armed by
  // typing the count (the Scopes-view convention for storage-wiping bulk actions).
  const [bulkRetire, setBulkRetire] = useState<{ scopes: Scope[]; hostnames: Map<ScopeId, string[]> } | null>(null);
  const [bulkArmed, setBulkArmed] = useState('');

  const loadDetail = useCallback(
    async (slug: string) => {
      try {
        // Walked in FULL, not one page: the channel cards and the promote picker are
        // computations over the whole version set — a channel pointer whose version fell
        // outside a loaded page would render as "unset", a lie. Only the versions TABLE
        // below windows what it shows.
        const [vs, ch, sc, fl] = await Promise.all([
          walkAll((p) => api.listVersions(slug, p)),
          walkAll((p) => api.listChannels(slug, p)),
          walkAll((p) => api.listScopes({ vertical: slug, ...p })),
          // The last 7 days of operational failures (#559) — one page is plenty for a
          // strip; the Failures view has the full history. Tolerated to empty: a control
          // plane predating the route must not fail the whole detail.
          api
            .listOpsFailures({
              vertical: slug,
              since: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(),
              limit: 50,
            })
            .then((p) => p.entries)
            .catch(() => [] as OpsFailureEntry[]),
        ]);
        setVersions(vs);
        setChannels(ch);
        setFailures(fl);
        // Reaped rows are terminal tombstones that never block the delete — the retire
        // panel lists only what still does (live + archived).
        setBoundScopes(sc.filter((s) => s.status !== 'reaped'));
      } catch (e) {
        onToast('Failed to load versions', (e as Error).message, 'danger');
      }
    },
    [api, onToast],
  );

  // Re-walk versions + channels + bound scopes whenever the opened vertical changes.
  useEffect(() => {
    setVersions([]);
    setChannels([]);
    setBoundScopes([]);
    setFailures([]);
    setVersionsShown(PAGE);
    setSelectedIds(new Set());
    void loadDetail(vertical.slug);
  }, [vertical.slug, loadDetail]);

  async function run(fn: () => Promise<unknown>, title: string, detail?: string) {
    try {
      await fn();
      onChanged();
      await loadDetail(vertical.slug);
      onToast(title, detail);
    } catch (e) {
      onToast('Refused', (e as Error).message, 'danger');
    }
  }

  // Open the retire confirm for one bound scope, pre-loading the hostnames it will
  // release so the dialog can name exactly what goes offline (the visibility the
  // incident lacked — a reap that named nothing).
  async function openRetire(s: Scope) {
    try {
      const hs = await walkAll((p) => api.listHostnames({ scopeId: s.id, ...p }));
      setRetireInput('');
      setRetire({ scope: s, hostnames: hs.map((h) => h.hostname) });
    } catch (e) {
      onToast('Failed to load hostnames', (e as Error).message, 'danger');
    }
  }

  // Retire one scope: release its names, then reap it (a fork is hard-deleted). Unbinding
  // FIRST is what satisfies reap's bound-hostname guard — the same order the platform
  // enforces — so a still-serving scope can never be wiped by accident.
  async function confirmRetire() {
    if (!retire) return;
    const s = retire.scope;
    await run(
      async () => {
        for (const h of retire.hostnames) await api.unbindHostname(h);
        if (s.forkedFrom) {
          await api.deleteScope(s.tenantId, s.id);
        } else {
          if (s.status !== 'archived') await api.archiveScope(s.tenantId, s.id);
          await api.reapScope(s.tenantId, s.id);
        }
      },
      s.forkedFrom ? 'Snapshot deleted' : 'Scope retired',
      s.slug,
    ).then(() => setRetire(null));
  }

  const selectedScopes = boundScopes.filter((s) => selectedIds.has(s.id));
  // The rebind endpoint refuses a fork (reap and re-preview against the target instead),
  // so snapshots ride the selection for retire but never for a move.
  const movableScopes = selectedScopes.filter((s) => !s.forkedFrom);
  const allSelected = boundScopes.length > 0 && selectedScopes.length === boundScopes.length;

  function toggleOne(id: ScopeId, on: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Open the move dialog: the target list is the registry minus this vertical, loaded
  // fresh so a just-created lineage (the exact migration use case) is offerable.
  async function openMove() {
    try {
      const registry = await walkAll((p) => api.listVerticals(p));
      const targets = registry
        .filter((v) => v.slug !== vertical.slug)
        .map((v) => ({ slug: v.slug, name: v.name }));
      if (targets.length === 0) {
        onToast('No target verticals', 'The registry has no other lineage to move onto.', 'danger');
        return;
      }
      setMove({ targets, choice: targets[0]!.slug, ack: false });
    } catch (e) {
      onToast('Failed to load verticals', (e as Error).message, 'danger');
    }
  }

  // Move every selected (non-fork) scope onto the target lineage's serving script —
  // sequential, each its own audited rebind; a mid-run refusal is surfaced verbatim
  // (the digest gate's message names the acknowledgement it wants) and stops the run,
  // so the operator re-runs the remainder rather than half-acknowledging.
  async function confirmMove() {
    if (!move) return;
    setBulkBusy(true);
    let ok = 0;
    let refusal: string | null = null;
    for (const s of movableScopes) {
      try {
        await api.rebindScopeVertical(s.tenantId, s.id, move.choice, move.ack ? { ackMigrations: true } : {});
        ok++;
      } catch (e) {
        refusal = `${s.slug}: ${(e as Error).message}`;
        break;
      }
    }
    setBulkBusy(false);
    // On a refusal the dialog stays open WITH the selection, so the operator can read
    // the message, tick the acknowledgement, and retry the remainder — scopes that did
    // move drop out of the selection naturally when the reload removes them from the
    // bound list.
    if (refusal === null) {
      setMove(null);
      setSelectedIds(new Set());
    }
    onChanged();
    await loadDetail(vertical.slug);
    onToast(
      `${ok} scope${ok === 1 ? '' : 's'} moved to ${move.choice}`,
      refusal ?? undefined,
      refusal ? 'danger' : 'success',
    );
  }

  // Open the bulk retire confirm: pre-load every selected scope's hostnames so the
  // dialog can name exactly what goes offline (the reap-safety lesson, at bulk scale).
  async function openBulkRetire() {
    try {
      const hostnames = new Map<ScopeId, string[]>();
      for (const s of selectedScopes) {
        const hs = await walkAll((p) => api.listHostnames({ scopeId: s.id, ...p }));
        hostnames.set(s.id, hs.map((h) => h.hostname));
      }
      setBulkArmed('');
      setBulkRetire({ scopes: selectedScopes, hostnames });
    } catch (e) {
      onToast('Failed to load hostnames', (e as Error).message, 'danger');
    }
  }

  // Retire the whole selection, each scope in the platform's own order (release names →
  // fork-delete, or archive → reap). A mid-run failure is counted, not fatal — the
  // reload shows exactly which rows remain.
  async function confirmBulkRetire() {
    if (!bulkRetire) return;
    setBulkBusy(true);
    let ok = 0;
    let failed = 0;
    for (const s of bulkRetire.scopes) {
      try {
        for (const h of bulkRetire.hostnames.get(s.id) ?? []) await api.unbindHostname(h);
        if (s.forkedFrom) {
          await api.deleteScope(s.tenantId, s.id);
        } else {
          if (s.status !== 'archived') await api.archiveScope(s.tenantId, s.id);
          await api.reapScope(s.tenantId, s.id);
        }
        ok++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    setBulkRetire(null);
    setSelectedIds(new Set());
    onChanged();
    await loadDetail(vertical.slug);
    onToast(
      `${ok} scope${ok === 1 ? '' : 's'} retired`,
      failed > 0 ? `${failed} failed` : undefined,
      failed > 0 ? 'danger' : 'success',
    );
  }

  const versionById = (id: string) => versions.find((v) => v.id === id);
  const channelVersion = (ch: ChannelName) =>
    versionById(channels.find((c) => c.channel === ch)?.versionId ?? '');

  // What the promote dialog must surface: which digests differ between the version being
  // promoted and the one the channel points at now. A first promotion has nothing to
  // diff against, so nothing to acknowledge.
  const target = promote ? versionById(promote.versionId) : undefined;
  const current = promote ? channelVersion(promote.channel) : undefined;
  const permChanged = !!(current && target && current.permissionDigest !== target.permissionDigest);
  const migChanged = !!(current && target && current.migrationDigest !== target.migrationDigest);
  const ackSatisfied = (!permChanged || ack.permissionChange) && (!migChanged || ack.migrationChange);

  const scopeColumns: TableColumn<Scope>[] = [
    {
      header: '',
      width: 36,
      render: (s) => (
        <SelectBox
          checked={selectedIds.has(s.id)}
          onChange={(on) => toggleOne(s.id, on)}
          ariaLabel={`Select ${s.slug}`}
        />
      ),
    },
    { header: 'Scope', render: (s) => <Tag mono>{s.slug}</Tag> },
    {
      header: 'Status',
      render: (s) => {
        // A row stuck in `provisioning` is a create that died mid-flight. Joined against
        // the failure record by scopeId (#559), the console can SAY why — "restore failed
        // (CF reference …)" — instead of showing an inert blue badge until the GC sweep
        // reaps it.
        const fail = s.status === 'provisioning' ? failures.find((f) => f.scopeId === s.id) : undefined;
        return (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Badge status={fail ? 'danger' : statusTone(s.status)}>{statusLabel(s.status)}</Badge>
            {fail && (
              <span style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>
                {fail.stage ?? fail.operation} failed
                {fail.reference ? ` (CF reference ${fail.reference})` : ''}
              </span>
            )}
          </span>
        );
      },
    },
    { header: 'Kind', render: (s) => <Tag mono>{s.forkedFrom ? 'snapshot' : s.kind}</Tag> },
    {
      header: '',
      align: 'right',
      render: (s) => (
        <Button size="sm" variant="danger" onClick={() => void openRetire(s)}>
          Retire…
        </Button>
      ),
    },
  ];

  const versionColumns: TableColumn<VerticalVersion>[] = [
    { header: 'Version', render: (v) => v.version, mono: true },
    { header: 'Pushed', render: (v) => v.createdAt.slice(0, 16).replace('T', ' '), mono: true, muted: true, width: 140 },
    { header: 'Admission', render: (v) => <Badge status={admissionTone(v.admission)}>{v.admission}</Badge> },
    {
      // The declared outbound surface (#303, D-46) — part of what admitting means, so it
      // renders beside the Admit button: which third-party hosts this version's worker may
      // fetch. `none` is the healthy default (connectors + the email relay need no
      // declaration); `undeclared` = a pre-#303 push the egress worker meters but does not
      // enforce until the next push.
      header: 'Outbound',
      render: (v) =>
        v.outbound == null ? (
          <span style={{ color: 'var(--text-placeholder)' }}>undeclared (unenforced)</span>
        ) : v.outbound.length === 0 ? (
          <span style={{ color: 'var(--text-placeholder)' }}>none</span>
        ) : (
          <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
            {v.outbound.map((h) => (
              <Tag key={h} mono>
                {h}
              </Tag>
            ))}
          </span>
        ),
    },
    {
      header: 'Deployment',
      render: (v) =>
        v.deploymentRef ? (
          <Tag mono>{v.deploymentRef}</Tag>
        ) : (
          <span style={{ color: 'var(--text-placeholder)' }}>not deployed</span>
        ),
    },
    {
      header: '',
      align: 'right',
      render: (v) =>
        v.admission === 'pending' ? (
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <Button
              size="sm"
              onClick={() => run(() => api.admitVersion(vertical.slug, v.id), 'Version admitted', v.version)}
            >
              Admit
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                run(() => api.rejectVersion(vertical.slug, v.id, 'rejected from console'), 'Version rejected', v.version)
              }
            >
              Reject
            </Button>
          </span>
        ) : null,
    },
  ];

  async function confirmPromote() {
    if (!promote) return;
    if (!ackSatisfied) {
      onToast('Acknowledge the change to promote', 'The permission or migration surface changed.', 'danger');
      return;
    }
    await run(
      () => api.promoteVersion(vertical.slug, promote.channel, promote.versionId, ack),
      `Promoted ${promote.channel}`,
      versionById(promote.versionId)?.version,
    );
    setPromote(null);
    setAck({});
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Card
        title={vertical.name}
        description={`Versions and channels — ${vertical.slug}`}
        actions={
          <span style={{ display: 'inline-flex', gap: 8 }}>
            {/* List = the staff publish admission (marketplace-publish.md §5), so it gets
                the primary variant — it widens the audience to every tenant; Unlist is
                danger because it pulls a live listing. The API refuses listing while prod
                points at an auto-admitted version — that refusal surfaces verbatim via
                `run`, deliberately not pre-checked here. */}
            <Button
              variant={vertical.listed ? 'danger' : 'primary'}
              onClick={() =>
                run(
                  () => api.setVerticalListed(vertical.slug, !vertical.listed),
                  vertical.listed ? 'Vertical unlisted' : 'Vertical listed',
                  vertical.slug,
                )
              }
            >
              {vertical.listed ? 'Unlist' : 'List'}
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                run(
                  () => api.setInstallsBlocked(vertical.slug, !vertical.installsBlocked),
                  vertical.installsBlocked ? 'Installs allowed' : 'Installs blocked',
                  vertical.slug,
                )
              }
            >
              {vertical.installsBlocked ? 'Allow installs' : 'Block installs'}
            </Button>
            {/* The tenant-provisioner capability (#412/#444) — grant = this vertical's
                scopes may create customer tenants via platform intents, so revoke is the
                safe direction and grant deliberately reads as the loud one. With a
                manifest-declared `provisions` request pending (#455) it reads as the
                approval it is. */}
            <Button
              variant="secondary"
              onClick={() =>
                run(
                  () => api.setTenantProvisioner(vertical.slug, !vertical.tenantProvisioner),
                  vertical.tenantProvisioner ? 'Provisioner capability revoked' : 'Provisioner capability granted',
                  vertical.slug,
                )
              }
            >
              {vertical.tenantProvisioner
                ? 'Revoke provisioner'
                : vertical.provisions?.length
                  ? 'Approve provisioner'
                  : 'Grant provisioner'}
            </Button>
            {/* The email-sender capability (#303) — grant = this vertical's scopes may send
                transactional mail through the platform relay. Revoke is the safe direction;
                a manifest-declared `sendsEmail` request reads the grant as the approval it is. */}
            <Button
              variant="secondary"
              onClick={() =>
                run(
                  () => api.setEmailSender(vertical.slug, !vertical.emailSender),
                  vertical.emailSender ? 'Email-sender capability revoked' : 'Email-sender capability granted',
                  vertical.slug,
                )
              }
            >
              {vertical.emailSender
                ? 'Revoke email sender'
                : vertical.sendsEmail
                  ? 'Approve email sender'
                  : 'Grant email sender'}
            </Button>
            <Button variant="danger" onClick={() => setDeleteInput('')}>
              Delete…
            </Button>
            <Button variant="secondary" onClick={onBack}>
              All verticals
            </Button>
          </span>
        }
      >
        {/* Declared provisioner intent (#455): what the manifest asks to provision, shown
            against the grant state so the approve action is an informed read. */}
        {vertical.provisions?.length ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 12.5 }}>
            <Badge status={vertical.tenantProvisioner ? 'warning' : 'info'}>
              {vertical.tenantProvisioner ? 'provisions' : 'requests to provision'}
            </Badge>
            {vertical.provisions.map((prov) => (
              <Tag key={prov} mono>
                {prov}
              </Tag>
            ))}
          </div>
        ) : null}

        {/* Declared email-sender intent (#303): the manifest asks to send transactional mail,
            shown against the grant state so approving is an informed read. */}
        {vertical.sendsEmail ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 12.5 }}>
            <Badge status={vertical.emailSender ? 'warning' : 'info'}>
              {vertical.emailSender ? 'sends email' : 'requests to send email'}
            </Badge>
          </div>
        ) : null}

        {/* Recent operational failures (#559): the week the crm-eff incident made the case
            for — 5 failed restores would have been visible HERE at a glance instead of
            reconstructed from expiring per-version observability logs. */}
        {failures.length > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 16,
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid var(--status-danger-border, var(--border-default))',
              background: 'var(--status-danger-bg, var(--surface-card))',
              fontSize: 12.5,
            }}
          >
            <Badge status="danger">
              {failures.length} failure{failures.length === 1 ? '' : 's'} · 7 days
            </Badge>
            <span style={{ color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              latest: {failures[0]!.operation}
              {failures[0]!.stage ? ` · ${failures[0]!.stage}` : ''} at{' '}
              {failures[0]!.at.slice(0, 16).replace('T', ' ')}
              {failures[0]!.reference ? ` — reference ${failures[0]!.reference}` : ''}
            </span>
            <Button size="sm" variant="ghost" onClick={() => onOpenFailures(vertical.slug)}>
              View all
            </Button>
          </div>
        )}

        {/* Channels: the named pointers promotion moves. */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          {CHANNELS.map((ch) => {
            const v = channelVersion(ch);
            const pointer = channels.find((c) => c.channel === ch);
            return (
              <div
                key={ch}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  border: '1px solid var(--border-default)',
                  borderRadius: 8,
                  padding: '8px 12px',
                  background: 'var(--surface-card)',
                }}
              >
                <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>
                  {ch}
                </span>
                {v ? (
                  <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
                    <Tag mono>{v.version}</Tag>
                    {pointer && (
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                        {pointer.updatedAt.slice(0, 16).replace('T', ' ')}
                      </span>
                    )}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-placeholder)', fontSize: 12.5 }}>unset</span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={versions.every((x) => x.admission !== 'admitted')}
                  onClick={() => {
                    setAck({});
                    setPromote({ channel: ch, versionId: versions.find((x) => x.admission === 'admitted')?.id ?? '' });
                  }}
                >
                  Promote…
                </Button>
              </div>
            );
          })}
        </div>

        {/* Publish order preserved (asc — the walk keeps the route's default); the window
            grows a page at a time over the already-walked set. */}
        <Table
          columns={versionColumns}
          rows={versions.slice(0, versionsShown)}
          emptyText="No versions published yet."
        />
        {versions.length > versionsShown && (
          <div style={{ padding: '12px 0 0', display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" size="sm" onClick={() => setVersionsShown((n) => n + PAGE)}>
              Load more
            </Button>
          </div>
        )}

        {/* Bound scopes — the installs this vertical still backs, and what the delete
            refusal counts. Retiring each (release names → reap; forks are hard-deleted)
            is what frees the vertical for deletion, done here where the operator can see
            exactly which scope and which names, per the reap-safety lesson. */}
        {boundScopes.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
              <h4 style={{ margin: 0, fontSize: 13 }}>Bound scopes ({boundScopes.length})</h4>
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                installs still on this vertical — move or retire each before the vertical can be deleted
              </span>
              <span style={{ flex: 1 }} />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(allSelected ? new Set() : new Set(boundScopes.map((s) => s.id)))}
              >
                {allSelected ? 'Clear selection' : 'Select all'}
              </Button>
            </div>
            {/* Bulk bar — Move rides the #389 rebind (data-first, source kept as backout);
                Retire wipes storage and is armed by typing the count in its dialog. */}
            {selectedScopes.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 12px',
                  marginBottom: 8,
                  borderRadius: 8,
                  border: '1px solid var(--border-default)',
                  background: 'var(--surface-inset)',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {selectedScopes.length} selected
                </span>
                <span style={{ flex: 1 }} />
                {movableScopes.length > 0 && (
                  <Button size="sm" variant="secondary" disabled={bulkBusy} onClick={() => void openMove()}>
                    Move to vertical… ({movableScopes.length})
                  </Button>
                )}
                <Button size="sm" variant="danger" disabled={bulkBusy} onClick={() => void openBulkRetire()}>
                  Retire… ({selectedScopes.length})
                </Button>
              </div>
            )}
            <Table columns={scopeColumns} rows={boundScopes} emptyText="" />
          </div>
        )}
      </Card>

      {/* Delete — type the slug to confirm. The control plane refuses while any scope is
          still bound, so a mistaken confirm cannot strand a live scope. */}
      <Dialog
        open={deleteInput !== null}
        danger
        title={`Delete ${vertical.slug}`}
        description="Removes the vertical, its versions, and its channels from the registry. Refused while any scope is still bound to it. Deployed scripts are left for orphan cleanup."
        confirmLabel="Delete vertical"
        confirmDisabled={deleteInput !== vertical.slug || boundScopes.length > 0}
        onConfirm={() => {
          void run(() => api.deleteVertical(vertical.slug), 'Vertical deleted', vertical.slug).then(() => {
            setDeleteInput(null);
            onBack();
          });
        }}
        onCancel={() => setDeleteInput(null)}
      >
        {boundScopes.length > 0 && (
          <div style={{ marginBottom: 12, fontSize: 12.5, color: 'var(--status-danger-fg)' }}>
            {boundScopes.length} scope(s) still bound — retire them above first.
          </div>
        )}
        <Input
          label={`Type ${vertical.slug} to confirm`}
          mono
          placeholder={vertical.slug}
          value={deleteInput ?? ''}
          onChange={(e) => setDeleteInput(e.target.value)}
        />
      </Dialog>

      {/* Retire one bound scope — the reap, made visible. Names every hostname it will
          release, and arms behind a type-the-slug confirm because retiring a primary scope
          reaps its storage (a fork is hard-deleted); there is no restore either way. */}
      <Dialog
        open={retire !== null}
        danger
        title={retire ? `Retire ${retire.scope.slug}` : ''}
        description={
          retire?.scope.forkedFrom
            ? 'Deletes this snapshot fork — its storage, hostnames, and directory row. Irreversible.'
            : 'Unbinds every hostname below, then archives and reaps the scope — its storage is wiped. Irreversible; there is no restore.'
        }
        confirmLabel={retire?.scope.forkedFrom ? 'Delete snapshot' : 'Retire scope'}
        confirmDisabled={retireInput !== retire?.scope.slug}
        onConfirm={() => void confirmRetire()}
        onCancel={() => setRetire(null)}
      >
        {retire && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {retire.hostnames.length > 0 ? (
              <div style={{ fontSize: 12.5 }}>
                <div style={{ color: 'var(--text-tertiary)', marginBottom: 6 }}>
                  These names go offline first:
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {retire.hostnames.map((h) => (
                    <Tag key={h} mono>
                      {h}
                    </Tag>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>No hostnames bound.</div>
            )}
            <Input
              label={`Type ${retire.scope.slug} to confirm`}
              mono
              placeholder={retire.scope.slug}
              value={retireInput}
              onChange={(e) => setRetireInput(e.target.value)}
            />
          </div>
        )}
      </Dialog>

      {/* Move — the #389 update-rebind, from the console. Data-first: the target's serving
          script gets the data, the source script stays as the backout, and the control
          plane's digest gate refuses a crossing between diverged migration histories
          unless acknowledged. Forks never move (reap and re-preview against the target). */}
      <Dialog
        open={move !== null}
        title={`Move ${movableScopes.length} scope${movableScopes.length === 1 ? '' : 's'} to another vertical`}
        description="Rebinds each scope onto the target lineage's serving script, data first. The source script is kept as the backout. Refused per scope when the migration digests differ, unless acknowledged."
        confirmLabel={bulkBusy ? 'Moving…' : 'Move scopes'}
        confirmDisabled={bulkBusy || !move?.choice || movableScopes.length === 0}
        onConfirm={() => void confirmMove()}
        onCancel={() => setMove(null)}
      >
        {move && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {movableScopes.map((s) => (
                <Tag key={s.id} mono>
                  {s.slug}
                </Tag>
              ))}
            </div>
            {selectedScopes.length > movableScopes.length && (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {selectedScopes.length - movableScopes.length} selected snapshot fork(s) stay behind — a fork
                cannot be rebound; reap it and re-preview against the target.
              </span>
            )}
            <Select
              label="Target vertical"
              value={move.choice}
              onChange={(e) => setMove({ ...move, choice: e.target.value })}
              options={move.targets.map((t) => ({ value: t.slug, label: `${t.name} — ${t.slug}` }))}
            />
            <Checkbox
              label="Migration histories differ — I have read both"
              description="Only needed when the scope's bound version and the target's serving version carry different migration digests; the control plane refuses the crossing otherwise."
              checked={move.ack}
              onChange={(v) => setMove({ ...move, ack: v })}
            />
          </div>
        )}
      </Dialog>

      {/* Bulk retire — the single-scope retire at selection scale. Names every hostname
          that goes offline, and arms by typing the count (the storage-wiping bulk
          convention from the fleet view): there is no restore. */}
      <Dialog
        open={bulkRetire !== null}
        danger
        title={bulkRetire ? `Retire ${bulkRetire.scopes.length} scope${bulkRetire.scopes.length === 1 ? '' : 's'}` : ''}
        description="For each scope: unbinds its hostnames, then archives and reaps it (a snapshot fork is hard-deleted). Storage is wiped. Irreversible; there is no restore."
        confirmLabel={bulkBusy ? 'Retiring…' : 'Retire scopes'}
        confirmDisabled={bulkBusy || bulkArmed !== String(bulkRetire?.scopes.length ?? 0)}
        onConfirm={() => void confirmBulkRetire()}
        onCancel={() => setBulkRetire(null)}
      >
        {bulkRetire && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 240, overflowY: 'auto' }}>
              {bulkRetire.scopes.map((s) => {
                const names = bulkRetire.hostnames.get(s.id) ?? [];
                return (
                  <div key={s.id} style={{ fontSize: 12.5, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
                    <Tag mono>{s.slug}</Tag>
                    {names.length > 0 ? (
                      names.map((h) => (
                        <span key={h} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>
                          {h}
                        </span>
                      ))
                    ) : (
                      <span style={{ color: 'var(--text-placeholder)' }}>no hostnames</span>
                    )}
                  </div>
                );
              })}
            </div>
            <Input
              label={`Type ${bulkRetire.scopes.length} to confirm`}
              mono
              placeholder={String(bulkRetire.scopes.length)}
              value={bulkArmed}
              onChange={(e) => setBulkArmed(e.target.value)}
            />
          </div>
        )}
      </Dialog>

      {/* Promote — the blast-radius moment. The digest diff is shown, and a changed
          permission or migration surface must be acknowledged before the confirm frees. */}
      <Dialog
        open={promote !== null}
        title={promote ? `Promote ${promote.channel}` : ''}
        description="Point a channel at an admitted version."
        confirmLabel="Promote"
        onConfirm={() => void confirmPromote()}
        onCancel={() => {
          setPromote(null);
          setAck({});
        }}
      >
        {promote && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Select
              label="Version"
              value={promote.versionId}
              onChange={(e) => setPromote({ ...promote, versionId: e.target.value })}
              options={versions
                .filter((v) => v.admission === 'admitted')
                .map((v) => ({ value: v.id, label: `${v.version} — ${v.createdAt.slice(0, 16).replace('T', ' ')}` }))}
            />
            {current && (
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                {promote.channel} currently points at <Tag mono>{current.version}</Tag>.
                {!permChanged && !migChanged ? ' No permission or migration change.' : ' Review the change below.'}
              </p>
            )}
            {permChanged && (
              <Checkbox
                label="Permission surface changed"
                description="The permission digest differs — acknowledge you have read the permission diff."
                checked={!!ack.permissionChange}
                onChange={(v) => setAck((a) => ({ ...a, permissionChange: v }))}
              />
            )}
            {migChanged && (
              <Checkbox
                label="Migrations changed"
                description="The migration digest differs — acknowledge you have read the migration diff."
                checked={!!ack.migrationChange}
                onChange={(v) => setAck((a) => ({ ...a, migrationChange: v }))}
              />
            )}
            {!ackSatisfied && (
              <span style={{ fontSize: 12, color: 'var(--status-warning-fg, var(--text-tertiary))' }}>
                Acknowledge the change to promote.
              </span>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
