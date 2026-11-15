/**
 * `substrat promote <slug> --review-only` — what a promote to prod would change, read BEFORE
 * promoting, and never promoting. The dashboard's promote dialog reads the same four routes
 * (`apps/dashboard/src/promotion-review.ts`) and asks with the same rules
 * (`apps/dashboard/web/src/lib/promote-review.ts`); this is that review for a terminal, and as
 * JSON for a tool (the plugin's approvals pane) that shows it to the person who acknowledges.
 *
 * Until now the CLI showed the diffs only after a refused promote, so a promote run elsewhere —
 * a vertical's CI deploy on merge — left nothing for a person to read locally. This reads the
 * review whoever promoted, including when nothing has.
 *
 * The rules, as the dialog's: a first promotion asks nothing; a registry missing on either side
 * is "cannot diff", which asks; a manifest with no SQL is "not available", which asks; promoting
 * what already serves asks nothing. The registry's gate stays the authority, and the `--review`
 * token printed binds an acknowledgement to exactly these diffs (#2333).
 */
import { diffRegistries, hasRegistryChange, type MigrationDiff, type PermissionRegistry } from '@substrat-run/contracts';
import type { ExportBreaks, PromoteReviewBinding } from '@substrat-run/control-plane-client';
import { exportBreakLines, formatMigrationDiff, formatRegistryDiff, idOf, reviewToken } from './promote.js';
import { planeFor, viaPlane, walkAll } from './plane.js';
import { readRefused } from './problem.js';

/** The acknowledgements a promote can need, as the flags that give them. */
export type AckFlag = '--ack-permissions' | '--ack-migrations' | '--ack-export-break';

export interface PromoteReview {
  slug: string;
  channel: string;
  /** What the channel serves now, or null for a first promotion. */
  serving: { versionId: string; version: string | null } | null;
  incoming: { versionId: string; version: string | null };
  servingRegistry: PermissionRegistry | null;
  incomingRegistry: PermissionRegistry | null;
  /** Null: nothing to compare, or the incoming manifest carries no SQL (see `needs`). */
  migrations: MigrationDiff | null;
  exportBreaks: ExportBreaks | null;
  /** The `--review` token the acknowledgements answer, or null when the plane hands none out. */
  review: string | null;
  /** The flags a promote of `incoming` needs, in the order the CLI takes them. Empty: it promotes as is. */
  needs: AckFlag[];
  /** The exact command a person runs to promote after reading this. */
  command: string;
}

/** The versions a review may be read for: the newest admitted one, when none is named. */
interface VersionLike {
  id: string;
  version: string;
  admission: string;
}

/** The newest admitted version (ULIDs sort by time), or undefined when none is admitted. */
export function newestAdmitted(versions: readonly VersionLike[]): VersionLike | undefined {
  return [...versions].filter((v) => v.admission === 'admitted').sort((a, b) => (a.id < b.id ? 1 : -1))[0];
}

/** Which acknowledgements the review asks for — the dialog's `planPermission`/`planMigration`/`planExportBreak`. */
export function needsOf(r: Pick<PromoteReview, 'serving' | 'incoming' | 'servingRegistry' | 'incomingRegistry' | 'migrations' | 'exportBreaks'>): AckFlag[] {
  if (r.serving === null || r.serving.versionId === r.incoming.versionId) return [];
  const needs: AckFlag[] = [];
  const from = r.servingRegistry;
  const to = r.incomingRegistry;
  if (from === null || to === null || hasRegistryChange(diffRegistries(from, to))) needs.push('--ack-permissions');
  if (r.migrations === null || r.migrations.total > 0) needs.push('--ack-migrations');
  const b = r.exportBreaks;
  if (b && (b.affected.length > 0 || (b.otherTenants ?? 0) > 0)) needs.push('--ack-export-break');
  return needs;
}

