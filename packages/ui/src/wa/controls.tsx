/**
 * The form and action primitives, drawn by Web Awesome. Same props as the ones in
 * `@substrat-run/ui`'s root export, so a view does not change with the renderer.
 *
 * React 18 sets a custom element's props as attributes, so three things recur here. A
 * boolean is `x || undefined`, since `false` would be written as a present attribute. A
 * class is `class`. A live value (`value`, `checked`) is a property, so it goes through a
 * ref; the attribute beside it only names the first value, and is what a first paint shows.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type {} from '@substrat-run/elements/jsx';

type Size = 'sm' | 'md' | 'lg';
/** Web Awesome types `style` as a plain record, which a `CSSProperties` is not. */
export const css = (s: CSSProperties | undefined) => s as Record<string, string | number> | undefined;

const WA_SIZE = { sm: 's', md: 'm', lg: 'l' } as const;

/**
 * `wa-button` sets `color` on the button in its shadow root, so a `color` on the host stops
 * there and a red Remove goes grey with no error. It rides a custom property instead, which
 * `wa.css` hands to that button.
 */
function buttonLook(style: CSSProperties | undefined, cls?: string) {
  if (!style?.color) return { class: cls, style: css(style) };
  const { color, ...rest } = style;
  return { class: cls ? `${cls} ui-tinted` : 'ui-tinted', style: css({ ...rest, '--ui-button-color': color } as CSSProperties) };
}

export interface ButtonProps {
  /** `link` reads as text in a sentence: no box, no padding. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
  size?: Size;
  icon?: ReactNode;
  /** In flight: a spinner, and no second click. Implies `disabled`. */
  loading?: boolean;
  disabled?: boolean;
  /** `wa-button` is `button` unless told otherwise, so a form's own button says `submit`. */
  type?: 'button' | 'submit';
  title?: string;
  /** Where it sits in a parent element, such as a dropdown's `trigger`. */
  slot?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  children?: ReactNode;
  style?: CSSProperties;
}

const BUTTON = {
  primary: { variant: 'brand', appearance: 'accent' },
  secondary: { variant: 'neutral', appearance: 'outlined' },
  ghost: { variant: 'neutral', appearance: 'plain' },
  danger: { variant: 'danger', appearance: 'accent' },
  link: { variant: 'brand', appearance: 'plain' },
} as const;

export function Button({ variant = 'primary', size = 'md', icon, loading, disabled, type, title, slot, onClick, children, style }: ButtonProps) {
  const off = disabled || loading;
  return (
    <wa-button
      {...BUTTON[variant]}
      {...buttonLook(style, variant === 'link' ? 'ui-link' : undefined)}
      size={WA_SIZE[size]}
      type={type}
      title={title}
      slot={slot}
      loading={loading || undefined}
      disabled={off || undefined}
      onClick={(off ? undefined : onClick) as never}
    >
      {icon && <span slot="start">{icon}</span>}
      {children}
    </wa-button>
  );
}

