/**
 * One number with a label and a line of context — the console's stat tile.
 *
 * Lifted out of `Scopes` when the meters view (#38) needed the same tile: the fleet
 * header and a meter reading must render a count identically, or the same number looks
 * like two different facts depending on which page you are on.
 *
 * `meta` is required on purpose. A bare number invites the reader to supply their own
 * denominator; "12" and "12 of 30 in the directory" are different claims.
 */
export function Stat({ label, value, meta }: { label: string; value: string | number; meta: string }) {
  return (
    <div
      style={{
        background: 'var(--surface-card)',
        border: '1px solid var(--border-default)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-xs)',
        padding: 14,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)', margin: '4px 0 2px' }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{meta}</div>
    </div>
  );
}
