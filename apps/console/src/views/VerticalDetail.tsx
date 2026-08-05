import { useCallback, useEffect, useState } from 'react';
import type {
  ChannelName,
  PromotionAcknowledgement,
  Scope,
  Vertical,
  VerticalChannel,
  VerticalVersion,
} from '@substrat-run/contracts';
import { Badge, Button, Card, Checkbox, Dialog, Input, Select, Table, Tag } from '../components';
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
export function VerticalDetail({ api, vertical, onBack, onChanged, onToast }: VerticalDetailProps) {
  const [versions, setVersions] = useState<VerticalVersion[]>([]);
  const [channels, setChannels] = useState<VerticalChannel[]>([]);
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

  const loadDetail = useCallback(
    async (slug: string) => {
      try {
        // Walked in FULL, not one page: the channel cards and the promote picker are
        // computations over the whole version set — a channel pointer whose version fell
        // outside a loaded page would render as "unset", a lie. Only the versions TABLE
        // below windows what it shows.
        const [vs, ch, sc] = await Promise.all([
          walkAll((p) => api.listVersions(slug, p)),
          walkAll((p) => api.listChannels(slug, p)),
          walkAll((p) => api.listScopes({ vertical: slug, ...p })),
        ]);
        setVersions(vs);
        setChannels(ch);
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
    setVersionsShown(PAGE);
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
    { header: 'Scope', render: (s) => <Tag mono>{s.slug}</Tag> },
    { header: 'Status', render: (s) => <Badge status={statusTone(s.status)}>{statusLabel(s.status)}</Badge> },
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
                installs still on this vertical — retire each before the vertical can be deleted
              </span>
            </div>
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
