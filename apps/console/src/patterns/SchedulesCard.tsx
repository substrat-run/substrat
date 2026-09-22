import { useEffect, useRef, useState } from 'react';
import type { ModuleId, Scope, SystemGrantsStatusEntry } from '@substrat-run/contracts';
import { Badge, Button, Card, Dialog, Input, Table } from '../components';
import type { Api } from '../lib/api';
import { schedulesCardState, scheduleBadgeStatus, submitSwitch, validReason } from '../lib/schedules';
import { ActorCell } from './ActorCell';

const stamp = (iso: string) => iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');

const label: Record<SystemGrantsStatusEntry['schedules'], string> = {
  on: 'On',
  off: 'Off',
  ungranted: 'Ungranted',
};

/**
 * The #1666 kill switch's console control (#1675) — one module's scheduled work, on
 * or off, per scope. Reads its position from the status read (#1674,
 * `GET .../system-grants`) and moves it over the same route the switch itself uses
 * (#1676). No separate admin-log call: the status read already joins in who switched
 * a module off, when, and why (`switchedOff`), which is everything this card needs to
 * show — pulling the admin log a second time here would read the same fact twice and
 * risk the two disagreeing.
 */
export function SchedulesCard({
  api,
  scope,
  onToast,
}: {
  api: Api;
  scope: Scope;
  onToast: (title: string, detail?: string, status?: 'success' | 'danger') => void;
}) {
  const [entries, setEntries] = useState<SystemGrantsStatusEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dialog, setDialog] = useState<{ moduleId: ModuleId; to: 'on' | 'off' } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // A ref, not `useState`: two clicks on Confirm in the same tick both see a `useState`
  // flag as false, because the setter only lands on the next render (#1702 review).
  const switching = useRef(false);

  async function load() {
    return api.systemGrantsStatus(scope.tenantId, scope.id);
  }

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    load()
      .then((e) => {
        if (!cancelled) setEntries(e);
      })
      .catch((e) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scope.tenantId, scope.id]);

  const state = schedulesCardState(entries, error);

  async function confirmSwitch() {
    if (!dialog || switching.current) return;
    const { moduleId, to } = dialog;
    const trimmed = reason.trim();
    if (!validReason(trimmed)) return;
    setBusy(true);
    try {
      const result = await submitSwitch(switching, () =>
        to === 'off'
          ? api.switchScheduleOff(scope.tenantId, scope.id, moduleId, trimmed)
          : api.switchScheduleOn(scope.tenantId, scope.id, moduleId, trimmed),
      );
      if (result === null) return; // a submit was already in flight — this click was skipped
      // Re-read rather than assume: the switch may have answered `changed: false` (a
      // repeat), and the delegated write for a hosted scope is a second hop this
      // console never saw succeed until it asks again.
      const fresh = await load();
      setEntries(fresh);
      setError(null);
      setDialog(null);
      setReason('');
      onToast(
        to === 'off' ? 'Schedules switched off' : 'Schedules switched back on',
        `${moduleId} on ${scope.slug}${result.changed ? '' : ' · already in that position'}`,
      );
    } catch (e) {
      onToast('Refused', (e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Schedules"
      description="The #1666 kill switch — one module's scheduled work, on or off, per scope. Restore is the only way back on; a grant is not."
    >
      {state.kind === 'loading' && (
        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>Loading…</p>
      )}
      {state.kind === 'predates' && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <Badge status="warning">Redeploy needed</Badge>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: '18px' }}>
            This scope's deployment predates the schedule switch (#1666/#1674). Redeploy the
            vertical, then retry — nothing here can be read or moved until then.
          </p>
        </div>
      )}
      {state.kind === 'error' && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <Badge status="danger">Unavailable</Badge>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: '18px' }}>
            {state.message}
          </p>
        </div>
      )}
      {state.kind === 'ready' &&
        (state.entries.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            No module has held scheduled-work authority on this scope yet.
          </p>
        ) : (
          <Table<SystemGrantsStatusEntry>
            rows={state.entries}
            columns={[
              { header: 'Module', key: 'moduleId', mono: true },
              {
                header: 'Position',
                render: (e) => <Badge status={scheduleBadgeStatus(e.schedules)}>{label[e.schedules]}</Badge>,
              },
              {
                header: 'Switched off',
                render: (e) =>
                  e.switchedOff ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <ActorCell actor={e.switchedOff.actor} />
                      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                        “{e.switchedOff.reason}”
                      </span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>
                        {stamp(e.switchedOff.at)}
                      </span>
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  ),
              },
              {
                header: 'Action',
                align: 'right',
                render: (e) =>
                  e.schedules === 'ungranted' ? (
                    <span style={{ color: 'var(--text-tertiary)' }}>—</span>
                  ) : (
                    <Button
                      variant={e.schedules === 'on' ? 'danger' : 'secondary'}
                      size="sm"
                      onClick={() => {
                        setDialog({ moduleId: e.moduleId, to: e.schedules === 'on' ? 'off' : 'on' });
                        setReason('');
                      }}
                    >
                      {e.schedules === 'on' ? `Turn off ${e.moduleId}` : `Turn back on ${e.moduleId}`}
                    </Button>
                  ),
              },
            ]}
          />
        ))}

      <Dialog
        open={dialog !== null}
        title={dialog ? `${dialog.to === 'off' ? 'Turn off' : 'Turn back on'} ${dialog.moduleId}?` : ''}
        description={
          dialog?.to === 'off'
            ? "Nothing acting with this module's system authority — a job run, a getSystemScope invoke — runs on this scope until it is restored. Its schedules are reported skipped, never failed."
            : 'Restores exactly the grants this switch took. A grant revoked separately before the switch was pulled stays revoked.'
        }
        danger={dialog?.to === 'off'}
        confirmLabel={dialog?.to === 'off' ? 'Turn off' : 'Turn back on'}
        width={480}
        busy={busy}
        confirmDisabled={!validReason(reason)}
        onConfirm={confirmSwitch}
        onCancel={() => {
          setDialog(null);
          setReason('');
        }}
      >
        <Input
          label="Reason"
          placeholder="Why is this switch moving?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Dialog>
    </Card>
  );
}
