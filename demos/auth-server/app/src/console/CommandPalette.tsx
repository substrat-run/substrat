import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { SubIcon, SubIcons } from '@substrat-run/ui';
import { bankidSettings, identityProviders, listOAuthClients, listUsers } from '../api';
import { navigate } from './router';
import {
  APPLICATIONS_PATH,
  CONNECTIONS_PATH,
  ROUTES,
  USERS_PATH,
  applicationPath,
  connectionPath,
  userPath,
} from './routes';

type Kind = 'Sections' | 'Applications' | 'Users' | 'Connections';
const KINDS: Kind[] = ['Sections', 'Applications', 'Users', 'Connections'];

/** Per entity group. Sections are a fixed, short table and are never cut. */
const MAX_PER_GROUP = 6;

interface Item {
  key: string;
  kind: Kind;
  label: string;
  detail?: string;
  path: string;
  /** Lower-cased text the query is matched against. */
  haystack: string;
}

/** Each kind's glyph is its section's own nav icon, so a result looks like where it leads. */
const iconOf = (path: string) => ROUTES.find((r) => r.path === path)?.icon ?? SubIcons.search;
const ICONS: Record<Exclude<Kind, 'Sections'>, string> = {
  Applications: iconOf(APPLICATIONS_PATH),
  Users: iconOf(USERS_PATH),
  Connections: iconOf(CONNECTIONS_PATH),
};

const item = (kind: Kind, key: string, label: string, path: string, detail?: string): Item => ({
  key: `${kind}:${key}`,
  kind,
  label,
  detail,
  path,
  haystack: `${label} ${detail ?? ''}`.toLowerCase(),
});

