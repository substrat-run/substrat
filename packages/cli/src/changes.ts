/**
 * `substrat changes [slug]` — the vertical's open changes, whichever provider holds them: its
 * GitHub pull requests, or a hosted repository's `builder/<id>` chat branches, each with its
 * checks and its preview. Read-only. `--json` is the control plane's answer as is, for a tool
 * (the plugin's approvals pane) that shows it to a person.
 */
import type { VerticalChanges } from '@substrat-run/contracts';
import { planeFor, viaPlane } from './plane.js';
import { readRefused } from './problem.js';

export async function readChanges(opts: { controlPlaneUrl: string; header: Record<string, string>; slug: string }): Promise<VerticalChanges> {
  const client = planeFor(opts.controlPlaneUrl, opts.header);
  return viaPlane(() => client.listChanges(opts.slug), readRefused);
}

const CHECKS: Record<VerticalChanges['changes'][number]['checks']['state'], string> = {
  success: 'checks pass',
  failure: 'checks fail',
  pending: 'checks running',
  none: 'no checks',
  unknown: 'checks unknown',
};

export function formatChanges(r: VerticalChanges): string[] {
  if (r.provider === null) return [`no open changes can be read${r.repository ? ` from ${r.repository}` : ''}: ${r.reason ?? 'no repository is known'}`];
  const lines = [`open changes in ${r.repository} (${r.provider === 'github' ? 'GitHub pull requests' : 'studio chats'}):`];
  if (r.reason) lines.push(`  (${r.reason})`);
  if (r.changes.length === 0) lines.push('  (none)');
  for (const c of r.changes) {
    lines.push(`  ${c.id}  ${c.title}`);
    const failing = c.checks.failing.length > 0 ? `: ${c.checks.failing.join(', ')}` : '';
    lines.push(`      ${c.branch} · ${CHECKS[c.checks.state]}${failing}${c.author ? ` · ${c.author}` : ''} · updated ${c.updatedAt}`);
    if (c.preview) lines.push(`      preview ${c.preview.tag}: ${c.preview.url ?? '(no url yet)'}`);
    if (c.url) lines.push(`      ${c.url}`);
  }
  return lines;
}
