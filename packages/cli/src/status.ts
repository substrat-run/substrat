/**
 * `substrat status [slug]` — one vertical as the dashboard's Deployments tab shows it: what prod
 * serves, the newest versions and how their admission went, the promote waiting for a person (and
 * which acknowledgements it needs), the live previews, and the recent failures. Read-only.
 *
 * `--json` is the same answer as data, for a tool that shows it to a person — the plugin's
 * approvals pane reads it when it opens, so a promote refused in a CI deploy is waiting there
 * even though no promote ran in the session.
 */
import type { OpsFailureEntry } from '@substrat-run/contracts';
import { planeFor, viaPlane, walkAll } from './plane.js';
import { listPreviews, type PreviewRow } from './preview.js';
import { readRefused } from './problem.js';
import { newestAdmitted, readPromoteReview, type AckFlag } from './promote-review.js';

/** How many versions and failures the answer carries: the newest, which is what status means. */
const RECENT = 5;

export interface VerticalStatus {
  slug: string;
  prod: {
    versionId: string;
    version: string | null;
    /** What the scopes run; differs from `versionId` when an in-place serve failed (#321). */
    servingVersionId: string | null;
  } | null;
  /** The newest versions, newest first. */
  versions: { id: string; version: string; admission: string }[];
  /** The newest admitted version, when it is newer than what prod points at. */
  waiting: { versionId: string; version: string; needs: AckFlag[]; command: string } | null;
  previews: Pick<PreviewRow, 'tag' | 'url' | 'versionId' | 'expiresAt'>[];
  failures: Pick<OpsFailureEntry, 'at' | 'operation' | 'stage' | 'status' | 'message' | 'reference' | 'version'>[];
}

export async function readStatus(opts: { controlPlaneUrl: string; header: Record<string, string>; slug: string }): Promise<VerticalStatus> {
  const client = planeFor(opts.controlPlaneUrl, opts.header);
  const get = <T>(read: () => Promise<T>): Promise<T> => viaPlane(read, readRefused);
  // The failure record keeps the registry id (`<workspace>/<slug>`) and matches it exactly, while
  // the registry routes take the bare slug a builder types; the visible list names the full one.
  const failuresOf = async () => {
    const registered = await get(() => walkAll((page) => client.listVerticals(page)));
    const id = registered.map((v) => v.slug).find((s) => s === opts.slug || s.endsWith(`/${opts.slug}`)) ?? opts.slug;
    return get(() => client.listOpsFailures(id, { limit: RECENT }));
  };
  const [versions, channels, previews, failures] = await Promise.all([
    get(() => walkAll((page) => client.listVersions(opts.slug, page))),
    get(() => walkAll((page) => client.listChannels(opts.slug, page))),
    listPreviews(opts),
    failuresOf(),
  ]);
  const newestFirst = [...versions].sort((a, b) => (a.id < b.id ? 1 : -1));
  const prodRow = channels.find((c) => c.channel === 'prod');
  const prod = prodRow
    ? {
        versionId: prodRow.versionId,
        version: versions.find((v) => v.id === prodRow.versionId)?.version ?? null,
        servingVersionId: prodRow.servingVersionId ?? null,
      }
    : null;
  const candidate = newestAdmitted(versions);
  let waiting: VerticalStatus['waiting'] = null;
  if (candidate && (prod === null || candidate.id > prod.versionId)) {
    const review = await readPromoteReview({ ...opts, channel: 'prod', versionId: candidate.id });
    waiting = { versionId: candidate.id, version: candidate.version, needs: review.needs, command: review.command };
  }
  return {
    slug: opts.slug,
    prod,
    versions: newestFirst.slice(0, RECENT).map(({ id, version, admission }) => ({ id, version, admission })),
    waiting,
    previews: previews.map(({ tag, url, versionId, expiresAt }) => ({ tag, url, versionId, expiresAt })),
    failures: failures.entries.map(({ at, operation, stage, status, message, reference, version }) => ({
      at,
      operation,
      stage,
      status,
      message,
      reference,
      version,
    })),
  };
}

export function formatStatus(s: VerticalStatus): string[] {
  const label = (id: string) => s.versions.find((v) => v.id === id)?.version ?? id;
  const lines: string[] = [];
  if (s.prod === null) {
    lines.push('prod: nothing promoted yet');
  } else {
    lines.push(`prod: ${s.prod.version ?? s.prod.versionId} (${s.prod.versionId})`);
    if (s.prod.servingVersionId !== null && s.prod.servingVersionId !== s.prod.versionId) {
      lines.push(`  ⚠ promoted but NOT serving: scopes still run ${label(s.prod.servingVersionId)} — promote again to retry the serve`);
    }
  }
  lines.push('');
  if (s.waiting === null) {
    lines.push('waiting: nothing — prod serves the newest admitted version');
  } else {
    lines.push(
      `waiting: ${s.waiting.version} (${s.waiting.versionId}) is admitted and not promoted`,
      s.waiting.needs.length === 0
        ? '  nothing to acknowledge'
        : `  needs ${s.waiting.needs.join(', ')} — read it with \`substrat promote ${s.slug} --review-only\``,
      `  ${s.waiting.command}`,
    );
  }
  lines.push('', 'versions:');
  for (const v of s.versions) lines.push(`  ${v.version.padEnd(12)} ${v.admission.padEnd(9)} ${v.id}`);
  if (s.versions.length === 0) lines.push('  (none)');
  lines.push('', 'previews:');
  for (const p of s.previews) {
    lines.push(`  ${(p.tag ?? '?').padEnd(12)} ${p.url ?? '(no url)'}  ${p.versionId ?? '?'}  ${p.expiresAt ? `expires ${p.expiresAt}` : 'pinned'}`);
  }
  if (s.previews.length === 0) lines.push('  (none)');
  lines.push('', 'recent failures:');
  for (const f of s.failures) {
    lines.push(`  ${f.at}  ${f.operation}${f.stage ? `/${f.stage}` : ''}${f.status ? ` ${f.status}` : ''}: ${f.message}`);
  }
  if (s.failures.length === 0) lines.push('  (none)');
  return lines;
}
