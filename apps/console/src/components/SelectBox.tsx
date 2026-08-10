/**
 * A compact table checkbox with a third, indeterminate state (some-but-not-all
 * of a select-all group checked). The shared `Checkbox` has no indeterminate
 * visual and always lays out a label line, so tables use this one.
 */
export function SelectBox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
}) {
  const on = checked || !!indeterminate;
  return (
    <span
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      onClick={(e) => {
        // The checkbox lives inside a row whose click may open a detail panel —
        // toggling selection must not also open it.
        e.stopPropagation();
        onChange(!checked);
      }}
      style={{
        width: 16,
        height: 16,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 'var(--radius-xs)',
        border: '1px solid ' + (on ? 'var(--brand-600)' : 'var(--border-strong)'),
        background: on ? 'var(--brand-600)' : 'var(--surface-card)',
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      {indeterminate ? (
        <svg viewBox="0 0 12 12" width="10" height="10">
          <path d="M2.5 6h7" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      ) : checked ? (
        <svg viewBox="0 0 12 12" width="10" height="10">
          <path d="M2.5 6.5l2.5 2.5 4.5-5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}
