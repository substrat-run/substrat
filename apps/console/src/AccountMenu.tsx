import { useEffect, useRef } from 'react';
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

/**
 * The account menu in the sidebar's footer. The console already holds who is signed in
 * (`/api/auth/session` names only an email, not a principal), so the element is handed
 * that rather than reading it. `onSignOut` absent is dev mode: there is no session to end.
 */
export function AccountMenu({
  email,
  onSignOut,
  onToggleDark,
}: {
  email?: string | undefined;
  onSignOut?: (() => void) | undefined;
  onToggleDark: () => void;
}) {
  const menu = useRef<SubUserMenu>(null);

  useEffect(() => {
    const el = menu.current!;
    const who = email ?? 'dev actor';
    const session: Session = { principal: who, display: who };
    if (email) session.email = email;
    el.session = session;
  }, [email]);

  useEffect(() => {
    const el = menu.current!;
    const select = (e: Event) => {
      if ((e as CustomEvent<{ item: HTMLElement }>).detail.item.getAttribute('value') === 'theme') onToggleDark();
    };
    const signOut = (e: Event) => {
      e.preventDefault();
      onSignOut?.();
    };
    el.addEventListener('wa-select', select);
    el.addEventListener('sub-sign-out', signOut);
    return () => {
      el.removeEventListener('wa-select', select);
      el.removeEventListener('sub-sign-out', signOut);
    };
  }, [onSignOut, onToggleDark]);

  return (
    <div style={{ padding: '6px 8px', borderTop: '1px solid var(--border-subtle)' }}>
      <sub-user-menu ref={menu} style={{ display: 'block' }} show="name" size="1.5rem" placement="top-start" session-url="" hide-switch-user>
        <wa-dropdown-item value="theme">Toggle theme</wa-dropdown-item>
        {!onSignOut && <span slot="sign-out" />}
      </sub-user-menu>
    </div>
  );
}
