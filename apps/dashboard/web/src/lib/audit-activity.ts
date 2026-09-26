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

// Past tense for the verbs audit actions start with. The rest get "-ed"/"-d", which is
// right for every regular verb the control plane logs today.
const IRREGULAR: Record<string, string> = { set: 'set', bind: 'bound', unbind: 'unbound', rewind: 'rewound', reset: 'reset', put: 'put' };

/** `bindScopeVersion` → "bound scope version". */
export function actionWords(action: string): string {
  const words = action
    .replace(/[_.-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
    .split(/\s+/);
  const [verb, ...rest] = words;
  if (!verb) return action;
  const past = IRREGULAR[verb] ?? (verb.endsWith('ed') ? verb : verb.endsWith('e') ? `${verb}d` : `${verb}ed`);
  return [past, ...rest].join(' ');
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
export function filterEntries(entries: AuditEntry[], opts: { kind: KindFilter; text: string; appName: (scopeId: string) => string | null }): AuditEntry[] {
  const q = opts.text.trim().toLowerCase();
  return entries.filter((e) => {
    const who = actorOf(e.actor);
    if (opts.kind !== 'all' && who.kind !== opts.kind) return false;
    if (!q) return true;
    const app = e.scopeId ? opts.appName(e.scopeId) ?? '' : '';
    return [who.name, e.actor, entrySentence(e, opts.appName), app, e.action].join(' ').toLowerCase().includes(q);
  });
}

export interface DiffRow {
  key: string;
  /** Null where the log recorded no value for this side — rendered "—", never as a value. */
  before: string | null;
  after: string | null;
}

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The keys an entry changed. `before` is only recorded where the prior state was cheap to
 * read, so a missing side is "not recorded" rather than "was empty". A non-object payload
 * is one row under `value`.
 */
export function entryDiff(before: unknown, after: unknown): DiffRow[] {
  if (before == null && after == null) return [];
  if ((before == null || isRecord(before)) && (after == null || isRecord(after))) {
    const b = (before ?? {}) as Record<string, unknown>;
    const a = (after ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
    return keys
      .filter((k) => show(b[k]) !== show(a[k]))
      .map((k) => ({ key: k, before: k in b ? show(b[k]) : null, after: k in a ? show(a[k]) : null }));
  }
  if (show(before) === show(after)) return [];
  return [{ key: 'value', before: before == null ? null : show(before), after: after == null ? null : show(after) }];
}