export interface IconButtonProps {
  /** Its accessible name. `title` is what reaches the button in the shadow root. */
  label: string;
  variant?: 'ghost' | 'outline';
  size?: Size;
  disabled?: boolean;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
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
      {...buttonLook(style)}
      size={WA_SIZE[size]}
      disabled={disabled || undefined}
      onClick={(disabled ? undefined : onClick) as never}
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
  /** A leading icon. */
  icon?: ReactNode;
  mono?: boolean;
  /** No box of its own, for a field that sits inside one. */
  bare?: boolean;
  size?: Size;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  spellCheck?: boolean;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  onEnter?: (value: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  style?: CSSProperties;
  type?: 'text' | 'password' | 'search';
}

/** What a view may do to an `Input` or a `Textarea` it holds a ref to. */
export interface FieldHandle {
  focus: () => void;
}

export const Input = forwardRef<FieldHandle, InputProps>(function Input(
  {
    label,
    ariaLabel,
    maxLength,
    pattern,
    hint,
    error,
    prefix,
    icon,
    mono,
    bare,
    size = 'md',
    placeholder,
    value,
    disabled,
    readOnly,
    autoFocus,
    spellCheck,
    onChange,
    onEnter,
    onKeyDown,
    style,
    type = 'text',
  },
  handle,
) {
  const ref = useLiveValue<HTMLElement & { value: string }>(value);
  useImperativeHandle(handle, () => ({ focus: () => ref.current?.focus() }), [ref]);
  const classes = [!label && 'wa-visually-hidden-label', error && 'ui-invalid', mono && 'ui-mono', bare && 'ui-bare'].filter(Boolean);
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
      disabled={disabled || undefined}
      readonly={readOnly || undefined}
      autofocus={autoFocus || undefined}
      spellcheck={spellCheck}
      onInput={(e) => onChange?.(e as unknown as ChangeEvent<HTMLInputElement>)}
      onKeyDown={
        onEnter || onKeyDown
          ? (e) => {
              onKeyDown?.(e as unknown as KeyboardEvent<HTMLElement>);
              if (e.key === 'Enter') onEnter?.((e.currentTarget as unknown as { value: string }).value);
            }
          : undefined
      }
      style={css(style)}
    >
      {icon && <span slot="start">{icon}</span>}
      {prefix && (
        <span slot="start" className="ui-input-prefix">
          {prefix}
        </span>
      )}
    </wa-input>
  );
});

export interface TextareaProps {
  label?: string;
  /** The accessible name of a box with no visible label. */
  ariaLabel?: string;
  hint?: string;
  mono?: boolean;
  rows?: number;
  placeholder?: string;
  value?: string;
  spellCheck?: boolean;
  onChange?: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  style?: CSSProperties;
}

