import { useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';

export interface InputProps {
  label?: string;
  /** Helper text under the field. */
  hint?: string;
  /** Error message; also paints the border red. */
  error?: string;
  /** Fixed prefix segment, e.g. a slug namespace. Rendered in mono on an inset background. */
  prefix?: string;
  /** Render the value in Geist Mono (IDs, slugs). */
  mono?: boolean;
  size?: 'sm' | 'md' | 'lg';
  placeholder?: string;
  value?: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  style?: CSSProperties;
  /** The underlying input type — `password` masks secret values as they are typed. */
  type?: 'text' | 'password';
}

const heights: Record<NonNullable<InputProps['size']>, string> = {
  sm: 'var(--control-h-sm)',
  md: 'var(--control-h-md)',
  lg: 'var(--control-h-lg)',
};

export function Input({
  label,
  hint,
  error,
  prefix,
  mono,
  size = 'md',
  placeholder,
  value,
  onChange,
  style,
  type = 'text',
}: InputProps) {
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
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          height: h,
          borderRadius: 'var(--radius-sm)',
          border:
            '1px solid ' +
            (error ? 'var(--red-500)' : focus ? 'var(--brand-400)' : 'var(--border-default)'),
          background: 'var(--surface-card)',
          boxShadow: focus ? 'var(--focus-ring)' : 'var(--shadow-xs)',
          transition:
            'box-shadow var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out)',
          overflow: 'hidden',
        }}
      >
        {prefix && (
          <span
            style={{
              padding: '0 10px',
              alignSelf: 'stretch',
              display: 'flex',
              alignItems: 'center',
              background: 'var(--surface-inset)',
              borderRight: '1px solid var(--border-default)',
              color: 'var(--text-tertiary)',
              fontSize: 'var(--text-sm)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {prefix}
          </span>
        )}
        <input
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            flex: 1,
            minWidth: 0,
            height: '100%',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            padding: '0 10px',
            fontSize: 'var(--text-base)',
            color: 'var(--text-primary)',
            fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
          }}
        />
      </span>
      {error ? (
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--status-danger-fg)' }}>{error}</span>
      ) : hint ? (
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>{hint}</span>
      ) : null}
    </label>
  );
}
