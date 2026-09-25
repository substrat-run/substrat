import type { EmittedModel, MigrationDiff } from '@substrat-run/contracts';
import type { ChannelHistoryEntry, DeploymentVersion, ReleaseRow } from './api';
import type { RegistryDiff, RegistryLike } from './registry-diff';

/**
 * The Deployments tab's derivations (#1767): the running → available comparison as
 * tagged rows, and the release ledger with "pushed" and "went live" kept as the two
 * separate instants they are. Pure, so the claims the tab makes — which version was
 * rolled back, how many installs sit on a version — are held by tests rather than by
 * a click-through.
 */

export type DiffKind = 'added' | 'changed' | 'removed';

/** One tagged line of the comparison: `+ added`, `~ changed` or `− removed`. */
export interface DiffItem {
  kind: DiffKind;
  name: string;
  note: string;
}

export const DIFF_TAG: Record<DiffKind, string> = { added: '+ added', changed: '~ changed', removed: '− removed' };

/**
 * The permission half, from the same registry diff the Permissions section and the
 * promote review read. A role that gains and loses keys is ONE changed row naming both,
 * never rounded to a side.
 */
export function permissionDiffItems(diff: RegistryDiff, from: RegistryLike, to: RegistryLike): DiffItem[] {
  const describe = (reg: RegistryLike, key: string) => reg.permissions.find((p) => p.key === key)?.description ?? '';
  const items: DiffItem[] = [];
  for (const k of diff.addedKeys) items.push({ kind: 'added', name: k, note: describe(to, k) || 'new permission' });
  for (const k of diff.changedKeys) items.push({ kind: 'changed', name: k, note: `description now: ${describe(to, k)}` });
  for (const k of diff.removedKeys) items.push({ kind: 'removed', name: k, note: describe(from, k) || 'no longer declared' });
  for (const r of diff.roleChanges) {
    if (r.isNew) items.push({ kind: 'added', name: `role ${r.key}`, note: r.added.length ? `holds ${r.added.join(', ')}` : 'new role' });
    else if (r.isGone) items.push({ kind: 'removed', name: `role ${r.key}`, note: 'no longer declared' });
    else items.push({ kind: 'changed', name: `role ${r.key}`, note: signed(r.added, r.removed) });
  }
  for (const g of diff.grantChanges) {
    if (g.isNew) items.push({ kind: 'added', name: `grant on ${g.entityType}`, note: g.added.join(', ') || 'new grant shape' });
    else if (g.isGone) items.push({ kind: 'removed', name: `grant on ${g.entityType}`, note: 'no longer declared' });
    else items.push({ kind: 'changed', name: `grant on ${g.entityType}`, note: signed(g.added, g.removed) });
  }
  return items;
}

function signed(added: string[], removed: string[]): string {
  return [...added.map((k) => `+${k}`), ...removed.map((k) => `−${k}`)].join(' ');
}

type JsonSchema = { type?: unknown; enum?: unknown[]; anyOf?: JsonSchema[]; format?: unknown; properties?: Record<string, JsonSchema>; required?: string[] };

/** A field's JSON Schema as the short type a reader expects: `string`, `enum(3)`, `string | null`. */
export function fieldType(schema: unknown): string {
  const s = (schema ?? {}) as JsonSchema;
  if (Array.isArray(s.anyOf)) return s.anyOf.map(fieldType).join(' | ');
  if (Array.isArray(s.enum)) return `enum(${s.enum.length})`;
  if (Array.isArray(s.type)) return s.type.join(' | ');
  if (typeof s.type === 'string') return typeof s.format === 'string' ? `${s.type} (${s.format})` : s.type;
  return 'any';
}

/**
 * The schema half from the two emitted entity models. Null when either side recorded
 * none — "cannot compare" is not "no change", and the column says which one it is.
 */
export function schemaDiffItems(from: EmittedModel | null | undefined, to: EmittedModel | null | undefined): DiffItem[] | null {
  if (!from || !to) return null;
  const items: DiffItem[] = [];
  const props = (e: { fields: Record<string, unknown> } | undefined) => ((e?.fields as JsonSchema | undefined)?.properties ?? {}) as Record<string, JsonSchema>;
  const req = (e: { fields: Record<string, unknown> } | undefined) => new Set(((e?.fields as JsonSchema | undefined)?.required ?? []) as string[]);
  const names = [...new Set([...Object.keys(from.entities), ...Object.keys(to.entities)])].sort();
  for (const name of names) {
    const a = from.entities[name];
    const b = to.entities[name];
    if (!a && b) {
      items.push({ kind: 'added', name, note: `new entity · ${Object.keys(props(b)).length} fields` });
      continue;
    }
    if (a && !b) {
      items.push({ kind: 'removed', name, note: 'entity no longer declared' });
      continue;
    }
    const pa = props(a);
    const pb = props(b);
    const ra = req(a);
    const rb = req(b);
    for (const f of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()) {
      const before = pa[f];
      const after = pb[f];
      const optional = (r: Set<string>) => (r.has(f) ? '' : ', optional');
      if (!before && after) items.push({ kind: 'added', name: `${name}.${f}`, note: `${fieldType(after)}${optional(rb)}` });
      else if (before && !after) items.push({ kind: 'removed', name: `${name}.${f}`, note: `was ${fieldType(before)}` });
      else if (JSON.stringify(before) !== JSON.stringify(after) || ra.has(f) !== rb.has(f)) {
        const ta = `${fieldType(before)}${optional(ra)}`;
        const tb = `${fieldType(after)}${optional(rb)}`;
        items.push({ kind: 'changed', name: `${name}.${f}`, note: ta === tb ? 'constraints changed' : `${ta} → ${tb}` });
      }
    }
  }
  return items;
}

