import type { AuditEntry } from './api';
import { shortId } from './format';

/**
 * The Audit page's derivations (#1825): who an entry's actor is, the sentence it reads
 * as, the day it falls on, the filters, and the before → after diff. The Overview's
 * Recent activity composes its rows from the same functions, so an entry reads the same
 * on both pages.
 *
 * Everything here is composed from the admin log's own fields. The design's Why / How
 * rows (purpose, lawful basis, client) and its "personal data" flag have no field behind
 * them yet (#1751), so nothing here guesses at them.
 */

// The past tense of every verb an `adminAction` starts with. Spelled out rather than
// derived: the enum is closed, and a suffix rule gets the irregular and doubled forms
// wrong ("admited", "begined"). A test holds this map to the enum.
const PAST: Record<string, string> = {
  activate: 'activated', add: 'added', admit: 'admitted', archive: 'archived', assign: 'assigned',
  begin: 'began', bind: 'bound', clear: 'cleared', create: 'created', define: 'defined', delete: 'deleted',
  drain: 'drained', end: 'ended', grant: 'granted', import: 'imported', link: 'linked',
  mark: 'marked', mint: 'minted', move: 'moved', promote: 'promoted', provision: 'provisioned',
  prune: 'pruned', publish: 'published', put: 'put', reap: 'reaped', reassert: 'reasserted',
  redrain: 'redrained', register: 'registered', reject: 'rejected', remove: 'removed',
  request: 'requested', reset: 'reset', resolve: 'resolved', restore: 'restored', revoke: 'revoked', rewind: 'rewound',
  set: 'set', shred: 'shredded', suspend: 'suspended', transfer: 'transferred', unarchive: 'unarchived',
  unassign: 'unassigned', unbind: 'unbound', unlink: 'unlinked', unsuspend: 'unsuspended', update: 'updated',
};

