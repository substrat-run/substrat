/**
 * The open changes of one vertical (`GET /verticals/:slug/changes`): its GitHub pull requests,
 * or a hosted repository's `builder/<id>` chat branches, each with its checks and its preview.
 * One provider-neutral shape, read by `substrat changes`, the plugin's approvals pane and the
 * dashboard alike.
 */
import { z } from 'zod';

export const changeChecks = z.object({
  /**
   * `none`: nothing reports on this head (or a hosted branch, which runs no checks). `unknown`:
   * they could not be read (the answer's `reason` says why).
   */
  state: z.enum(['success', 'failure', 'pending', 'none', 'unknown']),
  /** The names of the checks that failed. */
  failing: z.array(z.string()),
});
export type ChangeChecks = z.infer<typeof changeChecks>;

export const verticalChange = z.object({
  /** `#12` for a pull request, the chat id for a hosted branch. */
  id: z.string().min(1),
  title: z.string(),
  branch: z.string().min(1),
  url: z.string().nullable(),
  author: z.string().nullable(),
  updatedAt: z.string(),
  /** The head commit, or null for a branch with none yet. */
  head: z.string().nullable(),
  checks: changeChecks,
  /** The PR's preview (its sticky `pr-<n>` tag, else its newest build tag); null when none runs. */
  preview: z.object({ tag: z.string(), url: z.string().nullable() }).nullable(),
});
export type VerticalChange = z.infer<typeof verticalChange>;

export const verticalChanges = z.object({
  /** Null when no repository could be read: `reason` says why. */
  provider: z.enum(['github', 'artifacts']).nullable(),
  /** `owner/repo`, or a hosted repository's name. */
  repository: z.string().nullable(),
  changes: z.array(verticalChange),
  /** Why no repository could be read, or why part of what is shown (its checks) could not be. */
  reason: z.string().optional(),
});
export type VerticalChanges = z.infer<typeof verticalChanges>;

/**
 * The builder studio's answer for one project (`GET /internal/changes?slug=`): its repository and,
 * for a hosted one, the chat branches with work the base does not have. A GitHub project's chats
 * merge by pull request, so the control plane reads those from GitHub instead.
 */
export const hostedChanges = z.object({
  /** Null: the studio keeps no project for that slug. */
  repository: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('artifacts'), name: z.string(), branch: z.string() }),
    z.object({ kind: z.literal('github'), owner: z.string(), repo: z.string(), branch: z.string() }),
  ]).nullable(),
  changes: z.array(z.object({ id: z.string(), title: z.string(), branch: z.string(), updatedAt: z.string(), head: z.string().nullable() })),
});
export type HostedChanges = z.infer<typeof hostedChanges>;
