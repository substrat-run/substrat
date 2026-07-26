import { useCallback, useEffect, useState } from 'react';
import type {
  ChannelName,
  PromotionAcknowledgement,
  Vertical,
  VerticalChannel,
  VerticalSource,
  VerticalVersion,
} from '@substrat-run/contracts';
import { Badge, Button, Card, Checkbox, Dialog, Input, Select, Table, Tag } from '../components';
import type { TableColumn } from '../components';
import type { Api } from '../lib/api';

/**
 * The vertical + version registry (orchestration.md §5.7) — where the two human
 * checkpoints live. Publishing a version is a producer action (CI/CLI, with digests
 * from a build), so this surface does not hand-enter one; what it OWNS is the staff
 * side: admit or reject a pending version, and promote a channel — which refuses a
 * changed permission or migration digest unless it is acknowledged here, in the open.
 */

export interface VerticalsProps {
  api: Api;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

const CHANNELS: readonly ChannelName[] = ['dev', 'staging', 'prod'];

const admissionTone = (a: VerticalVersion['admission']): 'success' | 'danger' | 'warning' =>
  a === 'admitted' ? 'success' : a === 'rejected' ? 'danger' : 'warning';

export function Verticals({ api, onToast }: VerticalsProps) {
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [selected, setSelected] = useState<Vertical>();
  const [versions, setVersions] = useState<VerticalVersion[]>([]);
  const [channels, setChannels] = useState<VerticalChannel[]>([]);

  const [showRegister, setShowRegister] = useState(false);
  const [reg, setReg] = useState<{ slug: string; name: string; source: VerticalSource }>({
    slug: '',
    name: '',
    source: 'builtin',
  });

  // The promote dialog: a target (channel, version) plus the acknowledgements the
  // digest diff requires. Null when closed.
  const [promote, setPromote] = useState<{ channel: ChannelName; versionId: string } | null>(null);
  const [ack, setAck] = useState<PromotionAcknowledgement>({});

  // The delete dialog's type-to-confirm guard. Null when closed.
  const [deleteInput, setDeleteInput] = useState<string | null>(null);

  const loadVerticals = useCallback(async () => {
    try {
      const vs = await api.listVerticals();
      setVerticals(vs);
      // Keep the detail card on the FRESH row (a flag flip must show), and close it
      // when the vertical is gone (a delete).
      setSelected((cur) => (cur ? vs.find((v) => v.slug === cur.slug) : cur));
    } catch (e) {
      onToast('Failed to load verticals', (e as Error).message, 'danger');
    }
  }, [api, onToast]);

  const loadDetail = useCallback(
    async (slug: string) => {
      try {
        const [vs, ch] = await Promise.all([api.listVersions(slug), api.listChannels(slug)]);
        setVersions(vs);
        setChannels(ch);
      } catch (e) {
        onToast('Failed to load versions', (e as Error).message, 'danger');
      }
    },
    [api, onToast],
  );

  useEffect(() => {
    void loadVerticals();
  }, [loadVerticals]);

  function openVertical(v: Vertical) {
    setSelected(v);
    setVersions([]);
    setChannels([]);
    void loadDetail(v.slug);
  }

  async function run(fn: () => Promise<unknown>, title: string, detail?: string) {
    try {
      await fn();
      await Promise.all([loadVerticals(), selected ? loadDetail(selected.slug) : Promise.resolve()]);
      onToast(title, detail);
    } catch (e) {
      onToast('Refused', (e as Error).message, 'danger');
    }
  }

  const versionById = (id: string) => versions.find((v) => v.id === id);
  const channelVersion = (ch: ChannelName) =>
    versionById(channels.find((c) => c.channel === ch)?.versionId ?? '');

  // What the promote dialog must surface: which digests differ between the version
  // being promoted and the one the channel points at now. A first promotion has
  // nothing to diff against, so nothing to acknowledge.
  const target = promote ? versionById(promote.versionId) : undefined;
  const current = promote ? channelVersion(promote.channel) : undefined;
  const permChanged = !!(current && target && current.permissionDigest !== target.permissionDigest);
  const migChanged = !!(current && target && current.migrationDigest !== target.migrationDigest);
  const ackSatisfied = (!permChanged || ack.permissionChange) && (!migChanged || ack.migrationChange);

  const verticalColumns: TableColumn<Vertical>[] = [
    { header: 'Slug', render: (v) => <Tag mono>{v.slug}</Tag> },
    { header: 'Name', render: (v) => v.name },
    { header: 'Source', render: (v) => <Tag mono>{v.source}</Tag> },
    {
      header: 'Installs',
      render: (v) =>
        v.installsBlocked ? (
          <Badge status="danger">blocked</Badge>
        ) : (
          <span style={{ color: 'var(--text-placeholder)', fontSize: 12.5 }}>open</span>
        ),
    },
    { header: 'Created', render: (v) => v.createdAt.slice(0, 10), mono: true, muted: true, width: 110 },
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
              onClick={() => run(() => api.admitVersion(selected!.slug, v.id), 'Version admitted', v.version)}
            >
              Admit
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() =>
                run(() => api.rejectVersion(selected!.slug, v.id, 'rejected from console'), 'Version rejected', v.version)
              }
            >
              Reject
            </Button>
          </span>
        ) : null,
    },
  ];

  async function confirmPromote() {
    if (!promote || !selected) return;
    if (!ackSatisfied) {
      onToast('Acknowledge the change to promote', 'The permission or migration surface changed.', 'danger');
      return;
    }
    await run(
      () => api.promoteVersion(selected.slug, promote.channel, promote.versionId, ack),
      `Promoted ${promote.channel}`,
      versionById(promote.versionId)?.version,
    );
    setPromote(null);
    setAck({});
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>
            Verticals
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text-tertiary)' }}>
            The version registry. A push lands a version <em>pending</em>; admission and channel
            promotion are the two human checkpoints, and binding a scope needs an admitted version.
          </p>
        </div>
        <Button icon={<span>+</span>} onClick={() => setShowRegister(true)}>
          Register vertical
        </Button>
      </div>

      <Card padding={0}>
        <Table
          columns={verticalColumns}
          rows={verticals}
          onRowClick={openVertical}
          emptyText="No verticals registered yet."
        />
      </Card>

      {selected && (
        <Card
          title={selected.name}
          description={`Versions and channels — ${selected.slug}`}
          actions={
            <span style={{ display: 'inline-flex', gap: 8 }}>
              <Button
                variant="secondary"
                onClick={() =>
                  run(
                    () => api.setInstallsBlocked(selected.slug, !selected.installsBlocked),
                    selected.installsBlocked ? 'Installs allowed' : 'Installs blocked',
                    selected.slug,
                  )
                }
              >
                {selected.installsBlocked ? 'Allow installs' : 'Block installs'}
              </Button>
              <Button variant="danger" onClick={() => setDeleteInput('')}>
                Delete…
              </Button>
              <Button variant="secondary" onClick={() => setSelected(undefined)}>
                Close
              </Button>
            </span>
          }
        >
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

          <Table columns={versionColumns} rows={versions} emptyText="No versions published yet." />
        </Card>
      )}

      {/* Register a vertical — the only producer action on this surface; publishing a
          version needs digests from a build and stays with CI/CLI. */}
      <Dialog
        open={showRegister}
        title="Register a vertical"
        description="A slug a scope can be pinned to, and a display name."
        confirmLabel="Register"
        onConfirm={() =>
          void run(() => api.registerVertical(reg), 'Vertical registered', reg.slug).then(() => {
            setShowRegister(false);
            setReg({ slug: '', name: '', source: 'builtin' });
          })
        }
        onCancel={() => setShowRegister(false)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input label="Slug" mono placeholder="fsm" value={reg.slug} onChange={(e) => setReg({ ...reg, slug: e.target.value })} />
          <Input label="Name" placeholder="Field Service" value={reg.name} onChange={(e) => setReg({ ...reg, name: e.target.value })} />
          <Select
            label="Source"
            value={reg.source}
            onChange={(e) => setReg({ ...reg, source: e.target.value as VerticalSource })}
            options={[
              { value: 'builtin', label: 'builtin — one we ship' },
              { value: 'git', label: 'git — a customer repo' },
              { value: 'cli', label: 'cli — pushed from the CLI' },
            ]}
          />
        </div>
      </Dialog>

      {/* Delete — type the slug to confirm. The control plane refuses while any scope
          is still bound, so a mistaken confirm cannot strand a live scope. */}
      <Dialog
        open={deleteInput !== null && !!selected}
        danger
        title={selected ? `Delete ${selected.slug}` : ''}
        description="Removes the vertical, its versions, and its channels from the registry. Refused while any scope is still bound to it. Deployed scripts are left for orphan cleanup."
        confirmLabel="Delete vertical"
        confirmDisabled={deleteInput !== selected?.slug}
        onConfirm={() => {
          if (!selected) return;
          void run(() => api.deleteVertical(selected.slug), 'Vertical deleted', selected.slug).then(
            () => setDeleteInput(null),
          );
        }}
        onCancel={() => setDeleteInput(null)}
      >
        <Input
          label={`Type ${selected?.slug ?? ''} to confirm`}
          mono
          placeholder={selected?.slug}
          value={deleteInput ?? ''}
          onChange={(e) => setDeleteInput(e.target.value)}
        />
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