export function Textarea({ label, ariaLabel, hint, mono, rows, placeholder, value, spellCheck, onChange, onKeyDown, style }: TextareaProps) {
  const ref = useLiveValue<HTMLElement & { value: string }>(value);
  const classes = [!label && 'wa-visually-hidden-label', mono && 'ui-mono'].filter(Boolean);
  return (
    <wa-textarea
      ref={ref as never}
      class={classes.join(' ') || undefined}
      label={label ?? ariaLabel}
      hint={hint}
      rows={rows}
      value={value}
      placeholder={placeholder}
      spellcheck={spellCheck}
      onInput={(e) => onChange?.(e as unknown as ChangeEvent<HTMLTextAreaElement>)}
      onKeyDown={onKeyDown && ((e) => onKeyDown(e as unknown as KeyboardEvent<HTMLElement>))}
      style={css(style)}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** A heading drawn above the first option of each run with the same group. */
  group?: string;
}

export interface SelectProps {
  label?: string;
  ariaLabel?: string;
  options: Array<string | SelectOption>;
  size?: Size;
  value?: string;
  disabled?: boolean;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  style?: CSSProperties;
}

/** `wa-select` reads an empty value as "nothing chosen", so an option that means "any" goes by this. */
const BLANK = '__blank__';
const toOption = (v: string) => (v === '' ? BLANK : v);

export function Select({ label, ariaLabel, options, size = 'md', value, disabled, onChange, style }: SelectProps) {
  const opts: SelectOption[] = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const shown = value === undefined ? undefined : toOption(value);
  const ref = useLiveValue<HTMLElement & { value: string }>(shown, opts.map((o) => o.value).join('\u0000'));
  return (
    <wa-select
      ref={ref as never}
      class={label ? undefined : 'wa-visually-hidden-label'}
      label={label ?? ariaLabel}
      size={WA_SIZE[size]}
      value={shown}
      disabled={disabled || undefined}
      onInput={(e) => {
        const picked = (e.target as unknown as { value: string }).value;
        // `wa-select` says so on a re-pick of the current option too, which a `<select>` does not.
        if (picked !== shown) onChange?.({ target: { value: picked === BLANK ? '' : picked } } as ChangeEvent<HTMLSelectElement>);
      }}
      style={css(style)}
    >
      {opts.flatMap((o, i) => [
        ...(o.group && o.group !== opts[i - 1]?.group ? [<small key={`group:${o.group}`}>{o.group}</small>] : []),
        // `wa-select` draws nothing for a disabled value, so the current one is never drawn disabled.
        <wa-option key={o.value} value={toOption(o.value)} disabled={(o.disabled && o.value !== value) || undefined}>
          {o.label}
        </wa-option>,
      ])}
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

export interface SwitchProps {
  /** Drawn beside the switch, and what names it. */
  label: ReactNode;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  style?: CSSProperties;
}

export function Switch({ label, checked, onChange, disabled, style }: SwitchProps) {
  const { ref, onInput } = useChecked(checked, undefined, onChange);
  return (
    <wa-switch ref={ref as never} checked={checked || undefined} disabled={disabled || undefined} onInput={onInput} style={css(style)}>
      {label}
    </wa-switch>
  );
}

export interface SegmentedProps<T extends string> {
  /** The group's accessible name. */
  label: string;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  value: T;
  onChange: (value: T) => void;
  style?: CSSProperties;
}

/**
 * One choice of a few, side by side: `wa-radio`s drawn as buttons, so the choice is the
 * group's own state. A `wa-button` could not say it: `aria-pressed` on the host stops short
 * of the button in the shadow root.
 */
export function Segmented<T extends string>({ label, options, value, onChange, style }: SegmentedProps<T>) {
  const ref = useLiveValue<HTMLElement & { value: string }>(value);
  return (
    <wa-radio-group
      ref={ref as never}
      class="wa-visually-hidden-label ui-segmented"
      label={label}
      orientation="horizontal"
      size="s"
      value={value}
      onInput={(e) => {
        const picked = (e.currentTarget as unknown as { value: T }).value;
        if (picked !== value) onChange(picked);
      }}
      style={css(style)}
    >
      {options.map((o) => (
        <wa-radio key={o.value} appearance="button" value={o.value} title={o.title}>
          {o.label}
        </wa-radio>
      ))}
    </wa-radio-group>
  );
}

export interface DropdownItem {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Trailing, such as the tick beside the current choice. */
  details?: ReactNode;
  /** Set this item off from the ones above it with a rule. */
  separated?: boolean;
}

export interface DropdownProps {
  /** A `Button` with `slot="trigger"`. */
  trigger: ReactNode;
  items: DropdownItem[];
  onSelect: (value: string) => void;
  placement?: 'bottom-start' | 'bottom-end';
  /** A small heading above the items. */
  heading?: string;
  style?: CSSProperties;
}

/** `wa-dropdown`, which owns opening, closing, the keyboard and where it sits on the page. */
export function Dropdown({ trigger, items, onSelect, placement = 'bottom-start', heading, style }: DropdownProps) {
  const menu = useRef<HTMLElement>(null);
  const latest = useRef(onSelect);
  latest.current = onSelect;
  useEffect(() => {
    const el = menu.current!;
    const select = (e: Event) => latest.current((e as CustomEvent<{ item: { value: string } }>).detail.item.value);
    el.addEventListener('wa-select', select);
    return () => el.removeEventListener('wa-select', select);
  }, []);
  return (
    <wa-dropdown ref={menu as never} placement={placement} style={css(style)}>
      {trigger}
      {heading && <h3 className="ui-dropdown-heading">{heading}</h3>}
      {items.flatMap((it) => [
        ...(it.separated ? [<wa-divider key={`rule:${it.value}`} />] : []),
        <wa-dropdown-item key={it.value} value={it.value}>
          {it.icon && <span slot="icon">{it.icon}</span>}
          {it.label}
          {it.details && <span slot="details">{it.details}</span>}
        </wa-dropdown-item>,
      ])}
    </wa-dropdown>
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
    <wa-tab-group ref={group as never} class="ui-tabs" active={current} style={css(style)}>
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
