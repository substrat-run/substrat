import { useEffect, useRef, useState } from 'react';
import { api, type EmittedLifecycle } from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { MOCK_TIMELINE_TARGETS } from '../lib/mock-timeline';
import { EntityTimeline } from './EventHistory';

/**
 * One record's timeline over the page (#1921), opened by its address (`rec=<type>:<id>`) —
 * from the ⌘K overlay's pasted id, or any link that names a record. The same card the Data
 * tab opens, with the entity's declared lifecycle drawn above it when the running model
 * has one (#1916); the lifecycle is read here because a link carries only the record.
 */
export function RecordPanel({
  scopeId,
  entityType,
  entityId,
  onClose,
}: {
  scopeId: string;
  entityType: string;
  entityId: string;
  onClose: () => void;
}) {
  const [lifecycle, setLifecycle] = useState<EmittedLifecycle | null | undefined>(undefined);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    let live = true;
    setLifecycle(undefined);
    if (DEV_MOCK) {
      setLifecycle(Object.values(MOCK_TIMELINE_TARGETS).find((t) => t.entityType === entityType)?.lifecycle ?? null);
      return;
    }
    api
      .appModel(scopeId)
      .then((m) => live && setLifecycle(m.running.model?.lifecycles?.[entityType] ?? null))
      // No model to read is no lifecycle to draw; the history below still opens.
      .catch(() => live && setLifecycle(null));
    return () => {
      live = false;
    };
  }, [scopeId, entityType]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  return (
    <>
      <div aria-hidden onClick={onClose} style={{ position: 'fixed', inset: '56px 0 0 0', background: 'color-mix(in srgb, var(--gray-950) 35%, transparent)', zIndex: 38 }} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${entityType} ${entityId}`}
        style={{ position: 'fixed', top: 56, right: 0, bottom: 0, width: 'min(960px, 100vw)', overflowY: 'auto', padding: 16, background: 'var(--surface-page, var(--surface-inset))', borderLeft: '1px solid var(--border-default)', boxShadow: 'var(--shadow-popover)', zIndex: 39 }}
      >
        {/* Wait for the model: the card reads ahead a different number of pages with a lifecycle. */}
        {lifecycle !== undefined && (
          <EntityTimeline
            scopeId={scopeId}
            entityType={entityType}
            entityId={entityId}
            {...(lifecycle ? { stateField: lifecycle.field, lifecycle } : {})}
            onClose={onClose}
          />
        )}
      </div>
    </>
  );
}
