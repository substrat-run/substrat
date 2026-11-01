import { useState } from 'react';
import type { CSSProperties } from 'react';

export interface SwitchProps {
  label?: string;
  /** The accessible name when no visible `label` is drawn — a switch in a table row, say. */
  'aria-label'?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  style?: CSSProperties;
}

export function Switch({ label, 'aria-label': ariaLabel, checked, defaultChecked, onChange, disabled, style }: SwitchProps) {
  const [internal, setInternal] = useState(!!defaultChecked);
  const isOn = checked !== undefined ? checked : internal;

  const toggle = () => {
    if (disabled) return;
    if (checked === undefined) setInternal(!isOn);
    onChange?.(!isOn);
  };

  // A button with `role="switch"`, not a `<label onClick>`: a label is neither focusable nor
  // announced, so a keyboard user could not reach the control and a screen reader heard only
  // its text. A button gets Tab, Space/Enter and `disabled` from the platform.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      aria-label={label ? undefined : ariaLabel}
      disabled={disabled}
      onClick={toggle}
      style={{
        appearance: 'none',
        background: 'none',
        border: 0,
        padding: 0,
        margin: 0,
        font: 'inherit',
        color: 'inherit',
        textAlign: 'left',
        display: 'inline-flex',
        gap: 10,
        alignItems: 'center',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      <span
        style={{
          width: 32,
          height: 18,
          borderRadius: 'var(--radius-full)',
          padding: 2,
          boxSizing: 'border-box',
          background: isOn ? 'var(--brand-600)' : 'var(--gray-300)',
          transition: 'background var(--duration-base) var(--ease-out)',
          display: 'flex',
        }}
      >
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: 'var(--radius-full)',
            background: '#fff',
            boxShadow: 'var(--shadow-sm)',
            transform: isOn ? 'translateX(14px)' : 'translateX(0)',
            transition: 'transform var(--duration-base) var(--ease-out)',
          }}
        />
      </span>
      {label && (
        <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>{label}</span>
      )}
    </button>
  );
}
