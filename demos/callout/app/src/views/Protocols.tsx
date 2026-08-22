import { useCallback, useEffect, useState } from 'react';
import {
  api,
  extra,
  type ProtocolDetail,
  type ProtocolItem,
  type ProtocolSummary,
  type ProtocolTemplate,
  type WorkOrder,
} from '../api';

/**
 * Self-inspection v0 fill/sign slice (spec views.md §1.2; engine-protocol.md
 * milestone A). Everything here calls callout/* protocol operations — the
 * invariants (sign freezes, append-only responses) live in the operations,
 * not in this UI.
 */

const STATUS_LABEL: Record<string, string> = {
  open: 'Öppen',
  signed: 'Signerad',
  voided: 'Makulerad',
};

function ItemRow({
  item,
  detail,
  onSaved,
  onError,
}: {
  item: ProtocolItem;
  detail: ProtocolDetail;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const latest = detail.latest[item.key];
  const current: unknown = latest ? JSON.parse(latest.value_json) : undefined;
  const frozen = detail.instance.status !== 'open';
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

function ProtocolDetailCard({
  instanceId,
  onChanged,
}: {
  instanceId: string;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ProtocolDetail | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.protocolGet({ instanceId }).then(setDetail).catch((e: Error) => setError(e.message));
  }, [instanceId]);
  useEffect(load, [load]);

  if (!detail) return <p className="muted">Laddar…</p>;
  const { instance, template, signature } = detail;
  const refresh = () => {
    setError('');
    load();
    onChanged();
  };

  const sign = async () => {
    setError('');
    try {
      await api.protocolSign({ instanceId: instance.id });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div style={{ marginTop: 12 }}>
      {error && <div className="alert error">{error}</div>}
      {/*
        `content` is a union — a checklist has sections, a DOCUMENT protocol has a
        hash recipe and no items at all. The hand-written `ProtocolDetail` this file
        used to import declared only the checklist arm, so a document instance would
        have thrown on `.sections` of undefined with nothing to warn about it. The
        generated type carries the engine's actual union, which is what makes this
        branch necessary rather than optional.
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
                  onSaved={refresh}
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        </div>
        ))
      )}
      {instance.status === 'open' && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={sign}>
            Signera (fryser protokollet)
          </button>
          <span className="muted" style={{ fontSize: 12 }}>
            Efter signering kan svaren aldrig ändras — historiken är revisionsmaterial.
          </span>
        </div>
      )}
      {signature && (
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Signerad {new Date(signature.signed_at).toLocaleString('sv-SE')} · metod{' '}
          {signature.method} · innehålls-hash <code>{signature.content_hash}</code>
        </p>
      )}
      {instance.status === 'voided' && (
        <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Makulerad: {instance.voided_reason}
        </p>
      )}
    </div>
  );
}

export function ProtocolPanel({ order }: { order: WorkOrder }) {
  const [protocols, setProtocols] = useState<ProtocolSummary[]>([]);
  const [templates, setTemplates] = useState<ProtocolTemplate[]>([]);
  const [templateKey, setTemplateKey] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    extra.orderProtocols(order.id).then(setProtocols).catch(() => setProtocols([]));
    api.protocolListTemplates().then((page) => setTemplates(page.entries)).catch(() => setTemplates([]));
  }, [order.id]);
  useEffect(load, [load]);

  // Callout policy mirrored for the hint only — the block itself is
  // enforced server-side in callout/complete-workorder (the guard).
  const requiredKeys = order.kind === 'montage' ? ['self-inspection-electrical'] : [];
  const missing = requiredKeys.filter(
    (k) => !protocols.some((p) => p.instance.template_key === k && p.instance.status === 'signed'),
  );
  const orderOpen = order.status === 'planned' || order.status === 'in_progress';

  const start = async () => {
    setError('');
    try {
      const inst = await api.instantiateProtocol({ entityType: 'workorder', entityId: order.id, templateKey });
      setExpanded(inst.id);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <h2>Self-inspection / protokoll</h2>
      {missing.length > 0 && orderOpen && (
        <div className="alert warn">
          Obligatoriskt för slutförande: {missing.join(', ')} måste vara signerad.
        </div>
      )}
      {error && <div className="alert error">{error}</div>}

      {protocols.length === 0 && <p className="muted">Inga protokoll på denna order.</p>}
      {protocols.map((p) => (
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
              {p.answered}/{p.total} punkter · mall {p.instance.template_key} v
              {p.instance.template_version}
            </span>
          </div>
          {expanded === p.instance.id && (
            <ProtocolDetailCard instanceId={p.instance.id} onChanged={load} />
          )}
        </div>
      ))}

      {orderOpen && (
        <div className="row" style={{ marginTop: 8 }}>
          <select value={templateKey} onChange={(e) => setTemplateKey(e.target.value)}>
            <option value="">Välj protokollmall…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.key}>
                {t.title} (v{t.version})
              </option>
            ))}
          </select>
          <button className="btn" disabled={!templateKey} onClick={start}>
            Starta protokoll
          </button>
        </div>
      )}
    </div>
  );
}
