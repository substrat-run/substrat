import { forwardRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

export interface IconButtonProps {
  /** Accessible label (also the tooltip title). Required. */
  label: string;
  variant?: 'ghost' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  onClick?: () => void;
  /** The icon node, 16-18px. */
  children?: ReactNode;
  style?: CSSProperties;
}

const dims: Record<NonNullable<IconButtonProps['size']>, string> = {
  sm: 'var(--control-h-sm)',
  md: 'var(--control-h-md)',
  lg: 'var(--control-h-lg)',
};

/**
 * The ref reaches the `<button>`, so a caller that opens something modal from it can put
 * focus back where the person left it when that thing closes.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size = 'md', variant = 'ghost', label, disabled, onClick, children, style },
  ref,
) {
  const [hover, setHover] = useState(false);

  const variants: Record<NonNullable<IconButtonProps['variant']>, CSSProperties> = {
    ghost: {
      background: hover ? 'var(--surface-hover)' : 'transparent',
      border: '1px solid transparent',
    },
    outline: {
      background: hover ? 'var(--surface-hover)' : 'var(--surface-card)',
      border: '1px solid var(--border-default)',
      boxShadow: 'var(--shadow-xs)',
    },
  };

  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: dims[size],
        height: dims[size],
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background var(--duration-fast) var(--ease-out)',
        opacity: disabled ? 0.5 : 1,
        ...variants[variant],
        ...style,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
    </button>
  );
});
