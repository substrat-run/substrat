/**
 * `substrat promote <slug> --version <id>` — a builder points its ONE channel (`prod`,
 * the serving pointer) at a version. Prod is self-serve while the vertical is PRIVATE
 * (builder-plane.md §4-revised; a listed vertical's prod is a staff decision again — the
 * control plane refuses it). `dev`/`staging` were retired (#509): a non-prod environment
 * is a scope with data — a preview (`substrat preview create`) — not a second pointer.
 * The slug is BARE — the control plane forms `<tenantSlug>/<slug>` from the caller's tenant
 * (§5), so a builder never types their own prefix. Only admitted versions promote; a changed
 * digest is refused without acknowledgement (the two checkpoints), surfaced as a 4xx here —
 * re-run with `--ack-permissions` / `--ack-migrations` after reading the named diff.
 *
 * #1705 PR 3: a promote that drops or re-versions an exported event an installed app imports
 * is refused too (409), and the refusal lists the apps it would break: the caller's own tenant's
 * by name, any other tenant only as a count. `--ack-export-break` passes it once that is read.
 */
import type { ExportBreak } from '@substrat-run/contracts';
import { warnIfStale } from './version.js';
import { parseJsonBody } from './http.js';
import { failureMessage } from './problem.js';

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
  // checkpoints answer 4xx with the diff that needs acknowledging (#971).
  if (!res.ok) {
    let breaks: ExportBreaks | undefined;
    try {
      breaks = (JSON.parse(body) as { exportBreaks?: ExportBreaks }).exportBreaks;
    } catch {
      // Not JSON: the failure message below carries the body as it is.
    }
    const listing = breaks ? `\n${exportBreakLines(breaks).join('\n')}\n(re-run with --ack-export-break once read)` : '';
    throw new Error(failureMessage('promote failed', res.status, body) + listing);
  }
  return parseJsonBody<PromoteResult>(body, url);
}