/**
 * The ⌘K jump-to (spec/console-redesign.md §1): sections, applications, users and connections,
 * filtered as you type. Mounted only for an administrator — every list it reads is behind the
 * admin gate.
 *
 * The lists are read once per opening, not per keystroke, and filtered here. This issuer's
 * directories are small (the user list the Users screen shows is the same capped read), and a
 * fresh read each time the palette opens means a client created a minute ago is findable
 * without a reload. The spec's `q=` reads per kind arrive with `/api/v2` (Phase 3).
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Mounting on open is the reset: a fresh query, a fresh read, and the focus hand-back below
  // tied to the dialog's own lifetime rather than to a flag.
  return open ? <PaletteDialog onClose={onClose} /> : null;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [loaded, setLoaded] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<Kind[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const ids = useId();
  const listId = `${ids}-list`;
  const optionId = (i: number) => `${ids}-opt-${i}`;

  useEffect(() => {
    // Whatever had focus before ⌘K gets it back on close, however the palette was closed.
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => before?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    // Settled one by one: a connection list that fails to load is no reason to hide the users.
    void Promise.allSettled([listOAuthClients(), listUsers(), identityProviders(), bankidSettings()]).then(
      ([clients, users, providers, bankid]) => {
        if (!live) return;
        const items: Item[] = [];
        const bad: Kind[] = [];
        if (clients.status === 'fulfilled') {
          for (const c of clients.value) items.push(item('Applications', c.client_id, c.client_name || c.client_id, applicationPath(c.client_id), c.client_id));
        } else bad.push('Applications');
        if (users.status === 'fulfilled') {
          for (const u of users.value) items.push(item('Users', u.id, u.name || u.email, userPath(u.id), u.email));
        } else bad.push('Users');
        if (providers.status === 'fulfilled') {
          // `password` is the database connection's reserved id (spec §2), always present.
          items.push(item('Connections', 'password', 'Password database', connectionPath('password'), 'database'));
          const { catalogue, providers: configured } = providers.value;
          for (const p of configured) {
            const label = p.label ?? catalogue.find((c) => c.id === p.id)?.label ?? p.id;
            items.push(item('Connections', p.id, label, connectionPath(p.id), p.id));
          }
        } else bad.push('Connections');
        if (bankid.status === 'fulfilled' && bankid.value) {
          items.push(item('Connections', 'bankid', 'BankID', connectionPath('bankid'), 'bankid'));
        } else if (bankid.status === 'rejected' && !bad.includes('Connections')) bad.push('Connections');
        setLoaded(items);
        setFailed(bad);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const sections = useMemo(
    // The palette is an administrator's, so every route an administrator can reach — the nav
    // hides "Your account" from them only because the account menu already carries it.
    () => ROUTES.map((r) => item('Sections', r.path, r.label, r.path, r.group)),
    [],
  );

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = [...sections, ...loaded];
    return KINDS.map((kind) => {
      const matches = all.filter((i) => i.kind === kind && (!needle || i.haystack.includes(needle)));
      return { kind, items: kind === 'Sections' ? matches : matches.slice(0, MAX_PER_GROUP), more: kind !== 'Sections' && matches.length > MAX_PER_GROUP };
    }).filter((g) => g.items.length > 0);
  }, [q, sections, loaded]);
  const flat = groups.flatMap((g) => g.items);

  useEffect(() => setSel(0), [q]);
  // A late load can shrink the list under the cursor; keep the cursor on a real row.
  const current = Math.min(sel, Math.max(flat.length - 1, 0));

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(current))}`)?.scrollIntoView?.({ block: 'nearest' });
  });

  const go = (target: Item | undefined) => {
    if (!target) return;
    navigate(target.path);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Stopped here so the shell's own Escape (it closes the narrow-screen drawer) does not
      // also fire behind the palette.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(current + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(current - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(flat[current]);
    } else if (e.key === 'Tab') {
      // The input is the dialog's only control; a modal does not let Tab walk out of it.
      e.preventDefault();
    }
  };

  let index = -1;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'color-mix(in srgb, var(--gray-950) 55%, transparent)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '64px 16px 0',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          width: 640,
          maxWidth: '100%',
          maxHeight: 'calc(100vh - 128px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: 'var(--surface-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 12,
          boxShadow: 'var(--shadow-popover)',
          color: 'var(--text-primary)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 52, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
          <SubIcon d={SubIcons.search} size={16} style={{ color: 'var(--text-tertiary)' }} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat.length ? optionId(current) : undefined}
            aria-label="Jump to"
            placeholder="Jump to a section, an application, a user or a connection"
            spellCheck={false}
            autoComplete="off"
            // The console styles every input as a form field; this one is the dialog's header.
            style={{ flex: 1, minWidth: 0, height: 'auto', padding: 0, border: 0, outline: 'none', boxShadow: 'none', background: 'transparent', fontSize: 15, color: 'var(--text-primary)' }}
          />
          <Key>esc</Key>
        </div>

        <div ref={list} id={listId} role="listbox" aria-label="Results" style={{ overflowY: 'auto', padding: '6px 0', minHeight: 120 }}>
          {groups.map((g) => (
            <div key={g.kind} role="group" aria-labelledby={`${ids}-${g.kind}`}>
              <div id={`${ids}-${g.kind}`} style={groupTitle}>{g.kind}</div>
              {g.items.map((it) => {
                const i = ++index;
                const on = i === current;
                return (
                  <div
                    key={it.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={on}
                    onMouseMove={() => i !== current && setSel(i)}
                    // Keep focus in the input, where the arrows and Enter are read.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => go(it)}
                    style={{ ...option, background: on ? 'var(--surface-active)' : 'transparent' }}
                  >
                    <SubIcon d={it.kind === 'Sections' ? iconOf(it.path) : ICONS[it.kind]} size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                    <span style={{ ...clip, fontWeight: 500 }}>{it.label}</span>
                    {it.detail && it.detail !== it.label && (
                      <span style={{ ...clip, ...(it.kind === 'Sections' ? {} : { fontFamily: 'var(--font-mono)' }), fontSize: 11.5, color: 'var(--text-tertiary)' }}>{it.detail}</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {on && <Key>↵</Key>}
                  </div>
                );
              })}
              {g.more && <div style={{ ...quiet, padding: '2px 20px 6px' }}>More results — keep typing to narrow them.</div>}
            </div>
          ))}
          {loading && <div style={quiet}>Loading applications, users and connections…</div>}
          {!loading && flat.length === 0 && <div style={quiet}>Nothing matches “{q.trim()}”.</div>}
          {failed.length > 0 && <div style={{ ...quiet, color: 'var(--status-danger-fg)' }}>Could not load: {failed.join(', ').toLowerCase()}.</div>}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, height: 40, padding: '0 16px', borderTop: '1px solid var(--border-subtle)', background: 'var(--surface-inset)', fontSize: 11.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
          <span><Key>↑↓</Key> move</span>
          <span><Key>↵</Key> open</span>
          <span><Key>esc</Key> close</span>
        </div>
      </div>
    </div>
  );
}

const clip: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 };
const quiet: CSSProperties = { padding: '10px 20px', fontSize: 13, color: 'var(--text-tertiary)' };
const groupTitle: CSSProperties = {
  padding: '8px 20px 4px',
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};
const option: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  height: 38,
  padding: '0 12px',
  margin: '0 8px',
  borderRadius: 6,
  fontSize: 13,
  cursor: 'pointer',
};

function Key({ children }: { children: string }) {
  return (
    <kbd
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        padding: '1px 6px',
        borderRadius: 4,
        border: '1px solid var(--border-default)',
        background: 'var(--surface-card)',
        color: 'var(--text-tertiary)',
      }}
    >
      {children}
    </kbd>
  );
}