/** An action key split into lower-case words: `bindScopeVersion` → `['bind', 'scope', 'version']`. */
export function actionKeyWords(action: string): string[] {
  return action
    .replace(/[_.-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * `bindScopeVersion` → "bound scope version". An action whose verb is not in the map —
 * one a newer control plane logs before this page knows it — is left untensed and
 * labelled, "admin action: frobnicate scope", rather than guessed at.
 */
export function actionWords(action: string): string {
  const [verb, ...rest] = actionKeyWords(action);
  if (!verb) return action;
  const past = PAST[verb];
  return past ? [past, ...rest].join(' ') : `admin action: ${[verb, ...rest].join(' ')}`;
}

/** `person` has a name, `job` is the platform or a service acting, `unknown` is an actor id nothing here can name. */
export type ActorKind = 'person' | 'job' | 'unknown';

export interface Actor {
  kind: ActorKind;
  /** What the sentence bolds. */
  name: string;
  initials: string;
}

// The fixed actor ids the platform's own services write under (apps/control-plane and
// apps/dashboard workers). The dashboard's is the one most of a team's entries carry:
// the admin log records the service that called the control plane, not the person who
// clicked, so those entries read as the dashboard rather than as a guessed name.
const SERVICE_ACTORS: Record<string, string> = {
  '01JZ00000000000000000000SV': 'A connected app',
  '01JZ00000000000000000000SW': 'Scheduled sweep',
  '01JZ00000000000000000000CR': 'Connection relay',
  '01JZ000000000000000000DASH': 'Dashboard',
  '01JZ000000000000000000BDR1': 'Builder',
};

function initialsOf(name: string): string {
  const local = name.split('@')[0]!.replace(/[._-]+/g, ' ').trim();
  const parts = local.split(/\s+/);
  return (parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : local.slice(0, 2)).toUpperCase() || '?';
}

/**
 * Who an actor string is. An email is a person; `service:*` and the platform's fixed
 * service ids are jobs; any other id is left `unknown` rather than filed under either,
 * because the log cannot tell a staff member's id from a one-off provisioning id.
 */
export function actorOf(actor: string): Actor {
  if (actor.includes('@')) return { kind: 'person', name: actor, initials: initialsOf(actor) };
  if (actor.startsWith('service:')) return { kind: 'job', name: 'Substrat', initials: 'SU' };
  const service = SERVICE_ACTORS[actor];
  if (service) return { kind: 'job', name: service, initials: initialsOf(service) };
  return { kind: 'unknown', name: `Actor ${shortId(actor)}`, initials: '?' };
}

/** A team member's principal → their email, or null for one this page cannot name. */
export type PersonName = (principal: string) => string | null;

/**
 * Who an ENTRY names (#977): the person the actor acted for when the row recorded one, and
 * the actor otherwise. A row a service wrote for somebody is that somebody's act — the
 * service is how it reached the plane, shown beside it (`entryVia`), never in its place.
 */
export function entryActorOf(e: Pick<AuditEntry, 'actor' | 'onBehalfOf'>, personName: PersonName = () => null): Actor {
  const p = e.onBehalfOf?.principal;
  if (!p) return actorOf(e.actor);
  const email = personName(p);
  return email
    ? { kind: 'person', name: email, initials: initialsOf(email) }
    : { kind: 'person', name: `Member ${shortId(p)}`, initials: '?' };
}

/** "Dashboard" — the service that carried an attributed entry, or null when the actor acted for itself. */
export function entryVia(e: Pick<AuditEntry, 'actor' | 'onBehalfOf'>): string | null {
  return e.onBehalfOf ? actorOf(e.actor).name : null;
}

/** "assigned role on Acme HR" — the sentence after the actor's bold name. */
export function entrySentence(e: Pick<AuditEntry, 'action' | 'scopeId'>, appName: (scopeId: string) => string | null): string {
  const app = e.scopeId ? appName(e.scopeId) : null;
  return `${actionWords(e.action)}${app ? ` on ${app}` : ''}`;
}

/** The Overview's link into one entry: the app narrowing it was already linked with, plus the entry. */
export function entryHref(e: Pick<AuditEntry, 'id' | 'scopeId'>): string {
  const q = new URLSearchParams();
  if (e.scopeId) q.set('app', e.scopeId);
  q.set('entry', e.id);
  return `/audit?${q.toString()}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock time, "14:02". */
export function clockTime(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? '—' : `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

// Spelled out rather than left to the locale, whose short September is "Sept" in some.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today · Fri 26 Sep", "Yesterday · Thu 25 Sep", "Wed 24 Sep", and the year once it is not this one. */
export function dayLabel(iso: string, now = Date.now()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return 'Unknown date';
  const n = new Date(now);
  const date = `${WEEKDAYS[t.getDay()]} ${t.getDate()} ${MONTHS[t.getMonth()]}${t.getFullYear() === n.getFullYear() ? '' : ` ${t.getFullYear()}`}`;
  if (t.toDateString() === n.toDateString()) return `Today · ${date}`;
  const y = new Date(n);
  y.setDate(n.getDate() - 1);
  if (t.toDateString() === y.toDateString()) return `Yesterday · ${date}`;
  return date;
}

/** Consecutive entries on one local day, in the order the log gave them (newest first). */
export function groupByDay<T extends { at: string }>(entries: T[], now = Date.now()): { label: string; items: T[] }[] {
  const days: { label: string; items: T[] }[] = [];
  for (const e of entries) {
    const label = dayLabel(e.at, now);
    const last = days[days.length - 1];
    if (last && last.label === label) last.items.push(e);
    else days.push({ label, items: [e] });
  }
  return days;
}

export type KindFilter = 'all' | 'person' | 'job';

/** Kind and free-text filters. Text matches the actor, the sentence, the app and the raw action key. */
export function filterEntries(
  entries: AuditEntry[],
  opts: { kind: KindFilter; text: string; appName: (scopeId: string) => string | null; personName?: PersonName },
): AuditEntry[] {
  const q = opts.text.trim().toLowerCase();
  return entries.filter((e) => {
    const who = entryActorOf(e, opts.personName);
    if (opts.kind !== 'all' && who.kind !== opts.kind) return false;
    if (!q) return true;
    const app = e.scopeId ? opts.appName(e.scopeId) ?? '' : '';
    const via = entryVia(e) ?? '';
    return [who.name, e.actor, e.onBehalfOf?.principal ?? '', via, entrySentence(e, opts.appName), app, e.action]
      .join(' ')
      .toLowerCase()
      .includes(q);
  });
}

export interface DiffRow {
  key: string;
  /** Null where the log recorded no value for this side — rendered "—", never as a value. */
  before: string | null;
  after: string | null;
}

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
const same = (x: unknown, y: unknown): boolean => JSON.stringify(x) === JSON.stringify(y);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One changed key. Where the plain forms would read alike ("1" and 1), both sides are shown as JSON, so the string is quoted. */
function row(key: string, b: unknown, a: unknown, hasB: boolean, hasA: boolean): DiffRow {
  const typed = hasB && hasA && show(b) === show(a);
  const fmt = typed ? (v: unknown) => JSON.stringify(v) : show;
  return { key, before: hasB ? fmt(b) : null, after: hasA ? fmt(a) : null };
}

/**
 * The keys an entry changed, compared by JSON so a change of type counts. `before` is
 * only recorded where the prior state was cheap to read, so a missing side is "not
 * recorded" rather than "was empty". A non-object payload is one row under `value`.
 */
export function entryDiff(before: unknown, after: unknown): DiffRow[] {
  if (before == null && after == null) return [];
  if ((before == null || isRecord(before)) && (after == null || isRecord(after))) {
    const b = (before ?? {}) as Record<string, unknown>;
    const a = (after ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
    return keys.filter((k) => !same(b[k], a[k])).map((k) => row(k, b[k], a[k], k in b, k in a));
  }
  if (same(before, after)) return [];
  return [row('value', before, after, before != null, after != null)];
}

// -- #1828: refused permission checks, beside the actions -----------------------------

/** A refused permission check, as far as the page reads one (the K-35 denial log's row). */
export interface Refusal {
  id: string;
  /** The contracts `Actor`: a principal id, or `{ system }` / `{ connection }` / `{ capability }` / `{ vertical }`. */
  actor: unknown;
  permission: string;
  operation: string | null;
  invocationId: string | null;
  /** The K-42 stamp when a staff member was acting as someone; null the ordinary case. */
  impersonation: unknown;
  at: string;
}

/**
 * Who a refusal's actor is, in this page's words. A principal id is named the way an
 * action's actor id is (`actorOf`), so the same actor reads the same in both kinds of row;
 * the kinds only a refusal can carry are the platform acting, so they read as jobs.
 */
export function refusalActorOf(actor: unknown): Actor {
  if (typeof actor === 'string') return actorOf(actor);
  if (actor && typeof actor === 'object') {
    const a = actor as Record<string, unknown>;
    const job = (name: string): Actor => ({ kind: 'job', name, initials: initialsOf(name) });
    // The kernel's tolerant decoder writes this marker for an actor it could not read
    // (#1636, `UNDECODED_ACTOR`). It is not a consumer, and naming it one would attribute a
    // corrupt or legacy row to a job that never acted.
    if (a['system'] === 'undecodable') return { kind: 'unknown', name: 'An actor that could not be read', initials: '?' };
    if (typeof a['system'] === 'string') return job(`${a['system']} (a consumer)`);
    if (typeof a['connection'] === 'string') return job('A connector');
    if (typeof a['capability'] === 'string') return job('Someone with a shared link');
    if (typeof a['vertical'] === 'string') return job(`The ${a['vertical']} app`);
  }
  return { kind: 'unknown', name: 'An unrecorded actor', initials: '?' };
}

/** "was refused workorder:complete on workorder/complete" — after the actor's bold name. */
export function refusalSentence(r: Pick<Refusal, 'permission' | 'operation'>): string {
  return `was refused ${r.permission}${r.operation ? ` on ${r.operation}` : ''}`;
}

export type OutcomeFilter = 'all' | 'allowed' | 'refused';

export type ActivityItem = { kind: 'action'; at: string; id: string; entry: AuditEntry } | { kind: 'refusal'; at: string; id: string; refusal: Refusal };

/**
 * The two logs as one list, newest first — WITHOUT inventing an order the reads did not give.
 *
 * Each log is read a page at a time, and each page stops somewhere. Past the point where a
 * log has more to give, its next page could hold rows newer than anything already read of
 * the other one; showing the other log's older rows there would be showing them out of
 * order, with the gap filled in later. So the list stops at the NEWEST such point (its
 * `floor`), and what is read below it waits. `older` says which log the next "Load older"
 * reads: the one whose boundary is holding the list back.
 */
export function mergeActivity(
  actions: { entries: AuditEntry[]; more: boolean } | null,
  refusals: { entries: Refusal[]; more: boolean } | null,
): { items: ActivityItem[]; floor: string | null; older: 'actions' | 'refusals' | null } {
  const oldest = (xs: { at: string }[]) => xs.reduce<string | null>((m, x) => (m === null || x.at < m ? x.at : m), null);
  const bounds: { log: 'actions' | 'refusals'; at: string }[] = [];
  if (actions?.more) bounds.push({ log: 'actions', at: oldest(actions.entries) ?? '9999' });
  if (refusals?.more) bounds.push({ log: 'refusals', at: oldest(refusals.entries) ?? '9999' });
  const hold = bounds.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0] ?? null;
  const all: ActivityItem[] = [
    ...(actions?.entries ?? []).map((entry) => ({ kind: 'action' as const, at: entry.at, id: entry.id, entry })),
    ...(refusals?.entries ?? []).map((refusal) => ({ kind: 'refusal' as const, at: refusal.at, id: refusal.id, refusal })),
  ];
  const items = all
    .filter((i) => hold === null || i.at >= hold.at)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
  return { items, floor: hold?.at ?? null, older: hold?.log ?? null };
}

/** The Outcome, kind and text filters over the merged list. */
export function filterActivity(
  items: ActivityItem[],
  opts: { outcome: OutcomeFilter; kind: KindFilter; text: string; appName: (scopeId: string) => string | null; personName?: PersonName },
): ActivityItem[] {
  const q = opts.text.trim().toLowerCase();
  return items.filter((i) => {
    if (opts.outcome === 'allowed' && i.kind !== 'action') return false;
    if (opts.outcome === 'refused' && i.kind !== 'refusal') return false;
    if (i.kind === 'action') return filterEntries([i.entry], opts).length === 1;
    const who = refusalActorOf(i.refusal.actor);
    if (opts.kind !== 'all' && who.kind !== opts.kind) return false;
    if (!q) return true;
    return [who.name, refusalSentence(i.refusal), i.refusal.permission, 'refused'].join(' ').toLowerCase().includes(q);
  });
}
