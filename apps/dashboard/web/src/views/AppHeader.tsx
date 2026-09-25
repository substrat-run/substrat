import { useEffect, useState, type ReactNode } from 'react';
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
  // as "unknown", the same word the Apps table prints for it.
  const [health, setHealth] = useState<AppHealthRow[] | null | undefined>(undefined);
  useEffect(() => {
    if (DEV_MOCK) {
      setHealth(MOCK_FLEET_HEALTH);
      return;
    }
    let live = true;
    setHealth(undefined);
    // There is no one-app health read; the fleet read is one row per app and the
    // same one the Apps table makes.
    api
      .fleetHealth()
      .then((r) => live && setHealth(r.rows))
      .catch(() => live && setHealth(null));
    return () => {
      live = false;
    };
  }, [app.app_scope_id, app.status]);

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
            <span data-verdict={judged.verdict} title={judged.why} style={{ display: 'inline-flex' }}>
              <Badge status={VERDICTS[judged.verdict].status}>{VERDICTS[judged.verdict].label}</Badge>
            </span>
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
