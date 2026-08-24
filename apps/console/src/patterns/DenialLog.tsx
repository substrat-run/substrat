import { useEffect, useState } from 'react';
import type { Actor, DenialBucket, DenialSummary, PermissionDenial, Scope } from '@substrat-run/contracts';
import { Badge, Button, Card, Table } from '../components';
import type { Api } from '../lib/api';

/**
 * The K-35 denial log, read (#867) — the third of the platform's three logs and the
 * last to get a surface. The admin log holds staff MUTATIONS and the K-24 access log
 * staff READS; these are the refusals, and they live in the scope's own database
 * because a denial rolls back the operation it is evidence of.
 *
 * Why it opens BUCKETED rather than as a list of rows: the volume here is
 * attacker-influenceable by design — a probing client mints unlimited rows — so a
 * newest-first page would let whoever wrote the last hundred push every other actor off
 * the screen. That is the exact failure K-35 named when it called rate-bucketing
 * sanctionable, and the reason the count-ordered view is the default rather than a
 * refinement. Rows are the drill-down behind one bucket.
 */

/** A denial's actor is a principal ULID, a `{ system }` module, or a `{ connection }`. */
function actorLabel(a: Actor): string {
  if (typeof a === 'string') return a;
  if ('system' in a) return a.system;
  return a.connection;
}

function actorKind(a: Actor): 'principal' | 'system' | 'connection' {
  if (typeof a === 'string') return 'principal';
  return 'system' in a ? 'system' : 'connection';
}

/** The filter value the API takes — the logical actor, not its stored JSON encoding. */
function actorFilter(a: Actor): string {
  return typeof a === 'string' ? a : JSON.stringify(a);
}

function ActorRef({ actor }: { actor: Actor }) {
  const kind = actorKind(actor);
  const label = actorLabel(actor);
  const short = kind === 'principal' ? `${label.slice(0, 4)}…${label.slice(-4)}` : label;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span title={label} style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>
        {short}
      </span>
      {/* A refusal against a module or a connector is a different kind of event from one
          against a person, and the log is the one place that distinction is visible. */}
      {kind !== 'principal' && <Badge status="neutral" dot={false}>{kind}</Badge>}
    </span>
  );
}

const stamp = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');

export function DenialLog({ api, scope }: { api: Api; scope: Scope }) {
  const [summary, setSummary] = useState<DenialSummary | null>(null);
  const [failed, setFailed] = useState(false);
  // Which bucket is expanded, and its rows. Null = the bucketed view.
  const [open, setOpen] = useState<DenialBucket | null>(null);
  const [rows, setRows] = useState<PermissionDenial[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setFailed(false);
    setOpen(null);
    api
      .denialSummary(scope.tenantId, scope.id)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        // A scope whose vertical deployment cannot be reached has no readable log —
        // that is a fact about the deployment, not a console error worth a banner.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, scope]);

  useEffect(() => {
    if (!open) {
      setRows(null);
      return;
    }
    let cancelled = false;
    api
      .listDenials(scope.tenantId, scope.id, {
        actor: actorFilter(open.actor),
        permission: open.permission,
      })
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, scope, open]);

  if (failed || !summary) return null;

  // The window is a STORAGE bound, not a retention policy (K-35): rows drain rather than
  // expire, and until a Tier-2 sink exists what is held is simply what has not been
  // pruned. Saying so where the numbers are is what stops an empty log being read as
  // "nothing was ever refused" — the caption is load-bearing, not decoration.
  const window = summary.windowOldestAt
    ? `${summary.total} refusal${summary.total === 1 ? '' : 's'} from ${summary.actors} actor${
        summary.actors === 1 ? '' : 's'
      }, held since ${stamp(summary.windowOldestAt)}`
    : 'No refusals held.';

  return (
    <Card
      title="Denials"
      description={`${window} · this window is what the scope still holds, not a retention promise — rows drain rather than expire (K-35).`}
      actions={
        open ? (
          <Button variant="secondary" onClick={() => setOpen(null)}>
            ← All actors
          </Button>
        ) : undefined
      }
    >
      {open ? (
        <>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            <code style={{ fontFamily: 'var(--font-mono)' }}>{open.permission}</code> refused
            for <ActorRef actor={open.actor} /> — {open.count} time
            {open.count === 1 ? '' : 's'} across {open.operations} operation
            {open.operations === 1 ? '' : 's'}.
          </p>
          <Table<PermissionDenial>
            rows={rows ?? []}
            emptyText={rows === null ? 'Loading…' : 'No rows.'}
            columns={[
              { header: 'When', render: (r) => stamp(r.at), mono: true, muted: true },
              { header: 'Operation', render: (r) => r.operation ?? '—', mono: true },
              { header: 'Permission', render: (r) => r.permission, mono: true },
            ]}
          />
        </>
      ) : (
        <Table<DenialBucket>
          rows={summary.buckets}
          emptyText="Nothing has been refused in this window."
          onRowClick={(b) => setOpen(b)}
          columns={[
            { header: 'Actor', render: (b) => <ActorRef actor={b.actor} /> },
            { header: 'Permission', render: (b) => b.permission, mono: true },
            { header: 'Refusals', render: (b) => String(b.count), align: 'right' },
            {
              // One operation refused four hundred times is a broken screen or a
              // misconfigured role; the same count spread across a dozen is someone
              // walking the surface. It is the cheapest discriminator the log offers.
              header: 'Operations',
              render: (b) => String(b.operations),
              align: 'right',
              muted: true,
            },
            { header: 'First', render: (b) => stamp(b.firstAt), mono: true, muted: true },
            { header: 'Last', render: (b) => stamp(b.lastAt), mono: true, muted: true },
          ]}
        />
      )}
    </Card>
  );
}
