import { useEffect, useId, useState, type ReactNode } from 'react';
import { Badge, Button } from '@substrat-run/ui';
import { api, type AppHealthRow, type AppRow } from '../lib/api';
import { DEV_MOCK, MOCK_FLEET_HEALTH } from '../lib/mock';
import { VERDICTS, appVerdict } from '../lib/fleet-rows';
import { navigate, obsPath } from '../lib/router';
import { Ic } from '../lib/icons';
import { Pill, type PillKind } from '../components/ui';

/**
 * The app page's header (#1767): the name with the app's fleet-health verdict beside it,
 * the vertical and hostname under it, and the two ways into Observability narrowed to
 * this app — the flow map and the logs — beside the app's own actions.
 *
 * The verdict is the Apps table's, by the same rule (`appVerdict`), so the row a reader
 * clicked and the page it opened say the same word. Until the health read answers, the
 * header shows the install status it always showed rather than a verdict it has not got.
 */
export function AppHeader({
  app,
  statusKind,
  statusLabel,
  actions,
}: {
  app: AppRow;
  statusKind: PillKind;
  statusLabel: string;
  /** The app's own controls (Visit, the overflow menu), right of the Observability pair. */
  actions?: ReactNode;
}) {
  // `undefined` while asking, `null` when the read failed — which the verdict rule reads
  // as "unknown", the same word the Apps table prints for it. The answer is kept with the
  // scope it was read for: this header stays mounted across app navigation, and the last
  // app's rows would otherwise be judged against the next app for one render ("Unknown").
  const [read, setRead] = useState<{ scopeId: string; rows: AppHealthRow[] | null } | undefined>(undefined);
  useEffect(() => {
    // An app that is not running is judged by its install state alone, so no fleet read.
    if (app.status !== 'active') {
      setRead(undefined);
      return;
    }
    const scopeId = app.app_scope_id;
    if (DEV_MOCK) {
      setRead({ scopeId, rows: MOCK_FLEET_HEALTH });
      return;
    }
    let live = true;
    setRead(undefined);
    // There is no one-app health read; the fleet read is one row per app and the
    // same one the Apps table makes.
    api
      .fleetHealth()
      .then((r) => live && setRead({ scopeId, rows: r.rows }))
      .catch(() => live && setRead({ scopeId, rows: null }));
    return () => {
      live = false;
    };
  }, [app.app_scope_id, app.status]);
  const health = read?.scopeId === app.app_scope_id ? read.rows : undefined;

  // An app that is not running is judged by its install state, which needs no read.
  const installing = app.status !== 'active';
  const judged = installing || health !== undefined ? appVerdict(app, health?.find((h) => h.scopeId === app.app_scope_id)) : null;
  const go = (view: string) => () => navigate(obsPath({ app: app.app_scope_id, view }));

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>{app.name}</h1>
          <button type="button" aria-label="Rename" style={{ border: 0, background: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'inline-flex', padding: 0 }}>
            <Ic name="pencil" size={14} />
          </button>
          {judged ? (
            <VerdictReason verdict={judged.verdict} why={judged.why}>
              <Badge status={VERDICTS[judged.verdict].status}>{VERDICTS[judged.verdict].label}</Badge>
            </VerdictReason>
          ) : (
            <Pill kind={statusKind}>{statusLabel}</Pill>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2, fontSize: 12.5, color: 'var(--text-tertiary)', minWidth: 0 }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{app.vertical_slug}</span>
          {app.hostname && (
            <>
              <span aria-hidden>·</span>
              <a href={`https://${app.hostname}`} target="_blank" rel="noreferrer" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-link)', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                {app.hostname}
              </a>
            </>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button variant="secondary" size="sm" onClick={go('flow')}>Flow map</Button>
        <Button variant="secondary" size="sm" onClick={go('logs')}>Logs</Button>
        {actions}
      </div>
    </div>
  );
}

/**
 * The verdict with its reason on hover and on keyboard focus, tied to it by
 * `aria-describedby` so a screen reader reads the reason too. `Tooltip` from the ui
 * package opens on the pointer only, and a `title` is out of reach of keyboard and touch.
 */
function VerdictReason({ verdict, why, children }: { verdict: string; why: string; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      data-verdict={verdict}
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      style={{ position: 'relative', display: 'inline-flex', borderRadius: 'var(--radius-sm)', cursor: 'default' }}
    >
      {children}
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        style={{
          position: 'absolute',
          top: '100%',
          left: '50%',
          transform: 'translate(-50%,6px)',
          zIndex: 50,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          background: 'var(--surface-inverse)',
          color: 'var(--text-inverse)',
          fontSize: 'var(--text-xs)',
          lineHeight: '16px',
          padding: '5px 8px',
          borderRadius: 'var(--radius-sm)',
          boxShadow: 'var(--shadow-md)',
        }}
      >
        {why}
      </span>
    </span>
  );
}
