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
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, auth, claimOwner, invites, me, type Identity, type Session } from './api.js';
import { Avatar } from './ui.js';
import { Notifications } from './Notifications.js';
import { Inbox } from './views/Inbox.js';
import { ConversationView } from './views/Conversation.js';
import { Settings, type SettingsTab } from './views/Settings.js';
import { Portal } from './views/Portal.js';
import { Reports } from './views/Reports.js';
import { Signups } from './views/Signups.js';

export type View =
  | { name: 'inbox' }
  | { name: 'conversation'; id: string }
  | { name: 'settings'; tab: SettingsTab }
  | { name: 'reports' }
  | { name: 'signups' }
  | { name: 'portal' }
  | { name: 'portal-conversation'; id: string };

/** The active screen lives in the hash, so a refresh does not drop you at the root. */
function parseHash(): View {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 'c' && b) return { name: 'conversation', id: b };
  if (a === 'settings') return { name: 'settings', tab: (b as SettingsTab) || 'desk' };
  if (a === 'reports') return { name: 'reports' };
  if (a === 'signups') return { name: 'signups' };
  if (a === 'portal') return b ? { name: 'portal-conversation', id: b } : { name: 'portal' };
  return { name: 'inbox' };
}

export function viewToHash(v: View): string {
  switch (v.name) {
    case 'conversation':
      return `#/c/${v.id}`;
    case 'settings':
      return `#/settings/${v.tab}`;
    case 'reports':
      return '#/reports';
    case 'signups':
      return '#/signups';
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
  /** Holds `signup:read` — the waiting list and the newsletter list. */
  signups: boolean;
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
  const [money, configure, inbox, signups] = await Promise.all([
    holds(() => api.usageSummary({})),
    holds(() => api.getDesk()),
    holds(() => api.listConversations({})),
    // `signupCounts()` rather than `listSignups({})`, and it is the same key: the probe
    // runs on every sign-in for every account, and asking the list question would pull a
    // page of real email addresses and free-text notes into the browser purely to throw
    // them away. The aggregate answers "may I" with no PII in the response.
    holds(() => api.signupCounts()),
  ]);
  return { money, configure, inbox, signups };
}

const PARAMS = new URLSearchParams(location.search);
/** A claim token in the URL (`?claim=<token>`) — the installer arrived by a dashboard-minted claim link (#925). */
const CLAIM_TOKEN = PARAMS.get('claim');
/** An invite token (`?invite=<token>`) — a colleague arrived by a link an admin made (#1149). */
const INVITE_TOKEN = PARAMS.get('invite');

/**
 * Drop a spent token from the URL and re-enter the app normally.
 *
 * Both screens below return BEFORE the desk renders, so an error state with no action
 * is a dead end — and a link is reopened all the time: the person kept it, or the
 * browser restored the tab. A signed-in colleague who lands there would otherwise have
 * to edit the address bar by hand.
 */
function forget(param: string) {
  const url = new URL(location.href);
  url.searchParams.delete(param);
  history.replaceState({}, '', url.pathname + url.search + url.hash);
  location.reload();
}

/**
 * Claim the owner seat. The token rides the sign-in round-trip: try the claim at once (a
 * session may already exist), and on 401 send them to the issuer, returning here with the
 * token still in the URL. On success the token leaves the URL and `/api/me` resolves the owner.
 */
function ClaimOwner({ token }: { token: string }) {
  const [state, setState] = useState<'trying' | 'needs-login' | 'error'>('trying');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    claimOwner(token).then(
      () => {
        history.replaceState({}, '', location.pathname + location.hash);
        location.reload();
      },
      (e: Error & { status?: number }) => {
        if (!alive) return;
        if (e.status === 401) setState('needs-login');
        else {
          setErr(e.message);
          setState('error');
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [token]);
  return (
    <Splash>
      <div className="t-title" style={{ marginBottom: 10 }}>
        ticket0
      </div>
      <div className="t-meta" style={{ marginBottom: 18 }}>
        {state === 'trying'
          ? 'Checking your claim link…'
          : state === 'error'
            ? (err ?? 'This claim link no longer works.')
            : 'Sign in to claim this desk as its owner.'}
      </div>
      {state === 'needs-login' && (
        <button className="btn btn-primary" onClick={() => auth.login(`/?claim=${encodeURIComponent(token)}`)}>
          Sign in
        </button>
      )}
      {state === 'error' && (
        <button className="btn" onClick={() => forget('claim')}>
          Continue to the desk
        </button>
      )}
    </Splash>
  );
}

/**
 * Accept an invite. The same shape as `ClaimOwner` above and for the same reasons: the
 * account lives at the issuer, so there is nothing to create here — sign in, then bind
 * this login to the principal the invite already granted a role to. Try the claim at
 * once (the redirect back may have left a session), and on 401 send them to the issuer
 * with the token still riding the URL.
 */
function AcceptInvite({ token }: { token: string }) {
  const [state, setState] = useState<'trying' | 'needs-login' | 'error'>('trying');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    invites.accept(token).then(
      () => {
        // The token is spent; leaving it in the URL would make a reload look like a
        // dead link rather than like the desk they now work at.
        history.replaceState({}, '', location.pathname + location.hash);
        location.reload();
      },
      (e: unknown) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) setState('needs-login');
        else {
          setErr(e instanceof Error ? e.message : String(e));
          setState('error');
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [token]);
  return (
    <Splash>
      <div className="t-title" style={{ marginBottom: 10 }}>
        ticket0
      </div>
      <div className="t-meta" style={{ marginBottom: 18 }}>
        {state === 'trying'
          ? 'Checking your invite…'
          : state === 'error'
            ? (err ?? 'This invite is no longer valid.')
            : 'Sign in to join this desk.'}
      </div>
      {state === 'needs-login' && (
        <button
          className="btn btn-primary"
          onClick={() => auth.login(`/?invite=${encodeURIComponent(token)}`)}
        >
          Sign in
        </button>
      )}
      {state === 'error' && (
        <button className="btn" onClick={() => forget('invite')}>
          Continue to the desk
        </button>
      )}
    </Splash>
  );
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
        if (s && 'principal' in s) {
          setCaps(
            await probe().catch(() => ({
              money: false,
              configure: false,
              inbox: false,
              signups: false,
            })),
          );
        }
      });
  }, []);

  const go = useCallback((v: View) => navigate(v), [navigate]);

  if (session === undefined) return <Splash>Loading…</Splash>;
  // Arrived by a claim link (#925): bind this login to the owner seat, whether or not a
  // session (or even another principal) already exists. Takes priority over everything.
  if (CLAIM_TOKEN) return <ClaimOwner token={CLAIM_TOKEN} />;
  // Arrived by an invite link (#1149), and for the same reason it comes before the
  // signed-out splash: the token is the authority, not the session.
  if (INVITE_TOKEN) return <AcceptInvite token={INVITE_TOKEN} />;
  if (session === null || 'status' in session)
    return (
      <Splash>
        <div className="t-title" style={{ marginBottom: 10 }}>
          ticket0
        </div>
        <div className="t-meta" style={{ marginBottom: 18 }}>
          {session === null
            ? 'Sign in to work the desk.'
            : session.firstSignInOpen
              ? 'This desk has no owner yet. Sign in to claim it.'
              : 'This desk has no owner yet, and the window for claiming it by signing in has closed. Ask whoever installed it for a claim link from the dashboard.'}
        </div>
        {(session === null || session.firstSignInOpen) && (
          <button className="btn btn-primary" onClick={() => auth.login(location.hash || '/')}>
            Sign in
          </button>
        )}
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
          <Settings tab={view.tab} caps={caps} session={session} go={go} />
        ) : view.name === 'reports' ? (
          <Reports caps={caps} />
        ) : view.name === 'signups' ? (
          <Signups caps={caps} />
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
        {/* The report is the money with a denominator, so it appears for the same
            capability the money does — learned by asking, exactly as above. */}
        {caps?.money ? tab('Reports', view.name === 'reports', () => go({ name: 'reports' })) : null}
        {/* The lists, behind their own key — learned by asking, exactly as above. An
            agent never sees this tab, and typing the hash would get them a 403. */}
        {caps?.signups
          ? tab('Signups', view.name === 'signups', () => go({ name: 'signups' }))
          : null}
        {/* Not gated on `configure` any more: the Settings shell shows an agent the one
            tab they have business on — their own profile, which is what puts them in
            the desk's directory and therefore in the assignee picker (#1149). */}
        {tab('Settings', view.name === 'settings', () =>
          go({ name: 'settings', tab: caps?.configure ? 'desk' : 'you' }),
        )}
        {tab('My conversations', view.name.startsWith('portal'), () => go({ name: 'portal' }))}
      </nav>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Notifications go={go} />
        <AccountMenu session={session} />
      </div>
    </header>
  );
}

