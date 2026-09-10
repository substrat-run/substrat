import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Spinner } from './Spinner';

export interface ButtonProps {
  /** Visual style. Default 'primary'. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** Control height. Default 'md' (32px). */
  size?: 'sm' | 'md' | 'lg';
  /** Optional leading icon node (16px). */
  icon?: ReactNode;
  /**
   * The click's work is still in flight: a spinner replaces the icon, the button stops
   * accepting clicks, and `aria-busy` says so. The label stays put — a button that
   * relabels itself mid-flight moves the row it sits in. Implies `disabled`, so a caller
   * never has to pass both.
   */
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  style?: CSSProperties;
}

const heights: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'var(--control-h-sm)',
  md: 'var(--control-h-md)',
  lg: 'var(--control-h-lg)',
};
const pads: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: '0 10px',
  md: '0 12px',
  lg: '0 16px',
};
const fonts: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'var(--text-sm)',
  md: 'var(--text-base)',
  lg: 'var(--text-base)',
};

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  loading,
  disabled: disabledProp,
  onClick,
  children,
  style,
}: ButtonProps) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  // In flight IS disabled: the second click on an admit or a promote is the one that
  // fires the request twice.
  const disabled = disabledProp || loading;

  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: heights[size],
    padding: pads[size],
    borderRadius: 'var(--radius-sm)',
    fontFamily: 'var(--font-sans)',
    fontSize: fonts[size],
    fontWeight: 'var(--weight-medium)',
    lineHeight: 1,
    cursor: loading ? 'progress' : disabled ? 'not-allowed' : 'pointer',
    border: '1px solid transparent',
    transition:
      'background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out)',
    // A loading button is not a refusal, so it does not fade like one — it stays
    // readable, because it is the thing the operator is waiting on.
    opacity: loading ? 0.85 : disabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };

  const variants: Record<NonNullable<ButtonProps['variant']>, CSSProperties> = {
    primary: {
      background: active
        ? 'var(--brand-800)'
        : hover
          ? 'var(--action-primary-bg-hover)'
          : 'var(--action-primary-bg)',
      color: 'var(--action-primary-text)',
      boxShadow: 'var(--shadow-xs)',
    },
    secondary: {
      background: active
        ? 'var(--surface-active)'
        : hover
          ? 'var(--surface-hover)'
          : 'var(--surface-card)',
      color: 'var(--text-primary)',
      borderColor: 'var(--border-default)',
      boxShadow: 'var(--shadow-xs)',
    },
    ghost: {
      background: active ? 'var(--surface-active)' : hover ? 'var(--surface-hover)' : 'transparent',
      color: 'var(--text-secondary)',
    },
    danger: {
      background: active ? 'var(--red-700)' : hover ? 'var(--red-600)' : 'var(--red-500)',
      color: '#fff',
      boxShadow: 'var(--shadow-xs)',
    },
  };

  return (
    <button
      disabled={disabled}
      aria-busy={loading || undefined}
      onClick={onClick}
      style={{ ...base, ...variants[variant], ...style }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setActive(false);
      }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon}
      {children}
    </button>
  );
}
