import { useEffect, useRef, useState } from 'react';
import type { InstallStep } from '../lib/api';

/** Human labels for the install sequence's step keys (#424). Unknown keys render as-is. */
const STEP_LABELS: Record<string, string> = {
  directory: 'Register in the directory',
  provision: 'Provision the instance',
  activate: 'Activate',
  hostname: 'Assign a hostname',
  identity: 'Wire identity',
};

/**
 * The live install progress (#424): the durable step record rendered as a compact
 * checklist — done ✓, running (pulsing), failed ✗ with the downstream error VERBATIM
 * and the attempt count. Polls its loader while the install is `provisioning` (steps
 * appear as they run); fetches once for a settled row. Rows only exist for steps that
 * ran, so the list is honest about how far the install actually got.
 */
export function InstallSteps({
  status,
  load,
}: {
  status: 'provisioning' | 'active' | 'failed';
  load: () => Promise<InstallStep[]>;
}) {
  const [steps, setSteps] = useState<InstallStep[]>([]);
  // The loader arrives as an inline closure from the card, so it is referentially fresh
  // on every parent render — keep the latest in a ref and key the effect on `status`
  // alone, or each list poll/keystroke would reset the interval and refetch.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    const fetchSteps = () => {
      void loadRef
        .current()
        .then((s) => {
          if (live) setSteps(s);
        })
        .catch(() => {});
    };
    fetchSteps();
    if (status !== 'provisioning') return () => { live = false; };
    const t = setInterval(fetchSteps, 2500);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [status]);

  if (steps.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
      {steps.map((s) => (
        <div key={s.step} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <StepGlyph status={s.status} />
            <span
              style={{
                color: s.status === 'failed' ? 'var(--status-danger-fg)' : 'var(--text-secondary)',
                fontWeight: s.status === 'running' ? 500 : 400,
              }}
            >
              {STEP_LABELS[s.step] ?? s.step}
            </span>
            {s.attempts > 1 && (
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>attempt {s.attempts}</span>
            )}
          </div>
          {s.status === 'failed' && s.last_error && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                lineHeight: 1.45,
                color: 'var(--status-danger-fg)',
                background: 'var(--status-danger-bg)',
                borderRadius: 6,
                padding: '6px 8px',
                marginLeft: 22,
                overflowWrap: 'anywhere',
                maxHeight: 80,
                overflow: 'hidden',
              }}
            >
              {s.last_error}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** ✓ done / ✗ failed / pulsing dot while running — sized to sit in a 12.5px text row. */
function StepGlyph({ status }: { status: InstallStep['status'] }) {
  if (status === 'done') {
    return <span style={{ color: 'var(--status-success-fg)', fontSize: 12, width: 14, textAlign: 'center' }}>✓</span>;
  }
  if (status === 'failed') {
    return <span style={{ color: 'var(--status-danger-fg)', fontSize: 12, width: 14, textAlign: 'center' }}>✕</span>;
  }
  return (
    <span style={{ width: 14, display: 'inline-flex', justifyContent: 'center' }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: 'var(--status-info-fg)',
          animation: 'sub-pulse 1.4s ease-in-out infinite',
        }}
      />
    </span>
  );
}
