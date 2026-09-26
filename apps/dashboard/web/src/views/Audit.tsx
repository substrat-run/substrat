import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Button, KeyValue, Select } from '@substrat-run/ui';
import { api, ApiError, type AppRow, type AuditEntry, type ListPage, type PageOpts } from '../lib/api';
import { DEV_MOCK } from '../lib/mock';
import { mockAuditLogAll } from '../lib/mock-audit';
import { shortDate, shortId } from '../lib/format';
import { isPlainClick, navigate, teamPath } from '../lib/router';
import { actionWords, actorOf, clockTime, entryDiff, entrySentence, filterEntries, groupByDay, type ActorKind, type KindFilter } from '../lib/audit-activity';
import { Page } from '../components/layout';

/** How many pages a deep link walks looking for its entry before saying it is not there. */
export const DEEP_LINK_PAGES = 5;

type Read = (opts?: PageOpts & { scopeId?: string }) => Promise<ListPage<AuditEntry>>;

/**
 * The Audit page (#479, moved to team level by #1447, the Activity log since #1825):
 * Substrat's control-plane admin log — every privileged action against this team's
 * apps, append-only, newest first, as sentences grouped by day. A pure READ of the audit
 * spine the platform already writes (control-plane.md §4.4); nothing here mutates.
 *
 * It is a TEAM page with an app filter rather than a tab on each app, because the log is
 * written at the tenant grain and some entries — role changes, entitlements — name no
 * scope at all — a per-app tab could never show those. The app page links in here already
 * narrowed, which is the entrance an app owner actually wanted. `?entry=` opens one entry
 * in place, which is how the Overview's Recent activity rows land here.
 *
 * The design's Outcome filter and refused rows are not here: the dashboard reads the
 * permission-denial log only as a per-operation summary, never as rows. Its Person lookup
 * and Data requests tabs, and the Why / How of an entry, wait on #1751.
 *
 * The control plane serves this, so embedded mode has nothing to show and the page says so.
 */