/**
 * The account menu: the avatar is the control, and who you are plus what you can do
 * about it live behind it. The bar used to spell all three out — name, avatar, a
 * "Switch" button — which reads as three unrelated things rather than one identity.
 */
function AccountMenu({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // The items, in the order they are rendered — arrow keys walk this, so it is the
  // menu's focus order rather than the DOM's guess at one.
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((toTrigger: boolean) => {
    setOpen(false);
    // Closing with the keyboard must put focus somewhere deliberate; the element it
    // was on is about to be unmounted, and focus would otherwise fall to <body>.
    if (toTrigger) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close(true);
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = items.current.filter((el): el is HTMLButtonElement => el !== null);
      if (list.length === 0) return;
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // Wraps in both directions, and an unfocused menu enters at the end the arrow
      // points from — Up from nowhere lands on the last item, not the first.
      const next = at === -1 ? (step === 1 ? 0 : list.length - 1) : (at + step + list.length) % list.length;
      list[next]?.focus();
    };
    addEventListener('mousedown', away);
    addEventListener('keydown', key);
    return () => {
      removeEventListener('mousedown', away);
      removeEventListener('keydown', key);
    };
  }, [open, close]);

  // Opening moves focus into the menu, which is what makes the arrow keys above
  // reachable at all for someone who opened it with the keyboard.
  useEffect(() => {
    if (open) items.current[0]?.focus();
    else items.current = [];
  }, [open]);

  const item = (index: number, label: string, onClick: () => void, danger = false) => (
    <button
      role="menuitem"
      ref={(el) => {
        items.current[index] = el;
      }}
      onClick={onClick}
      className="btn btn-ghost"
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        borderRadius: 0,
        padding: '8px 12px',
        color: danger ? 'var(--danger)' : 'var(--text)',
      }}
    >
      {label}
    </button>
  );

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button
        ref={trigger}
        className="btn btn-ghost"
        onClick={() => setOpen((v) => !v)}
        title={session.display}
        // The button's only content is the avatar, and the avatar's only content is
        // one initial — so without this a screen reader announces "Y, button".
        aria-label={`Account menu for ${session.display}`}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{ padding: 3, borderRadius: 999 }}
      >
        <Avatar name={session.display} size={26} />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={`Account menu for ${session.display}`}
          style={{
            position: 'absolute',
            right: 0,
            top: 'calc(100% + 8px)',
            minWidth: 200,
            background: 'var(--surface)',
            border: '1px solid var(--frame)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-popover)',
            overflow: 'hidden',
            zIndex: 20,
          }}
        >
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--hairline)' }}>
            <div className="t-strong">{session.display}</div>
            <div className="micro">Signed in</div>
          </div>
          <div style={{ padding: '4px 0' }}>
            {item(0, 'Switch user', () => auth.switchUser())}
            {item(1, 'Sign out', () => auth.logout(), true)}
          </div>
        </div>
      ) : null}
    </div>
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
