import type { AccountIntegration, AuditEntry, ConnectionView } from './api';
import { VERDICTS, type FleetRow, type FleetVerdict } from './fleet-rows';
import { relativeTime } from './format';
import { actorOf, entryHref, entrySentence } from './audit-activity';
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

/** How one app's problem reads, naming whose side it is on where the verdict says so. */
const APP_PHRASE: Partial<Record<FleetVerdict, string>> = {
  'install-failed': 'failed to install',
  failing: 'is failing on the app’s side',
  stale: 'is stale on the app’s side',
  silent: 'is not being checked',
  unknown: 'could not be judged',
};

/** "Fortnox is erroring on its side", or a count when more than one supplier is in trouble. */
function supplierClause(bad: OverviewConnection[]): string | null {
  const names = [...new Set(bad.map((c) => c.providerName))];
  if (names.length === 0) return null;
  if (names.length > 1) return `${names.length} integrations need attention`;
  return bad.some((c) => c.connection.status === 'error') ? `${names[0]} is erroring on its side` : `${names[0]} needs reconnecting`;
}

function sentence(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * The status card's headline and detail — deliberately short: one headline of at most
 * one "and", and a detail of at most two sentences that names the worst one or two
 * items and points at the list below for the rest. An app still installing is on its
 * way, not a problem, and appears in neither.
 *
 * `apps` is the fleet as `fleetRows` judges it; `healthRead` says whether the verdict
 * read landed, because without it every running app reads `unknown` and "nothing is
 * failing" would be a claim nothing supports. `partial` says the app list itself stopped
 * short, so "all" may only be said of the apps that were read.
 *
 * A read that failed is said in the HEADLINE, in every branch: the detail's two
 * sentences belong to the rows, and a failure competing with them for a slot gets
 * crowded out exactly when there is most to list.
 */
export function statusSentence(input: {
  apps: FleetRow[];
  healthRead: 'ok' | 'failed';
  integrations: AccountIntegration[] | 'failed';
  partial?: boolean;
}): { headline: string; detail: string } {
  const { apps } = input;
  const running = apps.filter((a) => a.verdict !== 'installing').length;
  const ok = apps.filter((a) => a.verdict === 'ok');
  const integrationsUnread = input.integrations === 'failed';
  const conns = input.integrations === 'failed' ? [] : connectionsOf(input.integrations);
  const badConns = conns.filter(troubled);
  const supplier = supplierClause(badConns);
  // Appended to a headline whose own clause has no read failure in it.
  const unreadTail = integrationsUnread ? '; integrations could not be read' : '';

  if (apps.length === 0) return { headline: `No apps yet${unreadTail}.`, detail: '' };

  // Health unread: no running app can be called working, and saying so IS the headline.
  if (input.healthRead === 'failed') {
    const known = apps.filter((a) => a.verdict === 'install-failed').length + badConns.length;
    return {
      headline: integrationsUnread
        ? 'App health and integrations could not be read.'
        : `App health could not be read${supplier ? `, and ${supplier}` : ''}.`,
      detail: ['No app is reported as working until its health can be read.', known ? `${known} more below.` : null].filter(Boolean).join(' '),
    };
  }

  const problems = apps.filter((a) => needsAttention(a.verdict));
  if (problems.length === 0 && badConns.length === 0) {
    const n = input.partial ? `${running} ${running === 1 ? 'app read is' : 'apps read are'}` : `${running} ${running === 1 ? 'app is' : 'apps are'}`;
    const connected = conns.filter((c) => c.connection.status === 'active').length;
    return {
      headline: `All ${n} working${unreadTail}.`,
      detail: [
        'Nothing is failing, overdue or unchecked.',
        connected ? `${connected === 1 ? 'The one integration is' : `All ${connected} integrations are`} connected.` : null,
      ]
        .filter(Boolean)
        .join(' '),
    };
  }

  const appPart = problems.length === 1 ? `${problems[0]!.name} ${APP_PHRASE[problems[0]!.verdict]}` : problems.length > 1 ? `${problems.length} apps need attention` : null;
  const headline = !appPart
    ? `Your apps are working, but ${supplier}.`
    : `${ok.length > 0 ? 'Mostly working. ' : ''}${ok.length > 0 ? appPart : appPart.charAt(0).toUpperCase() + appPart.slice(1)}${supplier ? `, and ${supplier}` : unreadTail}.`;

  // In the Needs attention list's order, so the items named here are its first rows.
  const items = [
    ...problems.map((a) => ({ rank: VERDICTS[a.verdict].rank, text: sentence(`${a.name} ${APP_PHRASE[a.verdict]}: ${lowerFirst(a.why)}`) })),
    ...badConns.map((c) => ({ rank: connRank(c), text: connectionDetail(c) })),
  ]
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.text);
  const named = items.length <= 2 ? items : items.slice(0, 1);
  const more = items.length - named.length;
  return { headline, detail: [...named, more ? `${more} more below.` : null].filter(Boolean).join(' ') };
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** A connection in error ranks with the failing apps, an expired one with the stale. */
function connRank(c: OverviewConnection): number {
  return c.connection.status === 'error' ? VERDICTS.failing.rank : VERDICTS.stale.rank;
}

/**
 * A provider's error in its own words, with the provider's name taken out — the
 * sentence around it names the provider once, with its side. "HTTP 503 from Fortnox:
 * service temporarily unavailable" becomes "HTTP 503, service temporarily unavailable".
 */
export function errorWords(provider: string, error: string): string {
  const name = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return error
    .replace(new RegExp(`\\s*\\b(?:from|at|by)\\s+${name}\\b`, 'gi'), '')
    .replace(new RegExp(`^${name}\\s*:\\s*`, 'i'), '')
    .replace(/\s*:\s*/g, ', ')
    .replace(/[\s.,;]+$/, '')
    .trim();
}

/** "HTTP 503, service temporarily unavailable, on Fortnox’s side" — the side stated once. */
function supplierError(provider: string, c: ConnectionView): string {
  const words = c.lastError ? errorWords(provider, c.lastError) : '';
  return words ? `${words}, on ${provider}’s side` : `an error with no message, on ${provider}’s side`;
}

function connectionDetail(c: OverviewConnection): string {
  const conn = c.connection;
  if (conn.status === 'expired') return `${c.providerName}’s credential has expired, so ${usedBy(conn)} cannot reach it until it is reconnected.`;
  const e = supplierError(c.providerName, conn);
  return `${e.charAt(0).toUpperCase()}${e.slice(1)}.`;
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
      return `${supplierError(name, c)}${c.lastErrorAt ? `, ${relativeTime(c.lastErrorAt, now)}` : ''}`;
    case 'expired':
      return c.expiresAt ? `credential expired ${relativeTime(c.expiresAt, now)}; reconnect it` : 'credential expired; reconnect it';
    case 'revoked':
      return 'disconnected';
    default:
      return c.lastOkAt ? `last used ${relativeTime(c.lastOkAt, now)}` : 'not used yet';
  }
}

// The sentence words live beside the Audit page's, so an entry reads the same on both.
export { actionWords } from './audit-activity';

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
    const who = actorOf(e.actor);
    return {
      id: e.id,
      initials: who.initials,
      who: who.name,
      actor: e.actor,
      text: entrySentence(e, appName),
      time: activityTime(e.at, now),
      href: entryHref(e),
    };
  });
}

/** "updated 15:58" — when the reads landed. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
