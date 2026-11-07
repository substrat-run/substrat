/** The display primitives, drawn by Web Awesome. See `controls.tsx`. */
import type { CSSProperties, ReactNode } from 'react';
import type {} from '@substrat-run/elements/jsx';
import type { BreadcrumbItem } from '../components';
import { css } from './controls';

export interface BadgeProps {
  status?: 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'brand';
  /** Show the leading status dot. Default true. */
  dot?: boolean;
  /** The dot breathes, for a state still in flight. */
  pulse?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}

/** Web Awesome has no `info`, so it is a neutral badge the stylesheet gives the info colours. */
export function Badge({ status = 'neutral', dot = true, pulse, children, style }: BadgeProps) {
  return (
    <wa-badge
      class={status === 'info' ? 'ui-badge-info' : undefined}
      variant={status === 'info' ? 'neutral' : status}
      appearance="filled"
      pill
      style={css(style)}
    >
      {dot && <span slot="start" className={pulse ? 'ui-badge-dot ui-badge-pulse' : 'ui-badge-dot'} />}
      {children}
    </wa-badge>
  );
}

export interface TagProps {
  mono?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}

export function Tag({ mono, children, style }: TagProps) {
  return (
    <wa-tag class={mono ? 'ui-mono' : undefined} size="s" variant="neutral" appearance="filled-outlined" style={css(style)}>
      {children}
    </wa-tag>
  );
}

export interface CardProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  /** Body padding in px. Default 16. Use 0 for tables. */
  padding?: number | string;
  children?: ReactNode;
  style?: CSSProperties;
}

/**
 * The header is one slot rather than `wa-card`'s separate actions slot, because this row
 * wraps: on a narrow screen a card's primary buttons drop to their own line instead of
 * being clipped. The padding sits on the body's own box since `--spacing` also sets the
 * header's and the footer's.
 */
export function Card({ title, description, actions, footer, padding = 16, children, style }: CardProps) {
  const header = !!(title || actions);
  return (
    <wa-card class="ui-card" appearance="outlined" with-header={header || undefined} with-footer={footer ? true : undefined} style={css(style)}>
      {header && (
        <div slot="header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ minWidth: 0, flex: '1 1 auto' }}>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', letterSpacing: 'var(--tracking-tight)' }}>
              {title}
            </div>
            {description && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', marginTop: 2 }}>{description}</div>}
          </div>
          {actions && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minWidth: 0, maxWidth: '100%' }}>{actions}</div>}
        </div>
      )}
      <div style={{ padding }}>{children}</div>
      {footer && (
        <div slot="footer" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
          {footer}
        </div>
      )}
    </wa-card>
  );
}

export function Breadcrumbs({ items, style }: { items: BreadcrumbItem[]; style?: CSSProperties }) {
  return (
    <wa-breadcrumb style={css(style)}>
      {items.map((it, i) => (
        <wa-breadcrumb-item key={i} class={it.mono ? 'ui-mono' : undefined} href={it.href} onClick={it.onClick}>
          {it.label}
        </wa-breadcrumb-item>
      ))}
    </wa-breadcrumb>
  );
}

export interface ToastProps {
  status?: 'success' | 'danger' | 'info';
  title: string;
  detail?: string | undefined;
  style?: CSSProperties;
}

const TOAST = { success: 'success', danger: 'danger', info: 'brand' } as const;

export function Toast({ status = 'info', title, detail, style }: ToastProps) {
  return (
    <wa-callout variant={TOAST[status]} size="s" style={css({ width: 360, boxShadow: 'var(--shadow-popover)', ...style })}>
      <strong>{title}</strong>
      {detail && <div style={{ fontSize: 'var(--text-sm)', marginTop: 2 }}>{detail}</div>}
    </wa-callout>
  );
}
