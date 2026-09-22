import { useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';

export interface SelectProps {
  label?: string;
  /** The control's accessible name when no visible `label` is shown (a filter row). */
  ariaLabel?: string;
  /** Options: strings or {value, label}. `disabled` renders but cannot be picked. */
  options: Array<string | { value: string; label: string; disabled?: boolean }>;
  size?: 'sm' | 'md' | 'lg';
  value?: string;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  style?: CSSProperties;
}

const heights: Record<NonNullable<SelectProps['size']>, string> = {
  sm: 'var(--control-h-sm)',
  md: 'var(--control-h-md)',
  lg: 'var(--control-h-lg)',
};

export function Select({ label, ariaLabel, options, size = 'md', value, onChange, style }: SelectProps) {
  const [focus, setFocus] = useState(false);
  const h = heights[size];

  return (
    <label
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      {label && (
        <span
          style={{
            fontSize: 'var(--text-sm)',
            fontWeight: 'var(--weight-medium)',
            color: 'var(--text-primary)',
          }}
        >
          {label}
        </span>
      )}
      <span style={{ position: 'relative', display: 'flex' }}>
        <select
          aria-label={label ? undefined : ariaLabel}
          value={value}
          onChange={onChange}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            appearance: 'none',
            WebkitAppearance: 'none',
            width: '100%',
            height: h,
            padding: '0 28px 0 10px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid ' + (focus ? 'var(--brand-400)' : 'var(--border-default)'),
            background: 'var(--surface-card)',
            boxShadow: focus ? 'var(--focus-ring)' : 'var(--shadow-xs)',
            fontSize: 'var(--text-base)',
            fontFamily: 'var(--font-sans)',
            color: 'var(--text-primary)',
            outline: 'none',
            cursor: 'pointer',
          }}
        >
          {options.map((o) => {
            const opt = typeof o === 'string' ? { value: o, label: o } : o;
            return (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            );
          })}
        </select>
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          style={{
            position: 'absolute',
            right: 9,
            top: '50%',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            color: 'var(--text-tertiary)',
          }}
        >
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </label>
  );
}