export async function readPromoteReview(opts: {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
  channel: string;
  /** The version to review; the newest admitted one when absent. */
  versionId?: string;
}): Promise<PromoteReview> {
  const client = planeFor(opts.controlPlaneUrl, opts.header);
  // Every read must throw when it did not happen: a failure folded into null reads as "declares
  // no registry", which asks for an acknowledgement of a change nobody was shown.
  const get = <T>(read: () => Promise<T>): Promise<T> => viaPlane(read, readRefused);
  const [versions, channels] = await Promise.all([
    get(() => walkAll((page) => client.listVersions(opts.slug, page))),
    get(() => walkAll((page) => client.listChannels(opts.slug, page))),
  ]);
  const incoming = opts.versionId ? versions.find((v) => v.id === opts.versionId) : newestAdmitted(versions);
  if (!incoming) {
    throw new Error(
      opts.versionId
        ? `no version ${opts.versionId} of ${opts.slug} — \`substrat versions ${opts.slug}\` lists them`
        : `${opts.slug} has no admitted version to promote — \`substrat versions ${opts.slug}\` lists them`,
    );
  }
  const labelOf = (id: string) => versions.find((v) => v.id === id)?.version ?? null;
  // The channel's `versionId`, as the gate compares — not `servingVersionId` (see `explainRefusal`).
  const servingId = channels.find((c) => c.channel === opts.channel)?.versionId ?? null;
  const base = {
    slug: opts.slug,
    channel: opts.channel,
    incoming: { versionId: incoming.id, version: incoming.version },
  };
  if (servingId === null) {
    const first = { ...base, serving: null, servingRegistry: null, incomingRegistry: null, migrations: null, exportBreaks: null, review: null };
    return { ...first, needs: [], command: commandFor(first, []) };
  }
  const same = servingId === incoming.id;
  const registry = (id: string) => get(() => client.getVersionRegistry<PermissionRegistry>(opts.slug, id)).then((r) => r.registry);
  const [servingRegistry, incomingRegistry, read, exportBreaks] = await Promise.all([
    registry(servingId),
    same ? undefined : registry(incoming.id),
    same ? undefined : get(() => client.getVersionMigrations<MigrationDiff>(opts.slug, incoming.id, servingId)),
    same ? undefined : get(() => client.promotionImpact(opts.slug, opts.channel, incoming.id)),
  ]);
  const review: PromoteReviewBinding | undefined = read?.review;
  const partial = {
    ...base,
    serving: { versionId: servingId, version: labelOf(servingId) },
    servingRegistry,
    incomingRegistry: incomingRegistry === undefined ? servingRegistry : incomingRegistry,
    migrations: read?.migrations ?? null,
    exportBreaks: exportBreaks && (exportBreaks.affected.length > 0 || (exportBreaks.otherTenants ?? 0) > 0) ? exportBreaks : null,
    review: review ? reviewToken(review) : null,
  };
  const needs = needsOf(partial);
  return { ...partial, needs, command: commandFor(partial, needs) };
}

/** The promote a person runs once they have read the review: its flags and, with any, its token. */
function commandFor(r: { slug: string; incoming: { versionId: string }; review: string | null }, needs: readonly AckFlag[]): string {
  const token = needs.length > 0 && r.review !== null ? ` --review ${r.review}` : '';
  return `substrat promote ${r.slug} --version ${r.incoming.versionId}${needs.map((f) => ` ${f}`).join('')}${token}`;
}

/** The review as a terminal prints it — the same sections a refused promote prints. */
export function formatPromoteReview(r: PromoteReview): string[] {
  const label = (v: { versionId: string; version: string | null }) => `${idOf(v.versionId)}${v.version ? ` (${v.version})` : ''}`;
  if (r.serving === null) {
    return [`${r.channel} serves nothing yet; promoting ${label(r.incoming)} is a first promotion and asks for no acknowledgement.`, '', r.command];
  }
  if (r.serving.versionId === r.incoming.versionId) {
    return [`${r.channel} already serves ${label(r.incoming)}; there is nothing to promote.`];
  }
  const lines = [
    `${r.channel} serves ${label(r.serving)}; promoting ${label(r.incoming)}.`,
    '',
    'permission changes:',
    ...(r.servingRegistry === null || r.incomingRegistry === null
      ? [`  cannot compare: ${r.servingRegistry === null ? 'the serving' : 'the incoming'} version carries no permission registry`]
      : formatRegistryDiff(r.servingRegistry, r.incomingRegistry, false).map((l) => `  ${l}`)),
    '',
    'migration changes:',
    ...formatMigrationDiff(r.migrations, false).map((l) => `  ${l}`),
  ];
  if (r.exportBreaks) {
    lines.push('', 'apps this promotion breaks (an export they import, dropped or re-versioned):', ...exportBreakLines(r.exportBreaks));
  }
  lines.push('');
  if (r.needs.length === 0) {
    lines.push('nothing here needs acknowledging; promote with:', `  ${r.command}`);
  } else {
    lines.push(
      `a promote needs ${r.needs.join(', ')}: the person who read the above runs`,
      `  ${r.command}`,
      ...(r.review === null ? ['(this control plane hands out no review token, so --review cannot be given)'] : []),
    );
  }
  return lines;
}
