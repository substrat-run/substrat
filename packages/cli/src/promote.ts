/**
 * `substrat promote <slug> --version <id>` — a builder points its ONE channel (`prod`,
 * the serving pointer) at a version. Prod is self-serve while the vertical is PRIVATE
 * (builder-plane.md §4-revised; a listed vertical's prod is a staff decision again — the
 * control plane refuses it). `dev`/`staging` were retired (#509): a non-prod environment
 * is a scope with data — a preview (`substrat preview create`) — not a second pointer.
 * The slug is BARE — the control plane forms `<tenantSlug>/<slug>` from the caller's tenant
 * (§5), so a builder never types their own prefix. Only admitted versions promote; a changed
 * digest is refused without acknowledgement (the two checkpoints), surfaced as a 4xx here —
 * re-run with `--ack-permissions` / `--ack-migrations` after reading the two diffs it prints.
 *
 * #1705 PR 3: a promote that drops or re-versions an exported event an installed app imports
 * is refused too (409), and the refusal lists the apps it would break: the caller's own tenant's
 * by name, any other tenant only as a count. `--ack-export-break` passes it once that is read.
 */
import type { ExportBreak, MigrationDiff, MigrationEntry, PermissionRegistry } from '@substrat-run/contracts';
import { warnIfStale } from './version.js';
import { parseJsonBody, readAllEntries } from './http.js';
import { failureMessage, getJson } from './problem.js';

export interface PromoteOptions {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
  channel: string;
  versionId: string;
  acknowledge?: { permissionChange?: boolean; migrationChange?: boolean; exportBreak?: boolean };
}

/** The installed apps a promote breaks (#1705 PR 3), as the control plane lists them to this caller. */
export interface ExportBreaks {
  affected: ExportBreak[];
  otherTenants?: number;
}

/** The listing a refused (or acknowledged) export break carries, one line per affected app. */
export function exportBreakLines(b: ExportBreaks): string[] {
  const lines = b.affected.map(
    (r) =>
      `  ${r.vertical} (scope ${r.scopeId}) imports ${r.type} v${r.schemaVersion} — ` +
      (r.incoming === null ? 'this version no longer exports it' : `this version exports v${r.incoming}`),
  );
  if (b.otherTenants) lines.push(`  …and apps in ${b.otherTenants} other tenant(s)`);
  return lines;
}

/**
 * One store the promote minted for an already-installed tenant (#825) — a store declared
 * by THIS version that the tenant, having been created before the declaration existed,
 * did not have. Reported so adopting a new store is something the builder watches happen
 * rather than an ops step someone has to remember.
 */
export interface MintedStore {
  tenantId: string;
  binding: string;
  kind: 'relational' | 'blob';
}

export interface PromoteResult {
  channel: string;
  versionId: string;
  /** Present only when this promote minted stores, or tried and could not. `minted` names
   *  only tenants the caller may see (a builder reads its own tenant's directory rows and no
   *  one else's); `otherTenants` counts the rest of the fleet the sweep also covered. */
  storeBackfill?: { minted: MintedStore[]; otherTenants?: number; error?: string };
  /** Present when an acknowledged export break reached installed apps (#1705 PR 3). */
  exportBreaks?: ExportBreaks;
}

export async function promote(opts: PromoteOptions): Promise<PromoteResult> {
  const base = opts.controlPlaneUrl.replace(/\/$/, '');
  const url = `${base}/verticals/${encodeURIComponent(opts.slug)}/channels/${encodeURIComponent(opts.channel)}/promote`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...opts.header, 'content-type': 'application/json' },
    body: JSON.stringify({
      versionId: opts.versionId,
      ...(opts.acknowledge ? { acknowledge: opts.acknowledge } : {}),
    }),
  });
  warnIfStale(res.headers);
  const body = await res.text();
  // A refused promote is exactly where the problem document earns its keep: the two
  // checkpoints answer 4xx with the digests that need acknowledging (#971) — and, since
  // #1677, with the two diffs those digests stand for, so `--ack-*` is an informed answer.
  // An export-break refusal (#1705 PR 3) carries its own listing of the apps it breaks.
  if (!res.ok) {
    let parsed: { exportBreaks?: ExportBreaks | null; exportBreaksUnavailable?: string } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      // Not JSON: the failure message below carries the body as it is.
    }
    const listing = parsed.exportBreaks
      ? `\n${exportBreakLines(parsed.exportBreaks).join('\n')}\n(re-run with --ack-export-break once read)`
      : parsed.exportBreaksUnavailable
        ? `\n  (${parsed.exportBreaksUnavailable}; re-run with --ack-export-break to promote anyway)`
        : '';
    const message = failureMessage('promote failed', res.status, body);
    if (!message.includes(NEEDS_ACK)) throw new Error(message + listing);
    const lines = await explainRefusal(opts, message.includes('changes migrations'));
    throw new Error(`${message}${listing}\n\n${lines.join('\n')}`);
  }
  return parseJsonBody<PromoteResult>(body, url);
}

/** What both digest refusals say (`… — acknowledge it explicitly to promote`). Case matters:
 *  the export-break refusal says "Acknowledge it explicitly (exportBreak)", and it is answered
 *  by its own listing, not by the digest diffs. */
const NEEDS_ACK = 'acknowledge it explicitly';

/**
 * The permission and migration diffs a refused promote stands for (#1677), as printable
 * lines: the version `prod` serves against the one being promoted, read over the same owner
 * routes the dashboard's dialog reads. Never throws — the refusal is the answer, and a diff
 * that could not be read is said so in a line rather than put in its place.
 */
