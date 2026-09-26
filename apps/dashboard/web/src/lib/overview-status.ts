import type { AccountIntegration, AuditEntry, ConnectionView } from './api';
import { VERDICTS, type FleetRow, type FleetVerdict } from './fleet-rows';
import { relativeTime } from './format';
import { obsPath } from './router';

/**
 * The Overview home's derivations (#1815): the status sentence, the Needs attention
 * list, the integration rows and the activity sentences — every word on the page that
 * is composed rather than read verbatim.
 *
 * The design has the status sentence written by AI (#1749). Until that lands it is
 * composed here, deterministically, from the same reads the rest of the page shows —
 * so it can never say something the rows beneath it do not. Two rules carry over from
 * the design: a problem always says whose side it is on (the app's, or the supplier's),
 * and a read that failed is named as unread rather than counted as fine.
 */

/** One read's outcome: the value, `null` while it is in flight, or `'failed'`. */
export type Read<T> = T | null | 'failed';

/** An app verdict that puts the app on Needs attention. `installing` is on its way, not wrong. */
const ATTENTION: ReadonlySet<FleetVerdict> = new Set(['install-failed', 'failing', 'stale', 'silent', 'unknown']);

export function needsAttention(v: FleetVerdict): boolean {
  return ATTENTION.has(v);
}

/** Stale and silent are schedule questions; the rest open the app itself. */
export function appHref(row: Pick<FleetRow, 'scopeId' | 'verdict'>): string {
  return row.verdict === 'stale' || row.verdict === 'silent' ? obsPath({ app: row.scopeId, view: 'schedules' }) : `/apps/${row.scopeId}/overview`;
}

/** One connection flattened with the provider it belongs to. */
export interface OverviewConnection {
  provider: string;
  providerName: string;
  connection: ConnectionView & { vertical: string; apps: Array<{ scopeId: string; name: string }> };
}

export function connectionsOf(providers: AccountIntegration[]): OverviewConnection[] {
  return providers.flatMap((p) => p.connections.map((c) => ({ provider: p.provider, providerName: p.name, connection: c })));
}

/** Connections that need someone: an error, or a credential that expired. A revoked one was disconnected on purpose. */
function troubled(c: OverviewConnection): boolean {
  return c.connection.status === 'error' || c.connection.status === 'expired';
}

function usedBy(c: OverviewConnection['connection']): string {
  return c.apps.length > 0 ? c.apps.map((a) => a.name).join(', ') : c.vertical;
}

/** "Acme HR", "Acme HR and Acme Legal", "Acme HR, Acme Legal and Acme Ops". */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const APP_PHRASE: Record<FleetVerdict, { one: string; many: string; detail: string }> = {
  'install-failed': { one: 'failed to install', many: 'failed to install', detail: 'failed to install' },
  failing: { one: 'is failing', many: 'are failing', detail: 'is failing on the app’s side' },
  stale: { one: 'is stale', many: 'are stale', detail: 'is stale on the app’s side' },
  silent: { one: 'is not being checked', many: 'are not being checked', detail: 'is not being checked' },
  unknown: { one: 'could not be judged', many: 'could not be judged', detail: 'could not be judged' },
  installing: { one: 'is installing', many: 'are installing', detail: 'is still installing' },
  ok: { one: 'is working', many: 'are working', detail: 'is working' },
};

function appClause(verdict: FleetVerdict, rows: FleetRow[]): string {
  const p = APP_PHRASE[verdict];
  return rows.length === 1 ? `${rows[0]!.name} ${p.one}` : `${rows.length} apps ${p.many}`;
}

function integrationClause(c: OverviewConnection[]): string[] {
  const erroring = [...new Set(c.filter((x) => x.connection.status === 'error').map((x) => x.providerName))];
  const expired = [...new Set(c.filter((x) => x.connection.status === 'expired').map((x) => x.providerName))];
  return [
    ...(erroring.length ? [`${list(erroring)} ${erroring.length === 1 ? 'is' : 'are'} erroring on the supplier’s side`] : []),
    ...(expired.length ? [`${list(expired)} ${expired.length === 1 ? 'needs' : 'need'} reconnecting`] : []),
  ];
}

