import { useEffect, useState } from 'react';
import type { Vertical, VerticalSource } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, Select, Table, Tag } from '../components';
import type { TableColumn } from '../components';
import { walkAll } from '../lib/api';
import type { Api } from '../lib/api';
import { usePagedList } from '../lib/use-paged-list';
import { VerticalDetail } from './VerticalDetail';

/**
 * The vertical + version registry (orchestration.md §5.7) — where the two human
 * checkpoints live. This surface is the LIST: the registry of verticals, the publish
 * queue and provisioner requests as badges, and the one producer action a console can
 * own (Register). Opening a row routes to the full detail (`VerticalDetail`), where
 * admission, promotion, listing, retiring bound scopes, and deletion happen.
 */

export interface VerticalsProps {
  api: Api;
  /** The slug whose detail is open (App owns the URL); undefined = the list. */
  openSlug?: string;
  onOpen: (slug: string) => void;
  onBack: () => void;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}

export function Verticals({ api, openSlug, onOpen, onBack, onToast }: VerticalsProps) {
  // Bumped after every mutation — the paged list's refresh signal (the hook re-reads the
  // loaded window, so a flag flip on page 3 still shows) and the detail-resolve
  // dependency, so a mutation in the detail re-reads the row it drilled into.
  const [refresh, setRefresh] = useState(0);
  const verticalsPage = usePagedList(
    (p) => api.listVerticals(p),
    [api, refresh],
    (e) => onToast('Failed to load verticals', e.message, 'danger'),
  );
  const verticals = verticalsPage.entries;

  // The opened vertical, resolved from the loaded window. A deep link may target a slug
  // outside the first page — walk the registry once to find it (it is small).
  const [resolved, setResolved] = useState<Vertical | undefined>();
  useEffect(() => {
    if (!openSlug) {
      setResolved(undefined);
      return;
    }
    const inWindow = verticals.find((v) => v.slug === openSlug);
    if (inWindow) {
      setResolved(inWindow);
      return;
    }
    let cancelled = false;
    void walkAll((p) => api.listVerticals(p))
      .then((all) => {
        if (!cancelled) setResolved(all.find((v) => v.slug === openSlug));
      })
      .catch(() => {
        if (!cancelled) setResolved(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [openSlug, verticals, api, refresh]);

  const [showRegister, setShowRegister] = useState(false);
  const [reg, setReg] = useState<{ slug: string; name: string; source: VerticalSource }>({
    slug: '',
    name: '',
    source: 'builtin',
  });

  async function run(fn: () => Promise<unknown>, title: string, detail?: string) {
    try {
      await fn();
      setRefresh((n) => n + 1);
      onToast(title, detail);
    } catch (e) {
      onToast('Refused', (e as Error).message, 'danger');
    }
  }

  const verticalColumns: TableColumn<Vertical>[] = [
    { header: 'Slug', render: (v) => <Tag mono>{v.slug}</Tag> },
    { header: 'Name', render: (v) => v.name },
    { header: 'Source', render: (v) => <Tag mono>{v.source}</Tag> },
    {
      // The publish queue lives here: a pending request is a builder waiting on staff, so
      // it must be visible from the list, not only after opening the row.
      header: 'Marketplace',
      render: (v) =>
        v.listed ? (
          <Badge status="success">listed</Badge>
        ) : v.publishRequestedAt ? (
          <Badge status="warning">publish requested {v.publishRequestedAt.slice(0, 10)}</Badge>
        ) : (
          <span style={{ color: 'var(--text-placeholder)', fontSize: 12.5 }}>private</span>
        ),
    },
    {
      header: 'Installs',
      render: (v) =>
        v.installsBlocked ? (
          <Badge status="danger">blocked</Badge>
        ) : (
          <span style={{ color: 'var(--text-placeholder)', fontSize: 12.5 }}>open</span>
        ),
    },
    {
      // The tenant-provisioner GRANT (#412/#444): platform authority a push can never
      // confer, so holding it must be visible from the list, like the publish queue. A
      // manifest-declared `provisions` without the grant is a pending REQUEST (#455) —
      // the same review shape as a publish request.
      header: 'Capability',
      render: (v) =>
        v.tenantProvisioner ? (
          <Badge status="warning">tenant provisioner</Badge>
        ) : v.provisions?.length ? (
          <Badge status="info">provisioner requested</Badge>
        ) : (
          <span style={{ color: 'var(--text-placeholder)', fontSize: 12.5 }}>—</span>
        ),
    },
    { header: 'Created', render: (v) => v.createdAt.slice(0, 10), mono: true, muted: true, width: 110 },
  ];

  // A resolved open slug routes to the full detail; App owns the URL, this owns the data.
  if (openSlug && resolved) {
    return (
      <VerticalDetail
        api={api}
        vertical={resolved}
        onBack={onBack}
        onChanged={() => setRefresh((n) => n + 1)}
        onToast={onToast}
      />
    );
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
          onRowClick={(v) => onOpen(v.slug)}
          emptyText="No verticals registered yet."
        />
        {verticalsPage.nextCursor && (
          <div style={{ padding: 12, display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" size="sm" onClick={() => void verticalsPage.loadMore()}>
              Load more
            </Button>
          </div>
        )}
      </Card>

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
    </div>
  );
}