export function AuditLog({
  apps,
  appsComplete,
  scopeId,
  entryId = null,
  onScope,
}: {
  apps: AppRow[];
  /** False while the app index is still being walked — the filter and the app tags are then partial. */
  appsComplete: boolean;
  scopeId: string | null;
  /** The entry a deep link opens (`?entry=`). */
  entryId?: string | null;
  onScope: (s: string | null) => void;
}) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [text, setText] = useState('');
  // Set when a deep link's entry was not in what the walk read: how many pages it read,
  // and whether the log went on past them.
  const [missing, setMissing] = useState<{ pages: number; more: boolean } | null>(null);
  const scrollTo = useRef<string | null>(null);
  // One generation per filter. Every request — the first page and each older one —
  // remembers the generation it was started under and is ignored if the filter has moved
  // on by the time it lands, so a "Load older" still in flight when the app filter
  // changes (or Back is pressed) cannot append the old scope's rows under the new one
  // and hand it the old cursor.
  const generation = useRef(0);
  const read: Read = DEV_MOCK ? mockAuditLogAll : api.auditLogAll;

  useEffect(() => {
    const gen = ++generation.current;
    // Cleared before the refetch: a list of one app's entries under a heading that now
    // names another is worse than a blank moment, and the filter is the whole page here.
    setEntries(null);
    setCursor(null);
    setLoadingOlder(false);
    setMissing(null);
    const scope = scopeId ? { scopeId } : {};
    void (async () => {
      let first: ListPage<AuditEntry>;
      try {
        first = await read(scopeId ? { scopeId } : undefined);
      } catch (e) {
        if (gen !== generation.current) return;
        if (e instanceof ApiError && e.status === 501) setUnavailable(true);
        setEntries([]);
        return;
      }
      let all = first.entries;
      let next = first.nextCursor;
      let pages = 1;
      // A deep link walks older pages until its entry turns up — bounded, because an id
      // that is not in this log (or not under this app) would otherwise read all of it.
      // A page that fails ends the walk; what was read is still shown.
      while (entryId && !all.some((e) => e.id === entryId) && next && pages < DEEP_LINK_PAGES) {
        try {
          const p = await read({ ...scope, cursor: next });
          if (gen !== generation.current) return;
          const seen = all;
          all = [...seen, ...p.entries.filter((e) => !seen.some((x) => x.id === e.id))];
          next = p.nextCursor;
          pages += 1;
        } catch {
          break;
        }
      }
      if (gen !== generation.current) return;
      setEntries(all);
      setCursor(next);
      if (entryId) {
        if (all.some((e) => e.id === entryId)) {
          setOpen(entryId);
          scrollTo.current = entryId;
        } else setMissing({ pages, more: next !== null });
      }
    })();
    return () => {
      // Unmount, or a new filter about to start: either way this generation is over.
      if (gen === generation.current) generation.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `read` is fixed for the page's life (mock or live)
  }, [scopeId, entryId]);

  useEffect(() => {
    if (!scrollTo.current || !entries) return;
    const id = scrollTo.current;
    scrollTo.current = null;
    const row = [...document.querySelectorAll<HTMLElement>('[data-entry-id]')].find((el) => el.dataset.entryId === id);
    row?.scrollIntoView?.({ block: 'center' });
  }, [entries]);

  const loadOlder = async () => {
    if (loadingOlder || !cursor) return;
    const gen = generation.current;
    setLoadingOlder(true);
    try {
      const p = await read({ ...(scopeId ? { scopeId } : {}), cursor });
      if (gen !== generation.current) return;
      setEntries((prev) => [...(prev ?? []), ...p.entries.filter((e) => !prev?.some((x) => x.id === e.id))]);
      setCursor(p.nextCursor);
    } finally {
      if (gen === generation.current) setLoadingOlder(false);
    }
  };

  // A scope not in the index is shown by id: while the index is still being walked that
  // is "not yet", and once it is complete it is an app this team no longer has (a reaped
  // scope still has audit rows).
  const appName = (id: string): string => apps.find((a) => a.app_scope_id === id)?.name ?? shortId(id);

  const shown = entries ? filterEntries(entries, { kind, text, appName }) : [];
  const days = groupByDay(shown);

  return (
    <Page>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: 22, lineHeight: '29px', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text-primary)' }}>Audit</h1>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }}>
            Every control-plane action on this team&rsquo;s apps, by people and by the platform&rsquo;s own jobs. Append-only, newest first.
          </div>
        </div>
        <Select
          aria-label="App"
          options={[
            { value: '', label: appsComplete ? 'All apps' : 'All apps (still listing…)' },
            ...apps.map((a) => ({ value: a.app_scope_id, label: a.name })),
          ]}
          value={scopeId ?? ''}
          onChange={(e) => onScope(e.target.value || null)}
          style={{ width: 200 }}
        />
      </div>

      {unavailable ? (
        <div style={{ ...panel, padding: 20, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          The audit log is served by the control plane, which isn&rsquo;t available in this environment.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: 300, maxWidth: '100%', height: 32, padding: '0 10px', boxSizing: 'border-box', border: '1px solid var(--border-default)', borderRadius: 6, background: 'var(--surface-card)' }}>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                aria-label="Search the audit log"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Search people, apps, actions…"
                style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'transparent', color: 'var(--text-primary)', font: 'inherit', fontSize: 13 }}
              />
            </div>
            <div role="group" aria-label="Who acted" style={{ display: 'flex', gap: 2, padding: 2, border: '1px solid var(--border-default)', borderRadius: 8, background: 'var(--surface-inset)' }}>
              {KINDS.map(([v, label]) => (
                <button key={v} type="button" aria-pressed={kind === v} onClick={() => setKind(v)} style={seg(kind === v)}>
                  {label}
                </button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            {entries !== null && (
              <span data-testid="audit-count" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {shown.length} of {entries.length} {cursor !== null ? 'loaded ' : ''}
                {entries.length === 1 ? 'entry' : 'entries'}
              </span>
            )}
          </div>

          {missing && (
            <div role="status" style={{ ...panel, padding: '10px 16px', fontSize: 13, color: 'var(--text-secondary)' }}>
              {missing.more
                ? `The linked entry is not in the latest ${missing.pages} pages of this log. It may be older — Load older entries keeps reading.`
                : `The linked entry is not in this log${scopeId ? ' for this app' : ''}.`}{' '}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)' }}>{entryId}</span>
            </div>
          )}

          <div style={panel}>
            {entries === null ? (
              <div style={{ padding: 20, fontSize: 12.5, color: 'var(--text-tertiary)' }}>{entryId ? 'Finding the linked entry…' : 'Loading audit log…'}</div>
            ) : entries.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', fontSize: 13, color: 'var(--text-tertiary)' }}>No audited actions yet.</div>
            ) : shown.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', fontSize: 13, color: 'var(--text-tertiary)' }}>No activity matches these filters.</div>
            ) : (
              days.map((d) => (
                <section key={d.label} aria-label={d.label}>
                  <div style={{ padding: '8px 16px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)', background: 'var(--surface-inset)', borderBottom: '1px solid var(--border-subtle)' }}>
                    {d.label}
                  </div>
                  {d.items.map((e) => (
                    <EntryRow key={e.id} entry={e} appName={appName} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
                  ))}
                </section>
              ))
            )}
          </div>

          {entries !== null && cursor !== null && (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <Button variant="secondary" onClick={() => void loadOlder()} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Load older entries'}
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}

const panel: CSSProperties = {
  border: '1px solid var(--border-default)',
  borderRadius: 12,
  background: 'var(--surface-card)',
  boxShadow: 'var(--shadow-sm)',
  overflow: 'hidden',
};

// The design's "AI assistant" kind is left out: nothing records an AI actor yet.
const KINDS: [KindFilter, string][] = [
  ['all', 'All'],
  ['person', 'People'],
  ['job', 'Jobs & integrations'],
];

const seg = (on: boolean): CSSProperties => ({
  height: 26,
  padding: '0 10px',
  border: 0,
  borderRadius: 6,
  font: 'inherit',
  fontSize: 12.5,
  cursor: 'pointer',
  color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
  background: on ? 'var(--surface-card)' : 'transparent',
  boxShadow: on ? 'var(--shadow-xs)' : 'none',
});

/** A person solid, a job dashed, so the two read apart without colour. */
const avatar = (k: ActorKind): CSSProperties => ({
  width: 28,
  height: 28,
  borderRadius: '50%',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 10.5,
  fontWeight: 600,
  boxSizing: 'border-box',
  background: k === 'job' ? 'var(--surface-inset)' : 'var(--surface-active)',
  color: 'var(--text-secondary)',
  border: k === 'job' ? '1px dashed var(--border-strong)' : '1px solid transparent',
});

const tag: CSSProperties = {
  fontSize: 11,
  color: 'var(--text-tertiary)',
  border: '1px solid var(--border-default)',
  borderRadius: 4,
  padding: '0 5px',
  lineHeight: '18px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '100%',
};

const caps: CSSProperties = { fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' };

function EntryRow({ entry: e, appName, open, onToggle }: { entry: AuditEntry; appName: (id: string) => string; open: boolean; onToggle: () => void }) {
  const [hover, setHover] = useState(false);
  const who = actorOf(e.actor);
  const diff = entryDiff(e.before, e.after);
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    onToggle();
  };
  const what = actionWords(e.action);
  const kv = [
    { label: 'What', value: what.charAt(0).toUpperCase() + what.slice(1) },
    { label: 'Action', value: e.action, mono: true },
    ...(e.vertical ? [{ label: 'Vertical', value: e.vertical, mono: true }] : []),
    // The domain event that caused this action (K-22 §4.2). Nothing in the dashboard
    // addresses one event by id yet, so it is shown rather than linked.
    ...(e.causedBy ? [{ label: 'Caused by event', value: e.causedBy, mono: true }] : []),
    { label: 'When', value: <span title={e.at}>{shortDate(e.at)} · {clockTime(e.at)}</span> },
    { label: 'Actor', value: e.actor, mono: true },
    { label: 'Entry', value: e.id, mono: true },
  ];
  return (
    <div data-entry-id={e.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={onKey}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'grid',
          gridTemplateColumns: '28px minmax(0,1fr) 200px 60px',
          gap: '0 12px',
          alignItems: 'center',
          minHeight: 48,
          padding: '6px 16px',
          cursor: 'pointer',
          background: open ? 'var(--surface-active)' : hover ? 'var(--surface-hover)' : 'transparent',
        }}
      >
        <span aria-hidden style={avatar(who.kind)}>{who.initials}</span>
        <span style={{ fontSize: 13.5, lineHeight: '20px', color: 'var(--text-secondary)', textWrap: 'pretty' } as CSSProperties}>
          <span title={e.actor} style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{who.name}</span> {entrySentence(e, appName)}
        </span>
        <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', minWidth: 0 }}>
          {/* An entry that names no scope is a team-level action — a role, an entitlement. */}
          <span style={tag}>{e.scopeId ? appName(e.scopeId) : 'Team'}</span>
        </span>
        <span title={e.at} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'right' }}>{clockTime(e.at)}</span>
      </div>
      {open && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16, padding: '12px 16px 14px 56px', background: 'var(--surface-inset)', borderTop: '1px solid var(--border-subtle)' }}>
          <KeyValue items={kv} columns={2} style={{ gap: '10px 16px', wordBreak: 'break-word' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            {e.scopeId && (
              <>
                <div style={caps}>Records touched</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  <Chip href={`/apps/${e.scopeId}`}>{appName(e.scopeId)}</Chip>
                </div>
              </>
            )}
            {diff.length > 0 && (
              <>
                <div style={caps}>Changes</div>
                {diff.map((d) => (
                  <div key={d.key} data-diff-key={d.key} style={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr)', gap: 10, fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: '18px' }}>
                    <span style={{ color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis' }} title={d.key}>{d.key}</span>
                    <span style={{ wordBreak: 'break-word' }}>
                      {/* "—" is a side the log did not record, never an empty value. */}
                      {d.before === null ? (
                        <span style={{ color: 'var(--text-tertiary)' }} title="The log recorded no prior value">—</span>
                      ) : (
                        <span style={{ color: 'var(--text-tertiary)', textDecoration: 'line-through' }}>{d.before}</span>
                      )}
                      <span style={{ color: 'var(--text-tertiary)' }}> → </span>
                      {d.after === null ? (
                        <span style={{ color: 'var(--text-tertiary)' }} title="The log recorded no new value">—</span>
                      ) : (
                        <span style={{ color: 'var(--text-primary)' }}>{d.after}</span>
                      )}
                    </span>
                  </div>
                ))}
              </>
            )}
            {!e.scopeId && diff.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>This entry names no app and recorded no change.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Chip({ href, children }: { href: string; children: string }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={teamPath(href)}
      onClick={(ev) => {
        if (!isPlainClick(ev)) return;
        ev.preventDefault();
        navigate(href);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        height: 24,
        alignItems: 'center',
        padding: '0 9px',
        border: `1px solid ${hover ? 'var(--border-strong)' : 'var(--border-default)'}`,
        borderRadius: 999,
        background: 'var(--surface-card)',
        fontSize: 12,
        color: 'var(--text-primary)',
        textDecoration: 'none',
      }}
    >
      {children}
    </a>
  );
}
