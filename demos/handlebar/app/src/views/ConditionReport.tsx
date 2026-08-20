import { useCallback, useEffect, useState } from 'react';
import {
  api,
  extra,
  type ProtocolDetail,
  type ProtocolItem,
  type ProtocolSummary,
  type Repair,
} from '../api';

/**
 * Tillståndsrapport (per-bike condition report) — the milestone-B slice on
 * the extracted protocol engine. The workshop opens and fills it during the
 * repair, the verkstadschef signs (freezes it), and the CUSTOMER counter-signs
 * the frozen content at pickup. Everything here calls protocol/* engine
 * operations (plus the vertical's start wrapper) — the invariants live in the
 * engine, not in this UI.
 */

const STATUS_LABEL: Record<string, string> = {
  open: 'Öppen',
  signed: 'Signerad',
  voided: 'Makulerad',
};

function ItemRow({
  item,
  detail,
  readOnly,
  onSaved,
  onError,
}: {
  item: ProtocolItem;
  detail: ProtocolDetail;
  readOnly: boolean;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const latest = detail.latest[item.key];
  const current: unknown = latest ? JSON.parse(latest.value_json) : undefined;
  const frozen = readOnly || detail.instance.status !== 'open';
  const history = detail.responses.filter((r) => r.item_key === item.key);
  const [draft, setDraft] = useState(typeof current === 'string' ? current : '');

  const save = async (value: boolean | string) => {
    try {
      await api.protocolFill({ instanceId: detail.instance.id, itemKey: item.key, value });
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <tr>
      <td style={{ width: '55%' }}>
        {item.label}
        {history.length > 1 && (
          <span
            className="muted"
            style={{ marginLeft: 6, fontSize: 11 }}
            title={history
              .map((r) => `${JSON.parse(r.value_json)} · ${new Date(r.responded_at).toLocaleTimeString('sv-SE')}`)
              .join('  →  ')}
          >
            ({history.length} införingar)
          </span>
        )}
      </td>
      <td>
        {item.type === 'check' ? (
          <input
            type="checkbox"
            checked={current === true}
            disabled={frozen}
            onChange={(e) => save(e.target.checked)}
          />
        ) : frozen ? (
          <span>{typeof current === 'string' ? current : <span className="muted">—</span>}</span>
        ) : (
          <span className="row" style={{ gap: 6 }}>
            <input
              style={{ width: item.type === 'value' ? 90 : 220 }}
              value={draft}
              placeholder={typeof current === 'string' ? current : ''}
              onChange={(e) => setDraft(e.target.value)}
            />
            {item.unit && <span className="muted">{item.unit}</span>}
            <button className="btn" disabled={!draft} onClick={() => save(draft)}>
              Spara
            </button>
          </span>
        )}
        {item.type === 'value' && frozen && item.unit && current !== undefined && (
          <span className="muted"> {item.unit}</span>
        )}
      </td>
    </tr>
  );
}

function ReportCard({
  instanceId,
  portal,
  onChanged,
}: {
  instanceId: string;
  portal: boolean;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ProtocolDetail | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.protocolGet({ instanceId }).then(setDetail).catch((e: Error) => setError(e.message));
  }, [instanceId]);
  useEffect(load, [load]);

  if (!detail) return <p className="muted">{error || 'Laddar…'}</p>;
  const { instance, template, signatures } = detail;
  const primary = signatures.find((s) => s.kind === 'primary');
  const counters = signatures.filter((s) => s.kind === 'counter');
  const refresh = () => {
    setError('');
    load();
    onChanged();
  };

  const act = (fn: () => Promise<unknown>) => async () => {
    setError('');
    try {
      await fn();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      {error && <div className="alert error">{error}</div>}
      {/*
        `content` is a union — a checklist has sections, a DOCUMENT protocol has a hash
        recipe and no items. The hand-written `ProtocolDetail` this file used to import
        declared only the checklist arm, so a document instance would have thrown on
        `.sections` of undefined. The generated type carries the engine's real union.
      */}
      {template.content.kind !== 'checklist' ? (
        <p className="muted" style={{ marginTop: 8 }}>
          Detta är ett dokumentprotokoll ({template.content.documentType}) — det signeras i sin
          helhet, inte rad för rad.
        </p>
      ) : (
        template.content.sections.map((section) => (
        <div key={section.title} style={{ marginBottom: 8 }}>
          <h3 style={{ fontSize: 13, margin: '10px 0 4px' }}>{section.title}</h3>
          <table className="grid">
            <tbody>
              {section.items.map((item) => (
                <ItemRow
                  key={item.key}
                  item={item}
                  detail={detail}
                  readOnly={portal}
                  onSaved={refresh}
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        </div>
        ))
      )}

      {!portal && instance.status === 'open' && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={act(() => api.protocolSign({ instanceId: instance.id }))}>
            Signera (fryser rapporten)
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Efter signering kan svaren aldrig ändras; kunden motsignerar exakt detta innehåll
            vid uthämtning.
          </span>
        </div>
      )}

      {portal && instance.status === 'signed' && counters.length === 0 && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={act(() => api.protocolCountersign({ instanceId: instance.id }))}>
            Motsignera vid uthämtning
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Du signerar exakt det frysta innehållet ovan — verkstaden kan inte ändra det efteråt.
          </span>
        </div>
      )}

      {primary && (
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Signerad {new Date(primary.signed_at).toLocaleString('sv-SE')} · metod {primary.method} ·
          innehålls-hash <code>{primary.content_hash}</code>
        </p>
      )}
      {counters.map((c) => (
        <p key={c.id} className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Motsignerad av kunden {new Date(c.signed_at).toLocaleString('sv-SE')} · samma
          innehålls-hash — andra signaturen på samma frysta innehåll.
        </p>
      ))}
      {instance.status === 'voided' && (
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Makulerad: {instance.voided_reason}
        </p>
      )}
    </div>
  );
}

export function ConditionReportPanel({ repair, portal = false }: { repair: Repair; portal?: boolean }) {
  const [reports, setReports] = useState<ProtocolSummary[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    extra.repairProtocols(repair.id).then(setReports).catch(() => setReports([]));
  }, [repair.id]);
  useEffect(load, [load]);

  const repairOpen = repair.status === 'planned' || repair.status === 'in_progress';

  const start = async () => {
    setError('');
    try {
      const inst = await api.startConditionReport({ orderId: repair.id });
      setExpanded(inst.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (portal && reports.length === 0) return null;

  return (
    <div className="card">
      <h2>Tillståndsrapport</h2>
      {error && <div className="alert error">{error}</div>}

      {reports.length === 0 && <p className="muted">Ingen tillståndsrapport på denna reparation.</p>}
      {reports.map((p) => (
        <div key={p.instance.id} style={{ marginBottom: 8 }}>
          <div className="row">
            <button
              className="btn"
              onClick={() => setExpanded(expanded === p.instance.id ? null : p.instance.id)}
            >
              {expanded === p.instance.id ? '▾' : '▸'} {p.title}
            </button>
            <span className={`pill ${p.instance.status}`}>
              {STATUS_LABEL[p.instance.status] ?? p.instance.status}
            </span>
            <span className="muted">
              {p.answered}/{p.total} punkter
              {p.countersignedBy
                ? ' · motsignerad av kunden'
                : p.instance.status === 'signed'
                  ? ' · väntar på kundens motsignering'
                  : ''}
            </span>
          </div>
          {expanded === p.instance.id && (
            <ReportCard instanceId={p.instance.id} portal={portal} onChanged={load} />
          )}
        </div>
      ))}

      {!portal && repairOpen && !reports.some((p) => p.instance.status === 'open') && (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn" onClick={start}>
            Starta tillståndsrapport
          </button>
        </div>
      )}
    </div>
  );
}
