/**
 * The console's form and action primitives, drawn by Web Awesome. Same props as the
 * `@substrat-run/ui` ones they replace, so a view does not change with the renderer.
 *
 * React 18 sets a custom element's props as attributes, so three things recur here. A
 * boolean is `x || undefined`, since `false` would be written as a present attribute. A
 * class is `class`. A live value (`value`, `checked`) is a property, so it goes through a
 * ref; the attribute beside it only names the first value, and is what a first paint shows.
 */
import { forwardRef, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, ReactNode } from 'react';
import type {} from '@substrat-run/elements/jsx';

type Size = 'sm' | 'md' | 'lg';
/** Web Awesome types `style` as a plain record, which a `CSSProperties` is not. */
export const css = (s: CSSProperties | undefined) => s as Record<string, string | number> | undefined;

const WA_SIZE = { sm: 's', md: 'm', lg: 'l' } as const;

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: Size;
  icon?: ReactNode;
  /** In flight: a spinner, and no second click. Implies `disabled`. */
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  style?: CSSProperties;
}

const BUTTON = {
  primary: { variant: 'brand', appearance: 'accent' },
  secondary: { variant: 'neutral', appearance: 'outlined' },
  ghost: { variant: 'neutral', appearance: 'plain' },
  danger: { variant: 'danger', appearance: 'accent' },
} as const;

export function Button({ variant = 'primary', size = 'md', icon, loading, disabled, onClick, children, style }: ButtonProps) {
  const off = disabled || loading;
  return (
    <wa-button
      {...BUTTON[variant]}
      size={WA_SIZE[size]}
      loading={loading || undefined}
      disabled={off || undefined}
      onClick={off ? undefined : onClick}
      style={css(style)}
    >
      {icon && <span slot="start">{icon}</span>}
      {children}
    </wa-button>
  );
}

export interface IconButtonProps {
  label: string;
  variant?: 'ghost' | 'outline';
  size?: Size;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
  style?: CSSProperties;
}

export const IconButton = forwardRef<HTMLElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', disabled, onClick, children, style },
  ref,
) {
  return (
    <wa-button
      ref={ref as never}
      title={label}
      aria-label={label}
      variant="neutral"
      appearance={variant === 'ghost' ? 'plain' : 'outlined'}
      size={WA_SIZE[size]}
      disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      style={css(style)}
    >
      {children}
    </wa-button>
  );
});

/** Keep a control's `value` property on what the view holds. */
function useLiveValue<E extends HTMLElement & { value: unknown }>(value: string | undefined, also?: unknown) {
  const ref = useRef<E>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && value !== undefined && el.value !== value) el.value = value;
  }, [value, also]);
  return ref;
}

export interface InputProps {
  label?: string;
  /** The accessible name of a filter box with no visible label. */
  ariaLabel?: string;
  maxLength?: number;
  pattern?: string;
  hint?: string;
  /** Takes the hint's place, in the danger colour. */
  error?: string;
  /** A fixed leading segment, such as a slug namespace. */
  prefix?: string;
  mono?: boolean;
  size?: Size;
  placeholder?: string;
  value?: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  onEnter?: (value: string) => void;
  style?: CSSProperties;
  type?: 'text' | 'password';
}

export function Input({
  label,
  ariaLabel,
  maxLength,
  pattern,
  hint,
  error,
  prefix,
  mono,
  size = 'md',
  placeholder,
  value,
  onChange,
  onEnter,
  style,
  type = 'text',
}: InputProps) {
  const ref = useLiveValue<HTMLElement & { value: string }>(value);
  const classes = [!label && 'wa-visually-hidden-label', error && 'console-invalid', mono && 'console-mono'].filter(Boolean);
  return (
    <wa-input
      ref={ref as never}
      class={classes.join(' ') || undefined}
      label={label ?? ariaLabel}
      hint={error ?? hint}
      size={WA_SIZE[size]}
      type={type}
      value={value}
      placeholder={placeholder}
      maxlength={maxLength}
      pattern={pattern}
      onInput={(e) => onChange?.(e as unknown as ChangeEvent<HTMLInputElement>)}
      onKeyDown={onEnter && ((e) => e.key === 'Enter' && onEnter((e.currentTarget as unknown as { value: string }).value))}
      style={css(style)}
    >
      {prefix && (
        <span slot="start" className="console-input-prefix">
          {prefix}
        </span>
      )}
    </wa-input>
  );
}

export interface SelectProps {
  label?: string;
  ariaLabel?: string;
  options: Array<string | { value: string; label: string; disabled?: boolean }>;
  size?: Size;
  value?: string;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  style?: CSSProperties;
}

