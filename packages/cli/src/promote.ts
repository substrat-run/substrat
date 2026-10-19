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
 *
 * #2333: an acknowledgement answers ONE review — the diffs printed against the version prod served
 * when they were read. Every refusal that prints them also prints the `--review` token they were
 * read with, and the control plane refuses a token whose base or stored rows have moved since
 * (and a `--ack-migrations` sent with none), so a person never acknowledges a diff they were not shown.
 */
import {
  diffRegistries,
  grantShapeHolderNotes,
  reservationNote,
  roleHolderNote,
  promoteReviewReasonIn,
  clipReviewText,
  discardTally,
  reviewSql,
  reviewText,
  unitemisedRegistryChanges,
  type ExportBreak,
  type MigrationDiff,
  type MigrationEntry,
  type PermissionRegistry,
} from '@substrat-run/contracts';
import {
  ControlPlaneError,
  type ExportBreaks,
  type MintedStore,
  type PromoteResult,
  type PromoteReviewBinding,
} from '@substrat-run/control-plane-client';
import { planeFor, viaPlane, walkAll } from './plane.js';
import { failureMessage, readRefused } from './problem.js';

export interface PromoteOptions {
  controlPlaneUrl: string;
  header: Record<string, string>;
  slug: string;
  channel: string;
  versionId: string;
  acknowledge?: { permissionChange?: boolean; migrationChange?: boolean; exportBreak?: boolean; review?: PromoteReviewBinding };
}

/** How a review binding is written on the command line: `<base>:<digest>`, `-` for no base. */
export function reviewToken(review: PromoteReviewBinding): string {
  return `${review.base ?? '-'}:${review.digest}`;
}