/** What a promote would run on top of the serving version's migrations — the promote review's diff. */
export function migrationDiffItems(m: MigrationDiff): DiffItem[] {
  return [
    ...m.added.map((e): DiffItem => ({ kind: 'added', name: `migration ${e.version}`, note: `${e.moduleId} · runs on update` })),
    // An edited shipped migration does NOT re-run on a scope that journaled it — which
    // is exactly why it is its own row and not folded into "added".
    ...m.changed.map((e): DiffItem => ({ kind: 'changed', name: `migration ${e.version}`, note: `${e.moduleId} · edited after it shipped; will not re-run where applied` })),
  ];
}

/** One row of the Releases list. Every nullable is "not known", never zero. */
export interface LedgerRow {
  versionId: string;
  version: string;
  pushedAt: string | null;
  /** The latest instant prod started serving this version; null = never promoted (or not visible). */
  wentLiveAt: string | null;
  /** Push → go-live, for the `+14 min` the design prints beside the go-live. */
  liveAfterMs: number | null;
  /** Set when the version's latest go-live ended with prod moving back to an OLDER version. */
  rolledBackAfterMs: number | null;
  /** The latest go-live WAS a rollback — prod moved back onto this version from a newer one. */
  restored: boolean;
  isProd: boolean;
  /** Who moved the prod pointer for that latest go-live, as the registry recorded them. */
  actor: string | null;
  /** Installs on this version out of every live install; null when the read is not ours to make. */
  installs: { on: number; total: number } | null;
}

/**
 * The ledger for a vertical this team publishes: the releases read, joined to the prod
 * channel's move history for the two things the releases read does not carry — who moved
 * the pointer, and whether a go-live ended in a rollback.
 *
 * A rollback is a prod move to a version pushed BEFORE the one it replaced. Version ids
 * are ULIDs, so push order is id order. Only a version's LATEST go-live is judged: a
 * version rolled back once and promoted again reads as live, which is what it is.
 * `history` null (the read failed) leaves actor and rollback unknown, not "none".
 */
export function ledgerRows(view: { releases: ReleaseRow[]; scopesTrackingProd: number }, history: ChannelHistoryEntry[] | null): LedgerRow[] {
  const total = view.releases.reduce((n, r) => n + r.scopesPinned, 0) + view.scopesTrackingProd;
  // History arrives newest first; walk it oldest first so "what replaced it" is the next entry.
  const moves = history ? [...history].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) : [];
  const latest = new Map<string, { entry: ChannelHistoryEntry; next: ChannelHistoryEntry | undefined }>();
  moves.forEach((entry, i) => latest.set(entry.versionId, { entry, next: moves[i + 1] }));
  return view.releases.map((r) => {
    const live = latest.get(r.versionId);
    const rolledBack = !!live?.next && live.next.versionId < r.versionId;
    return {
      versionId: r.versionId,
      version: r.version,
      pushedAt: r.pushedAt,
      wentLiveAt: r.wentLiveAt,
      liveAfterMs: r.wentLiveAt ? Math.max(0, Date.parse(r.wentLiveAt) - Date.parse(r.pushedAt)) : null,
      rolledBackAfterMs: rolledBack && live!.next ? Math.max(0, Date.parse(live!.next.at) - Date.parse(live!.entry.at)) : null,
      restored: !!live?.entry.fromVersionId && live.entry.fromVersionId > r.versionId,
      isProd: r.isProd,
      actor: live?.entry.actor ?? null,
      installs: { on: r.scopesPinned + (r.isProd ? view.scopesTrackingProd : 0), total },
    };
  });
}

/**
 * The ledger for an app installed from another team's vertical: the registry's version
 * list is all this team can read. Push instants are real; go-live instants, actors and
 * install counts live behind the publisher's reads, so they stay unknown.
 */
export function registryLedgerRows(versions: DeploymentVersion[], prodVersionId: string | null): LedgerRow[] {
  return versions.map((v) => ({
    versionId: v.id,
    version: v.version,
    pushedAt: v.createdAt || null,
    wentLiveAt: null,
    liveAfterMs: null,
    rolledBackAfterMs: null,
    restored: false,
    isProd: v.id === prodVersionId,
    actor: null,
    installs: null,
  }));
}

/** `6 min`, `2 h`, `3 d` — a span as the design writes it beside an instant. */
export function span(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/**
 * An instant as the design prints it: `Tue 15:30` inside the last week, `15 Sep 11:14`
 * before that — the design's older form also names the weekday, which a date already
 * pins down and the went-live column has no width for. English names, 24-hour clock,
 * the viewer's time zone.
 */
export function instant(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const day = d.toLocaleDateString('en-GB', { weekday: 'short' });
  if (now - t < 6 * 86_400_000 && now >= t) return `${day} ${time}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * Where the Deployments tab puts its Update action — the one action on the tab, so the
 * decision is a function a test holds. The comparison card's header, when it can name
 * prod's version; the Running bar when prod's version is beyond the loaded page of
 * versions, so the action never disappears with the comparison; nowhere when the app
 * already runs prod.
 */
export function updatePlacement(updateAvailable: boolean, prodVersionLoaded: boolean): 'card' | 'bar' | null {
  if (!updateAvailable) return null;
  return prodVersionLoaded ? 'card' : 'bar';
}