/** How many problems the detail line spells out before pointing at the list below. */
const DETAIL_CAP = 3;

/**
 * The status card's headline and detail.
 *
 * `apps` is the fleet as `fleetRows` judges it; `healthRead` says whether the verdict
 * read landed, because without it every running app reads `unknown` and "nothing is
 * failing" would be a claim nothing supports.
 */
export function statusSentence(input: {
  apps: FleetRow[];
  healthRead: 'ok' | 'failed';
  integrations: AccountIntegration[] | 'failed';
}): { headline: string; detail: string } {
  const { apps } = input;
  const by = (v: FleetVerdict) => apps.filter((a) => a.verdict === v);
  const ok = by('ok');
  const installing = by('installing');
  const conns = input.integrations === 'failed' ? [] : connectionsOf(input.integrations);
  const badConns = conns.filter(troubled);
  const integrationsUnread = input.integrations === 'failed';

  const unreadNote = integrationsUnread ? 'Integrations could not be read, so their state is unknown.' : null;
  const installingNote = installing.length ? `${list(installing.map((a) => a.name))} ${installing.length === 1 ? 'is' : 'are'} still installing.` : null;

  if (apps.length === 0) {
    return { headline: 'No apps yet.', detail: unreadNote ?? '' };
  }

  // Health unread: the running apps are unknown, and saying so IS the headline.
  if (input.healthRead === 'failed') {
    const failedInstalls = by('install-failed');
    const clauses = [
      ...(failedInstalls.length ? [appClause('install-failed', failedInstalls)] : []),
      ...integrationClause(badConns),
    ];
    return {
      headline: `App health could not be read${clauses.length ? `, and ${list(clauses)}` : ''}.`,
      detail: [
        'No app is reported as working until its health can be read — reload to try again.',
        installingNote,
        ...badConns.slice(0, DETAIL_CAP).map(connectionDetail),
        unreadNote,
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  const problems = apps.filter((a) => needsAttention(a.verdict));
  if (problems.length === 0 && badConns.length === 0) {
    const running = apps.length - installing.length;
    const headline = integrationsUnread
      ? `All ${running} running ${running === 1 ? 'app is' : 'apps are'} working; integrations could not be read.`
      : installing.length
        ? `All ${running} running ${running === 1 ? 'app is' : 'apps are'} working.`
        : `All ${running} ${running === 1 ? 'app is' : 'apps are'} working.`;
    const connected = conns.filter((c) => c.connection.status === 'active').length;
    return {
      headline,
      detail: [
        'Nothing is failing, overdue or unchecked.',
        installingNote,
        integrationsUnread ? unreadNote : connected ? `${connected === 1 ? 'The one integration connection is' : `All ${connected} integration connections are`} connected.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  // The headline names the worst verdict's apps and counts the rest; the detail line
  // and the Needs attention list carry every one of them.
  const worst = (Object.keys(VERDICTS) as FleetVerdict[])
    .filter((v) => needsAttention(v))
    .sort((a, b) => VERDICTS[a].rank - VERDICTS[b].rank)
    .map((v) => ({ v, rows: problems.filter((p) => p.verdict === v) }))
    .find((g) => g.rows.length > 0);
  const rest = problems.length - (worst?.rows.length ?? 0);
  const appPart = worst ? `${appClause(worst.v, worst.rows)}${rest ? ` and ${rest} more ${rest === 1 ? 'app needs' : 'apps need'} attention` : ''}` : '';
  const connPart = list(integrationClause(badConns));
  const headline = !appPart
    ? `Your apps are working, but ${connPart}.`
    : `${ok.length > 0 ? 'Mostly working. ' : ''}${appPart}${connPart ? `, and ${connPart}` : ''}.`;

  // In the order the Needs attention list gives them, so the first reasons here are its first rows.
  const reasons = [
    ...problems.map((a) => ({ rank: VERDICTS[a.verdict].rank, text: `${a.name} ${APP_PHRASE[a.verdict].detail}: ${lowerFirst(a.why)}` })),
    ...badConns.map((c) => ({ rank: connRank(c), text: connectionDetail(c) })),
  ]
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.text);
  const shown = reasons.slice(0, DETAIL_CAP).map((r) => (/[.!?]$/.test(r) ? r : `${r}.`));
  const more = reasons.length - shown.length;
  return {
    headline,
    detail: [...shown, more > 0 ? `${more} more below.` : null, installingNote, unreadNote].filter(Boolean).join(' '),
  };
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** A connection in error ranks with the failing apps, an expired one with the stale. */
function connRank(c: OverviewConnection): number {
  return c.connection.status === 'error' ? VERDICTS.failing.rank : VERDICTS.stale.rank;
}

function connectionDetail(c: OverviewConnection): string {
  const conn = c.connection;
  if (conn.status === 'expired') return `${c.providerName}’s credential has expired, so ${usedBy(conn)} cannot reach it until it is reconnected.`;
  return conn.lastError
    ? `${c.providerName} answered with an error on the supplier’s side: ${conn.lastError}${/[.!?]$/.test(conn.lastError) ? '' : '.'}`
    : `${c.providerName} is in error on the supplier’s side; it gave no message.`;
}

/** One Needs attention row — an app or a connection, with where its action goes. */
export interface AttentionRow {
  key: string;
  status: 'danger' | 'warning' | 'neutral';
  badge: string;
  what: string;
  where: string;
  text: string;
  action: string;
  href: string;
}

const APP_ACTION: Partial<Record<FleetVerdict, string>> = { stale: 'Schedules →', silent: 'Schedules →' };

/** Every app that is not OK and every connection in trouble, worst first, ranked as the fleet table ranks. */
export function attentionRows(input: { apps: FleetRow[]; integrations: AccountIntegration[] | 'failed' | null }): AttentionRow[] {
  const apps = input.apps
    .filter((a) => needsAttention(a.verdict))
    .map((a) => ({
      rank: VERDICTS[a.verdict].rank,
      row: {
        key: `app:${a.scopeId}`,
        status: VERDICTS[a.verdict].status as AttentionRow['status'],
        badge: VERDICTS[a.verdict].label.toLowerCase(),
        what: a.name,
        where: a.vertical,
        text: a.why,
        action: APP_ACTION[a.verdict] ?? 'Open app →',
        href: appHref(a),
      },
    }));
  const conns = Array.isArray(input.integrations)
    ? connectionsOf(input.integrations)
        .filter(troubled)
        .map((c) => {
          const err = c.connection.status === 'error';
          return {
            rank: connRank(c),
            row: {
              key: `conn:${c.connection.id}`,
              status: (err ? 'danger' : 'warning') as AttentionRow['status'],
              badge: err ? 'error' : 'expired',
              what: c.providerName,
              where: `connection · ${usedBy(c.connection)}`,
              text: connectionDetail(c),
              action: err ? 'Integration →' : 'Reconnect →',
              href: '/integrations',
            },
          };
        })
    : [];
  return [...apps, ...conns].sort((a, b) => a.rank - b.rank).map((x) => x.row);
}

/** The apps-grid status filter. */
export type AppsFilter = 'all' | 'attention' | 'working';

export function filterApps(rows: FleetRow[], q: string, filter: AppsFilter): FleetRow[] {
  const needle = q.trim().toLowerCase();
  return rows.filter((r) => {
    if (needle && !r.name.toLowerCase().includes(needle)) return false;
    if (filter === 'attention') return needsAttention(r.verdict);
    if (filter === 'working') return r.verdict === 'ok';
    return true;
  });
}

/** One provider on the Integrations card: its worst connection's state, in words from real fields. */
export interface IntegrationRow {
  provider: string;
  name: string;
  used: string;
  state: string;
  tone: 'success' | 'danger' | 'warning' | 'neutral';
  text: string;
}

const CONN_STATE: Record<ConnectionView['status'], { state: string; tone: IntegrationRow['tone']; rank: number }> = {
  error: { state: 'Error', tone: 'danger', rank: 0 },
  expired: { state: 'Expired', tone: 'warning', rank: 1 },
  active: { state: 'Connected', tone: 'success', rank: 2 },
  revoked: { state: 'Disconnected', tone: 'neutral', rank: 3 },
};

export function integrationRows(providers: AccountIntegration[], now = Date.now()): IntegrationRow[] {
  return providers
    .filter((p) => p.connections.length > 0)
    .map((p) => {
      const worst = [...p.connections].sort((a, b) => CONN_STATE[a.status].rank - CONN_STATE[b.status].rank)[0]!;
      const s = CONN_STATE[worst.status];
      const apps = [...new Set(p.connections.flatMap((c) => (c.apps.length ? c.apps.map((a) => a.name) : [c.vertical])))];
      const of = p.connections.length > 1 ? `${p.connections.filter((c) => c.status === worst.status).length} of ${p.connections.length} connections · ` : '';
      return { provider: p.provider, name: p.name, used: apps.join(' · '), state: s.state, tone: s.tone, text: of + connectionText(p.name, worst, now), rank: s.rank };
    })
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank: _rank, ...row }) => row);
}

/** The sentence after the state word — only what the connection record carries. */
function connectionText(name: string, c: ConnectionView, now: number): string {
  switch (c.status) {
    case 'error':
      return `on ${name}’s side${c.lastErrorAt ? ` ${relativeTime(c.lastErrorAt, now)}` : ''}${c.lastError ? `: ${c.lastError}` : ''}`;
    case 'expired':
      return c.expiresAt ? `credential expired ${relativeTime(c.expiresAt, now)}; reconnect it` : 'credential expired; reconnect it';
    case 'revoked':
      return 'disconnected';
    default:
      return c.lastOkAt ? `last used ${relativeTime(c.lastOkAt, now)}` : 'not used yet';
  }
}

/** One Recent activity row. */
export interface ActivityRow {
  id: string;
  initials: string;
  who: string;
  actor: string;
  text: string;
  time: string;
  href: string;
}

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

/** `service:control-plane` is the platform acting; a person's actor is their email. */
function actorName(actor: string): string {
  return actor.startsWith('service:') ? 'Substrat' : actor;
}

function avatar(name: string): string {
  const local = name.split('@')[0]!.replace(/[._-]+/g, ' ').trim();
  const parts = local.split(/\s+/);
  return (parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : local.slice(0, 2)).toUpperCase() || '?';
}

/** Today → "14:02"; this week → "Mon"; older → "Sep 3". */
export function activityTime(iso: string, now = Date.now()): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const n = new Date(now);
  if (t.toDateString() === n.toDateString()) return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  if (now - t.getTime() < 6 * 86400e3) return t.toLocaleDateString('en', { weekday: 'short' });
  return t.toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

export function activityRows(entries: AuditEntry[], appName: (scopeId: string) => string | null, now = Date.now()): ActivityRow[] {
  return entries.slice(0, 6).map((e) => {
    const who = actorName(e.actor);
    const app = e.scopeId ? appName(e.scopeId) : null;
    return {
      id: e.id,
      initials: avatar(who),
      who,
      actor: e.actor,
      text: `${actionWords(e.action)}${app ? ` on ${app}` : ''}`,
      time: activityTime(e.at, now),
      href: e.scopeId ? `/audit?app=${e.scopeId}` : '/audit',
    };
  });
}

/** "updated 15:58" — when the reads landed. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