/** `reviewToken` read back, or null when it is not one. The digest is hex, so the last `:` splits it. */
export function parseReviewToken(token: string): PromoteReviewBinding | null {
  const at = token.lastIndexOf(':');
  const base = token.slice(0, at);
  const digest = token.slice(at + 1);
  if (at <= 0 || !/^[0-9a-f]{64}$/.test(digest)) return null;
  return { base: base === '-' ? null : base, digest };
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

/** The listing a refusal prints, and how to answer it once it has been read. */
export function exportBreakListing(b: ExportBreaks): string {
  return `\n${exportBreakLines(b).join('\n')}\n(re-run with --ack-export-break once read)`;
}

export type { ExportBreaks, MintedStore, PromoteResult };

export async function promote(opts: PromoteOptions): Promise<PromoteResult> {
  // `advisory`: a promote is one of the three commands that nudge a stale CLI, off every
  // answer — success or refusal — before it is read.
  const client = planeFor(opts.controlPlaneUrl, opts.header, { advisory: true });
  try {
    // The refusal is passed through as it is: it needs a second round-trip to explain, which a
    // synchronous mapper cannot make.
    return await viaPlane(() => client.promoteChannel(opts.slug, opts.channel, opts.versionId, opts.acknowledge), (e) => e);
  } catch (e) {
    if (!(e instanceof ControlPlaneError)) throw e;
    const body = e.body ?? '';
    // A refused promote is exactly where the problem document earns its keep: the two
    // checkpoints answer 4xx with the digests that need acknowledging (#971) — and, since
    // #1677, with the two diffs those digests stand for, so `--ack-*` is an informed answer.
    // An export-break refusal (#1705 PR 3) carries its own listing of the apps it breaks.
    let parsed: { exportBreaks?: ExportBreaks | null; exportBreaksUnavailable?: string } = {};
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      // Not JSON: the failure message below carries the body as it is.
    }
    const listing = parsed.exportBreaks
      ? exportBreakListing(parsed.exportBreaks)
      : parsed.exportBreaksUnavailable
        ? `\n  (${parsed.exportBreaksUnavailable}; re-run with --ack-export-break to promote anyway)`
        : '';
    const message = failureMessage('promote failed', e.status, body);
    // A review that moved under the acknowledgement, or a migration acknowledgement sent with none
    // (#2333), is answered like a digest refusal: by the diffs as they stand now, and their token.
    const review = promoteReviewReasonIn(parsed);
    if (!message.includes(NEEDS_ACK) && review === undefined) throw new Error(message + listing);
    const lines = await explainRefusal(opts, {
      permission: message.includes('changes the permission surface'),
      migration: message.includes('changes migrations') || review === 'promote_review_unbound',
    });
    throw new Error(`${message}${listing}\n\n${lines.join('\n')}`);
  }
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
export async function explainRefusal(
  opts: PromoteOptions,
  refused: { permission: boolean; migration: boolean },
): Promise<string[]> {
  const client = planeFor(opts.controlPlaneUrl, opts.header);
  const get = <T>(read: () => Promise<T>): Promise<T> => viaPlane(read, readRefused);
  try {
    const channels = await walkAll((page) => client.listChannels(opts.slug, page));
    // The channel's `versionId`, as the gate compares — not `servingVersionId`, which only
    // differs after a failed in-place serve (#1661 follows that one for reconcile).
    const serving = channels.find((c) => c.channel === opts.channel)?.versionId;
    if (!serving) return ['(nothing serves this channel yet, so there is nothing to diff against)'];
    const registry = (id: string) =>
      get(() => client.getVersionRegistry<PermissionRegistry>(opts.slug, id)).then((r) => r.registry);
    const [from, to, read] = await Promise.all([
      registry(serving),
      registry(opts.versionId),
      get(() => client.getVersionMigrations<MigrationDiff>(opts.slug, opts.versionId, serving)),
    ]);
    // The token is the one the migrations read answered beside the diff printed here, never one
    // put together from separate reads: the two must describe the same review.
    const token = read.review ? reviewToken(read.review) : null;
    return [
      `${opts.channel} serves ${idOf(serving)}; promoting ${idOf(opts.versionId)}.`,
      '',
      'permission changes:',
      ...formatRegistryDiff(from, to, refused.permission).map((l) => `  ${l}`),
      '',
      'migration changes:',
      ...formatMigrationDiff(read.migrations, refused.migration).map((l) => `  ${l}`),
      '',
      token === null
        ? '(this control plane hands out no review token, so --review cannot be given)'
        : `to acknowledge exactly what is shown above, re-run with the --ack-* flags it needs and --review ${idOf(token)}`,
    ];
  } catch (e) {
    return [`(the diffs could not be read: ${e instanceof Error ? e.message : String(e)})`];
  }
}

/**
 * A permission-registry diff, one line per change — the dashboard's own `diffRegistries`
 * (contracts), rendered for a terminal. `null` on a side is a version that kept none.
 *
 * The digest hashes the whole registry and the diff itemises keys, roles and grant shapes, so
 * a field it does not itemise (exports, imports, which module declares a key) is NAMED rather
 * than dropped. `digestMoved` is whether the gate refused on the permission digest: then
 * "none" is never the answer, because the gate has just said there is a change.
 */
export function formatRegistryDiff(from: PermissionRegistry | null, to: PermissionRegistry | null, digestMoved: boolean): string[] {
  if (!from || !to) {
    return [`cannot compare: ${!from ? 'the serving' : 'the incoming'} version carries no permission registry`];
  }
  const diff = diffRegistries(from, to);
  const describe = (reg: PermissionRegistry, key: string) => reg.permissions.find((p) => p.key === key)?.description ?? '';
  const shape = (label: string, c: { added: string[]; removed: string[]; isNew: boolean; isGone: boolean }, name: string) =>
    `${label} ${name}${c.isNew ? ' (new)' : c.isGone ? ' (removed)' : ''}: ${[...c.added.map((k) => `+${k}`), ...c.removed.map((k) => `-${k}`)].join(' ')}`.trimEnd();
  const lines = [
    ...diff.addedKeys.map((k) => `+ ${k}  ${describe(to, k)}`),
    ...diff.changedKeys.map((k) => `~ ${k}  “${describe(from, k)}” → “${describe(to, k)}”`),
    ...diff.removedKeys.map((k) => `- ${k}  ${describe(from, k)}`),
    ...diff.reservationChanges.map((c) => `! ${reservationNote(c)}`),
    ...diff.roleChanges.flatMap((r) => {
      const held = roleHolderNote(r);
      return [shape('role', r, r.key), ...(held ? [`  ${held}`] : [])];
    }),
    ...diff.grantChanges.flatMap((g) => [
      shape('grant shape', g, g.entityType),
      ...grantShapeHolderNotes(g).map((n) => `  ${n}`),
    ]),
  ];
  const unitemised = unitemisedRegistryChanges(from, to, diff);
  if (unitemised.length > 0) {
    lines.push(`changed, not itemised here: ${unitemised.join(', ')} — compare the two versions' registries`);
  }
  if (lines.length > 0) return lines;
  return digestMoved
    ? ["the permission digest changed, but the two stored registries read the same here — compare them in the repository"]
    : ['none'];
}

/**
 * Pusher-supplied text on one terminal line (#2322): every control, format and bidi character
 * made visible (`reviewText`), then quoted, which escapes the newlines and tabs it keeps. So no
 * reason, table name or id prints as a terminal command, a reordered word or a forged line.
 */
const quoted = (text: string): string => JSON.stringify(reviewText(text));

/** What an id may hold to print bare in the listing's one-line header. */
const PLAIN_ID = /^[A-Za-z0-9@/._~:+-]+$/;

/**
 * A module id or migration version on the listing's header line: bare when it is a plain id, as
 * every id the push boundary admits is, and `quoted` otherwise, so nothing in it can break the line.
 */
export const idOf = (text: string): string => (PLAIN_ID.test(text) ? text : quoted(text));

/**
 * A discard's reason as the listing shows it: quoted, and cut where the review cuts it
 * (`clipReviewText`: 280 characters or 6 lines), saying where the rest is. A terminal has no
 * expander, and the listing must stay readable down to the acknowledgement.
 */
function reasonOf(why: string): string {
  const { shown, clipped } = clipReviewText(why);
  return clipped ? `${JSON.stringify(shown)}… (cut; the whole reason is in the dashboard's promote dialog and the migration's source)` : quoted(why);
}

/**
 * What one migration declares it moves and discards (#2322), one line each under its id.
 * Every target and reason is the pusher's text, so each goes through `quoted`.
 */
function declarationLines(m: MigrationEntry): string[] {
  if (m.declarationsLeftOut) return ['    (declares moves or discards, left out: past the size bound of this answer; read them in the repository)'];
  return [
    ...Object.entries(m.discards ?? {}).map(([target, why]) => `    discards ${quoted(target)}: ${reasonOf(why)}`),
    ...Object.entries(m.moves ?? {}).map(([from, to]) => `    moves ${quoted(from)} → ${quoted(to)} (verified at apply)`),
  ];
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
  // The id and the SQL are the pusher's text too. The header is one line, so the module and the
  // version print bare only when they are plain ids and are quoted otherwise (`idOf`): a newline
  // in either would forge another entry above the real one. The SQL is split into its lines after
  // `reviewSql`, so a control or bidi character in it prints as `<U+XXXX>`, not as itself.
  const entry = (mark: string, m: MigrationEntry) => [
    `${mark} ${idOf(m.moduleId)} ${idOf(m.version)}`,
    ...declarationLines(m),
    ...(m.sql === null ? ['    (SQL left out: past the size bound of this answer)'] : reviewSql(m.sql).split('\n').map((l) => `    ${l}`)),
  ];
  const discards = discardTally(diff);
  const lines = [
    ...(discards.count > 0
      ? [
          `! this promote deliberately discards data in ${discards.atLeast ? 'at least ' : ''}${discards.count} place${discards.count === 1 ? '' : 's'}; ` +
            "each reason is the migration author's own",
        ]
      : discards.atLeast
        ? ["! this list is cut, so it cannot show whether a migration left out of it discards data; read the rest in the repository"]
        : []),
    ...(diff.baseline === 'unavailable'
      ? ['(the serving version predates carried migrations, so every migration this version ships is listed)']
      : []),
    ...diff.changed.flatMap((m) =>
      entry(
        m.edited === 'declarations'
          ? '~ (declarations edited after shipping; a scope that already ran it is unaffected, one that has not is held to these)'
          : '~ (edited after shipping; a scope that already ran it will not run it again)',
        m,
      ),
    ),
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