export async function explainRefusal(opts: PromoteOptions, migrationRefused: boolean): Promise<string[]> {
  const base = `${opts.controlPlaneUrl.replace(/\/$/, '')}/verticals/${encodeURIComponent(opts.slug)}`;
  const get = <T>(url: string): Promise<T> => getJson<T>(url, opts.header);
  try {
    const channels = await readAllEntries(`${base}/channels`, (u) =>
      get<{ entries: { channel: string; versionId: string }[]; nextCursor: string | null }>(u),
    );
    // The channel's `versionId`, as the gate compares — not `servingVersionId`, which only
    // differs after a failed in-place serve (#1661 follows that one for reconcile).
    const serving = channels.find((c) => c.channel === opts.channel)?.versionId;
    if (!serving) return ['(nothing serves this channel yet, so there is nothing to diff against)'];
    const registry = (id: string) =>
      get<{ registry: PermissionRegistry | null }>(`${base}/versions/${encodeURIComponent(id)}/registry`).then((r) => r.registry);
    const [from, to, migrations] = await Promise.all([
      registry(serving),
      registry(opts.versionId),
      get<{ migrations: MigrationDiff | null }>(
        `${base}/versions/${encodeURIComponent(opts.versionId)}/migrations?base=${encodeURIComponent(serving)}`,
      ).then((r) => r.migrations),
    ]);
    return [
      `${opts.channel} serves ${serving}; promoting ${opts.versionId}.`,
      '',
      'permission changes:',
      ...formatRegistryDiff(from, to).map((l) => `  ${l}`),
      '',
      'migration changes:',
      ...formatMigrationDiff(migrations, migrationRefused).map((l) => `  ${l}`),
      '',
      'note: the registry does not yet require --ack-migrations for a change to SQL migrations alone (#1754).',
    ];
  } catch (e) {
    return [`(the diffs could not be read: ${e instanceof Error ? e.message : String(e)})`];
  }
}

/** A permission-registry diff, one line per change. `null` on a side is a version that kept none. */
export function formatRegistryDiff(from: PermissionRegistry | null, to: PermissionRegistry | null): string[] {
  if (!from || !to) {
    return [`cannot compare: ${!from ? 'the serving' : 'the incoming'} version carries no permission registry`];
  }
  const lines: string[] = [];
  const before = new Map(from.permissions.map((p) => [p.key, p.description]));
  const after = new Map(to.permissions.map((p) => [p.key, p.description]));
  for (const [key, description] of after) {
    const old = before.get(key);
    if (old === undefined) lines.push(`+ ${key}  ${description}`);
    else if (old !== description) lines.push(`~ ${key}  “${old}” → “${description}”`);
  }
  for (const [key, description] of before) if (!after.has(key)) lines.push(`- ${key}  ${description}`);
  const shapes = (label: string, a: Map<string, string[]>, b: Map<string, string[]>) => {
    for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const was = new Set(a.get(name) ?? []);
      const now = new Set(b.get(name) ?? []);
      const added = [...now].filter((k) => !was.has(k));
      const removed = [...was].filter((k) => !now.has(k));
      if (added.length === 0 && removed.length === 0 && a.has(name) === b.has(name)) continue;
      const state = !a.has(name) ? ' (new)' : !b.has(name) ? ' (removed)' : '';
      lines.push(`${label} ${name}${state}: ${[...added.map((k) => `+${k}`), ...removed.map((k) => `-${k}`)].join(' ')}`.trimEnd());
    }
  };
  shapes('role', new Map(from.roles.map((r) => [r.key, r.permissions])), new Map(to.roles.map((r) => [r.key, r.permissions])));
  shapes(
    'grant shape',
    new Map((from.entityGrants ?? []).map((g) => [g.entityType, g.permissions])),
    new Map((to.entityGrants ?? []).map((g) => [g.entityType, g.permissions])),
  );
  return lines.length > 0 ? lines : ['none'];
}

/**
 * The migrations a promote adds, each with its SQL. `null` is a version whose manifest carries
 * none. `digestMoved` is whether the gate refused on the migration digest.
 */
export function formatMigrationDiff(diff: MigrationDiff | null, digestMoved: boolean): string[] {
  if (!diff) {
    return [
      `SQL not available for this version${digestMoved ? ' — the migration digest changed' : ''}: it was pushed by a CLI ` +
        'older than migrations in the manifest, or its migrations were over the size a manifest carries. Read them in the repository.',
    ];
  }
  const entry = (mark: string, m: MigrationEntry) => [
    `${mark} ${m.moduleId} ${m.version}`,
    ...(m.sql === null ? ['    (SQL left out: past the size bound of this answer)'] : m.sql.split('\n').map((l) => `    ${l}`)),
  ];
  const lines = [
    ...(diff.baseline === 'unavailable'
      ? ['(the serving version predates carried migrations, so every migration this version ships is listed)']
      : []),
    ...diff.changed.flatMap((m) => entry('~ (edited after shipping; a scope that already ran it will not run it again)', m)),
    ...diff.added.flatMap((m) => entry('+', m)),
  ];
  if (diff.total === 0) {
    // Not "none": the gate checks permissions first, so a permission refusal says nothing
    // about whether the migration digest moved too.
    lines.push(`no SQL migration added or edited${digestMoved ? ' — the Durable-Object classes moved the digest' : ''}`);
  }
  if (diff.truncated) lines.push(`(${diff.added.length + diff.changed.length} of ${diff.total} shown; read the rest in the repository)`);
  return lines;
}
