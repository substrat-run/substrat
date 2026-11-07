import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Session, SubUserMenu } from '@substrat-run/elements';
import type {} from '@substrat-run/elements/jsx';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'sub-user-menu': React.DetailedHTMLProps<React.HTMLAttributes<SubUserMenu>, SubUserMenu> & {
        show?: 'avatar' | 'name' | 'email';
        size?: string;
        placement?: 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start';
        'session-url'?: string;
        'logout-url'?: string;
        'hide-switch-user'?: boolean;
      };
    }
  }
}

export interface AccountMenuItem {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface AccountMenuProps {
  /** The app already holds who is signed in, so the element is handed that rather than reading it. */
  name: string;
  email?: string | undefined;
  /** Replaces the avatar and name the element draws; it sits inside the menu's own button. */
  trigger?: ReactNode;
  items: AccountMenuItem[];
  onSelect: (value: string) => void;
  /** Absent is dev mode: there is no session to end. */
  onSignOut?: (() => void) | undefined;
}

/** `<sub-user-menu>` for a sidebar's footer: it opens upward. */
export function AccountMenu({ name, email, trigger, items, onSelect, onSignOut }: AccountMenuProps) {
  const menu = useRef<SubUserMenu>(null);
  const latest = useRef({ onSelect, onSignOut });
  latest.current = { onSelect, onSignOut };

  useEffect(() => {
    const session: Session = { principal: email ?? name, display: name };
    if (email) session.email = email;
    menu.current!.session = session;
  }, [name, email]);

  useEffect(() => {
    const el = menu.current!;
    const select = (e: Event) => {
      const value = (e as CustomEvent<{ item: HTMLElement }>).detail.item.getAttribute('value');
      if (value) latest.current.onSelect(value);
    };
    const signOut = (e: Event) => {
      e.preventDefault();
      latest.current.onSignOut?.();
    };
    el.addEventListener('wa-select', select);
    el.addEventListener('sub-sign-out', signOut);
    return () => {
      el.removeEventListener('wa-select', select);
      el.removeEventListener('sub-sign-out', signOut);
    };
  }, []);

  return (
    <sub-user-menu ref={menu} style={{ display: 'block' }} show="name" size="1.5rem" placement="top-start" session-url="" hide-switch-user>
      {trigger && <span slot="trigger">{trigger}</span>}
      {items.map((it) => (
        <wa-dropdown-item key={it.value} value={it.value}>
          {it.icon && <span slot="icon">{it.icon}</span>}
          {it.label}
        </wa-dropdown-item>
      ))}
      {!onSignOut && <span slot="sign-out" />}
    </sub-user-menu>
  );
}