/** `wa-select` reads an empty value as "nothing chosen", so an option that means "any" goes by this. */
const BLANK = '__blank__';
const toOption = (v: string) => (v === '' ? BLANK : v);

export function Select({ label, ariaLabel, options, size = 'md', value, onChange, style }: SelectProps) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const shown = value === undefined ? undefined : toOption(value);
  const ref = useLiveValue<HTMLElement & { value: string }>(shown, opts.map((o) => o.value).join('\u0000'));
  return (
    <wa-select
      ref={ref as never}
      class={label ? undefined : 'wa-visually-hidden-label'}
      label={label ?? ariaLabel}
      size={WA_SIZE[size]}
      value={shown}
      onInput={(e) => {
        const picked = (e.target as unknown as { value: string }).value;
        onChange?.({ target: { value: picked === BLANK ? '' : picked } } as ChangeEvent<HTMLSelectElement>);
      }}
      style={css(style)}
    >
      {opts.map((o) => (
        <wa-option key={o.value} value={toOption(o.value)} disabled={('disabled' in o && o.disabled) || undefined}>
          {o.label}
        </wa-option>
      ))}
    </wa-select>
  );
}

type Checkable = HTMLElement & { checked: boolean; indeterminate: boolean };

/**
 * A checkbox the view owns: a click hands the new state to the view and puts the control
 * back, so a view that declines the change is still what the box shows.
 */
function useChecked(checked: boolean | undefined, indeterminate: boolean | undefined, onChange?: (on: boolean) => void) {
  const ref = useRef<Checkable>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (checked !== undefined) el.checked = checked;
    el.indeterminate = !!indeterminate;
  });
  const onInput = (e: { currentTarget: unknown }) => {
    const el = e.currentTarget as Checkable;
    const next = el.checked;
    if (checked !== undefined) el.checked = checked;
    onChange?.(next);
  };
  return { ref, onInput };
}

export interface CheckboxProps {
  label: ReactNode;
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  /** Some but not all of what this box stands for. */
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  style?: CSSProperties;
}

export function Checkbox({ label, description, checked, defaultChecked, indeterminate, onChange, disabled, style }: CheckboxProps) {
  const { ref, onInput } = useChecked(checked, indeterminate, onChange);
  return (
    <wa-checkbox
      ref={ref as never}
      checked={(checked ?? defaultChecked) || undefined}
      disabled={disabled || undefined}
      hint={description}
      onInput={onInput}
      style={css(style)}
    >
      {label}
    </wa-checkbox>
  );
}

/** A label-less table checkbox with a third, some-but-not-all state. */
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
  const { ref, onInput } = useChecked(checked, indeterminate, onChange);
  return (
    <wa-checkbox ref={ref as never} size="s" checked={checked || undefined} indeterminate={indeterminate || undefined} onInput={onInput}>
      <span className="wa-visually-hidden">{ariaLabel}</span>
    </wa-checkbox>
  );
}

/** A row's keyboard path into its detail: a button that reads as the cell's text, with its focus ring. */
export const UNSET_BUTTON: CSSProperties = { background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer', textAlign: 'left' };

export interface TabsProps {
  tabs: Array<string | { value: string; label: string; count?: number }>;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  style?: CSSProperties;
}

export function Tabs({ tabs, value, defaultValue, onChange, style }: TabsProps) {
  const list = tabs.map((t) => (typeof t === 'string' ? { value: t, label: t } : t));
  const [internal, setInternal] = useState(defaultValue ?? list[0]?.value);
  const current = value ?? internal;
  const group = useRef<HTMLElement>(null);
  const latest = useRef({ current, value, onChange });
  latest.current = { current, value, onChange };

  useEffect(() => {
    const el = group.current!;
    const show = (e: Event) => {
      const { name } = (e as CustomEvent<{ name: string }>).detail;
      if (name === latest.current.current) return;
      if (latest.current.value === undefined) setInternal(name);
      latest.current.onChange?.(name);
    };
    el.addEventListener('wa-tab-show', show);
    return () => el.removeEventListener('wa-tab-show', show);
  }, []);

  return (
    <wa-tab-group ref={group as never} class="console-tabs" active={current} style={css(style)}>
      {list.map((t) => (
        <wa-tab key={t.value} slot="nav" panel={t.value}>
          {t.label}
          {'count' in t && t.count !== undefined && (
            <wa-badge variant="neutral" appearance="filled" pill style={{ marginInlineStart: 6 }}>
              {t.count}
            </wa-badge>
          )}
        </wa-tab>
      ))}
    </wa-tab-group>
  );
}
