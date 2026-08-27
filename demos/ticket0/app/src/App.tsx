/**
 * The shell: who is signed in, what they may see, and which screen is showing.
 *
 * **How the app learns whether you are an admin is worth reading.** It does not decode
 * a role out of a token or keep a list of admin emails — it asks the API for the money
 * and sees what comes back. A 403 means agent, and the cost card is then not rendered
 * at all rather than rendered disabled. The permission system is the source of truth
 * for the UI exactly as it is for the data, which is the only arrangement where the
 * two cannot disagree.
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, auth, me, type Identity, type Session } from './api.js';
import { Avatar } from './ui.js';
import { Notifications } from './Notifications.js';
import { Inbox } from './views/Inbox.js';
import { ConversationView } from './views/Conversation.js';
import { Settings } from './views/Settings.js';
import { Portal } from './views/Portal.js';

export type View =
  | { name: 'inbox' }
  | { name: 'conversation'; id: string }
  | { name: 'settings'; tab: 'desk' | 'identity' | 'knowledge' | 'usage' }
  | { name: 'portal' }
  | { name: 'portal-conversation'; id: string };

/** The active screen lives in the hash, so a refresh does not drop you at the root. */
function parseHash(): View {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 'c' && b) return { name: 'conversation', id: b };
  if (a === 'settings')
    return { name: 'settings', tab: (b as 'desk') || 'desk' };
  if (a === 'portal') return b ? { name: 'portal-conversation', id: b } : { name: 'portal' };
  return { name: 'inbox' };
}

export function viewToHash(v: View): string {
  switch (v.name) {
    case 'conversation':
      return `#/c/${v.id}`;
    case 'settings':
      return `#/settings/${v.tab}`;
    case 'portal':
      return '#/portal';
    case 'portal-conversation':
      return `#/portal/${v.id}`;
    default:
      return '#/';
  }
}

export function useHashRoute(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(parseHash);
  useEffect(() => {
    const onHash = () => setView(parseHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  return [view, (v) => location.assign(viewToHash(v))];
}

/** What this signed-in person may reach. Learned by asking, never by guessing. */
export interface Capabilities {
  /** Holds `usage:read` — the money, and the desk-admin's alone. */
  money: boolean;
  /** Holds `desk:configure` — settings and the knowledge base. */
  configure: boolean;
  /** Holds `conversation:read` — the desk-wide inbox, as opposed to only their own. */
  inbox: boolean;
}

async function probe(): Promise<Capabilities> {
  const holds = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) return false;
      // Anything else is a real failure and must not read as "you may not".
      throw err;
    }
  };
  const [money, configure, inbox] = await Promise.all([
    holds(() => api.usageSummary({})),
    holds(() => api.getDesk()),
    holds(() => api.listConversations({})),
  ]);
  return { money, configure, inbox };
}

export function App() {
  const [session, setSession] = useState<Identity | undefined>(undefined);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [view, navigate] = useHashRoute();

  useEffect(() => {
    void me()
      // A rejected `me()` — the API down, the proxy misrouted — used to leave the
      // splash screen up forever, which reads as a hang rather than as signed-out.
      .catch(() => null)
      .then(async (s) => {
        setSession(s);
        if (s && s !== 'needs-setup') {
          setCaps(await probe().catch(() => ({ money: false, configure: false, inbox: false })));
        }
      });
  }, []);

  const go = useCallback((v: View) => navigate(v), [navigate]);

  if (session === undefined) return <Splash>Loading…</Splash>;
  if (session === null || session === 'needs-setup')
    return (
      <Splash>
        <div className="t-title" style={{ marginBottom: 10 }}>
          ticket0
        </div>
        <div className="t-meta" style={{ marginBottom: 18 }}>
          {session === 'needs-setup'
            ? 'This desk has no owner yet. Sign in to claim it.'
            : 'Sign in to work the desk.'}
        </div>
        <button className="btn btn-primary" onClick={() => auth.login(location.hash || '/')}>
          Sign in
        </button>
      </Splash>
    );

  const portal = view.name === 'portal' || view.name === 'portal-conversation';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <TopBar session={session} caps={caps} view={view} go={go} />
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '28px 24px 64px' }}>
        {portal ? (
          <Portal view={view} go={go} session={session} />
        ) : view.name === 'settings' ? (
          <Settings tab={view.tab} caps={caps} go={go} />
        ) : view.name === 'conversation' ? (
          <ConversationView id={view.id} caps={caps} session={session} go={go} />
        ) : (
          <Inbox caps={caps} session={session} go={go} />
        )}
      </div>
    </div>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', textAlign: 'center' }}>
      <div>{children}</div>
    </div>
  );
}

function TopBar({
  session,
  caps,
  view,
  go,
}: {
  session: Session;
  caps: Capabilities | null;
  view: View;
  go: (v: View) => void;
}) {
  const tab = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      onClick={onClick}
      className="btn btn-ghost"
      style={{
        background: active ? 'var(--nav-active)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--secondary-2)',
        fontWeight: active ? 600 : 500,
      }}
    >
      {label}
    </button>
  );

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 24px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--hairline)',
      }}
    >
      <Brand />
      <nav style={{ display: 'flex', gap: 4 }}>
        {caps?.inbox ? tab('Inbox', view.name === 'inbox' || view.name === 'conversation', () => go({ name: 'inbox' })) : null}
        {caps?.configure
          ? tab('Settings', view.name === 'settings', () => go({ name: 'settings', tab: 'desk' }))
          : null}
        {tab('My conversations', view.name.startsWith('portal'), () => go({ name: 'portal' }))}
      </nav>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Notifications go={go} />
        <span className="t-meta">{session.display}</span>
        <Avatar name={session.display} size={26} />
        <button className="btn btn-ghost" onClick={() => auth.switchUser()}>
          Switch
        </button>
      </div>
    </header>
  );
}

/** The brand mark is a styled div — the handoff is explicit that no asset is needed. */
export function Brand({ size = 26, label = 'ticket0' }: { size?: number; label?: string | null }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 7,
          background: '#17181a',
          color: '#fff',
          display: 'grid',
          placeItems: 'center',
          font: `600 ${Math.round(size * 0.5)}px 'Geist', sans-serif`,
        }}
      >
        S
      </div>
      {label ? <div className="t-strong">{label}</div> : null}
    </div>
  );
}
