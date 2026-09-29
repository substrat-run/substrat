/**
 * What the ⌘K overlay offers for a query (#1921) — pure, so the ranking is tested without a
 * browser. The overlay renders these and runs their `go`; nothing here navigates.
 *
 * Four kinds of place, grouped as the design groups them: apps, their process maps (one
 * per declared lifecycle), the dashboard's pages, and a few actions. A pasted id is its own
 * group: a 26-character id is either a call (a request) or a record, and the overlay offers
 * both in the app the reader is in — it cannot know which, and guessing wrong is a dead end.
 */

export type PaletteGo =
  | { kind: 'path'; path: string }
  | { kind: 'request'; scopeId: string; invocationId: string; atMs: number }
  | { kind: 'record'; scopeId: string; entityType: string; entityId: string }
  | { kind: 'action'; label: string };

export type PaletteGroup = 'Open by id' | 'Apps' | 'Process maps' | 'Pages' | 'Actions';

export interface PaletteItem {
  key: string;
  group: PaletteGroup;
  label: string;
  /** The second, quieter part of the row: an app's host, a map's app. */
  detail: string | null;
  /** The app the item belongs to, when it belongs to one — it ranks the reader's app first. */
  scopeId: string | null;
  go: PaletteGo;
}

export interface PaletteApp {
  scopeId: string;
  name: string;
  host: string | null;
  status: string;
}

export interface PaletteContext {
  apps: PaletteApp[];
  /** The app the page is about, if any: its results come first, and pasted ids open in it. */
  currentApp: string | null;
  /** Each app's declared lifecycles and entities, as far as they have been read. */
  models: Record<string, { lifecycles: string[]; entities: string[] }>;
}

/** Crockford base32 — the alphabet a ULID is written in. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The instant a ULID was minted at: its first ten characters are the millisecond timestamp.
 * A call id is a ULID minted as the call starts, so a pasted request id says when to look
 * for its log lines — the one thing the request panel needs besides the id.
 */
export function ulidTime(id: string): number | null {
  if (!ULID.test(id)) return null;
  let t = 0;
  for (const c of id.slice(0, 10)) t = t * 32 + CROCKFORD.indexOf(c);
  return Number.isSafeInteger(t) && !Number.isNaN(new Date(t).getTime()) ? t : null;
}

const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The dashboard's own pages, for a reader who navigates by keyboard. */
const PAGES: { label: string; path: string }[] = [
  { label: 'Overview', path: '/overview' },
  { label: 'Apps', path: '/apps' },
  { label: 'Observability › Pulse', path: '/observability' },
  { label: 'Observability › Processes', path: '/observability?view=map' },
  { label: 'Observability › Logs', path: '/observability?view=logs' },
  { label: 'Audit', path: '/audit' },
  { label: 'Domains', path: '/domains' },
  { label: 'Integrations', path: '/integrations' },
  { label: 'Team', path: '/team' },
  { label: 'Billing', path: '/billing' },
  { label: 'Settings', path: '/settings' },
];
const APP_PAGES = [
  { label: 'Overview', tab: 'overview' },
  { label: 'Deployments', tab: 'deployments' },
  { label: 'Data', tab: 'data' },
  { label: 'Settings', tab: 'settings' },
];
export const PALETTE_ACTIONS = ['Create app', 'Invite member', 'Add domain'];

const GROUP_ORDER: PaletteGroup[] = ['Open by id', 'Apps', 'Process maps', 'Pages', 'Actions'];

export function paletteItems(query: string, ctx: PaletteContext): PaletteItem[] {
  const q = query.trim();
  const needle = q.toLowerCase();
  const current = ctx.apps.find((a) => a.scopeId === ctx.currentApp) ?? null;
  const items: PaletteItem[] = [];

  // A pasted id: the call and the record readings, in the reader's app.
  const id = q.toUpperCase();
  if (current && ULID.test(id)) {
    const at = ulidTime(id);
    if (at !== null) {
      items.push({
        key: `req:${id}`,
        group: 'Open by id',
        label: `Request ${id}`,
        detail: `in ${current.name}`,
        scopeId: current.scopeId,
        go: { kind: 'request', scopeId: current.scopeId, invocationId: id, atMs: at },
      });
    }
    const model = ctx.models[current.scopeId];
    // Entities with a lifecycle first: those are the records a timeline has most to say about.
    const entities = [...new Set([...(model?.lifecycles ?? []), ...(model?.entities ?? [])])];
    for (const entityType of entities) {
      items.push({
        key: `rec:${entityType}:${id}`,
        group: 'Open by id',
        label: `${humanize(entityType)} ${id}`,
        detail: `record in ${current.name}`,
        scopeId: current.scopeId,
        go: { kind: 'record', scopeId: current.scopeId, entityType, entityId: id },
      });
    }
  }
  // Record ids are the app's own, not always ULIDs: `entity:id` names one directly.
  const named = /^([A-Za-z][A-Za-z0-9_-]*):(.+)$/.exec(q);
  if (current && named && (ctx.models[current.scopeId]?.entities ?? []).includes(named[1]!)) {
    items.push({
      key: `rec:${named[1]}:${named[2]}`,
      group: 'Open by id',
      label: `${humanize(named[1]!)} ${named[2]}`,
      detail: `record in ${current.name}`,
      scopeId: current.scopeId,
      go: { kind: 'record', scopeId: current.scopeId, entityType: named[1]!, entityId: named[2]! },
    });
  }

  const matches = (...texts: (string | null)[]) => needle === '' || texts.some((t) => t !== null && t.toLowerCase().includes(needle));

  for (const a of ctx.apps) {
    if (matches(a.name, a.host)) {
      items.push({ key: `app:${a.scopeId}`, group: 'Apps', label: a.name, detail: a.host, scopeId: a.scopeId, go: { kind: 'path', path: `/apps/${a.scopeId}/overview` } });
    }
    for (const entity of ctx.models[a.scopeId]?.lifecycles ?? []) {
      const label = humanize(entity);
      if (matches(label, a.name, 'process map')) {
        items.push({
          key: `map:${a.scopeId}:${entity}`,
          group: 'Process maps',
          label,
          detail: a.name,
          scopeId: a.scopeId,
          go: { kind: 'path', path: `/observability?app=${encodeURIComponent(a.scopeId)}&view=map&entity=${encodeURIComponent(entity)}` },
        });
      }
    }
  }
  if (current) {
    for (const p of APP_PAGES) {
      if (matches(p.label, current.name)) {
        items.push({ key: `apppage:${p.tab}`, group: 'Pages', label: `${current.name} › ${p.label}`, detail: null, scopeId: current.scopeId, go: { kind: 'path', path: `/apps/${current.scopeId}/${p.tab}` } });
      }
    }
  }
  for (const p of PAGES) {
    if (matches(p.label)) items.push({ key: `page:${p.path}`, group: 'Pages', label: p.label, detail: null, scopeId: null, go: { kind: 'path', path: p.path } });
  }
  for (const label of PALETTE_ACTIONS) {
    if (matches(label)) items.push({ key: `action:${label}`, group: 'Actions', label, detail: null, scopeId: null, go: { kind: 'action', label } });
  }

  // Grouped in the design's order; within a group, the reader's app first, then as listed.
  const rank = (i: PaletteItem) => (ctx.currentApp && i.scopeId === ctx.currentApp ? 0 : 1);
  return items
    .map((item, n) => ({ item, n }))
    .sort((a, b) => GROUP_ORDER.indexOf(a.item.group) - GROUP_ORDER.indexOf(b.item.group) || rank(a.item) - rank(b.item) || a.n - b.n)
    .map((x) => x.item);
}
