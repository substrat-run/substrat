/**
 * The model's tools ARE the `Workspace` methods — builder-studio.md §5.3.
 *
 * This is the choice that makes "any LLM" work without weakening the §3 seam:
 * because every tool routes through `Workspace`, the generator behaves identically
 * over `LocalWorkspace` and `ContainerWorkspace`, and **no provider credential ever
 * enters the sandbox** — §10's "no real secrets in the image" holds by construction
 * rather than by care, since the model runs on our side and only its tool calls
 * cross the boundary.
 *
 * Tool descriptions are prescriptive about *when* to call, not just what the tool
 * does: that is worth real accuracy on current models and costs nothing here.
 */
import { tool } from 'ai';
import { z } from 'zod';
import type { Workspace } from '@substrat-run/builder-workspace';
import type { BuildEvent } from './events.js';

export interface WorkspaceToolOptions {
	readonly workspace: Workspace;
	/** Called for every observable side effect, so the UI sees work as it happens. */
	readonly emit: (e: BuildEvent) => void;
	/** Commands the model may not run — enforced here, not by prompting. */
	readonly denyCommand?: (cmd: string) => string | null;
}

/**
 * Commands refused regardless of prompt. Not a security boundary in mode A (§10 —
 * there is no isolation there), but it stops the most common ways an agent
 * destroys a session's own history or escapes the workspace by shelling out.
 */
const DEFAULT_DENY: Array<[RegExp, string]> = [
	[/\bgit\s+push\b/, 'pushing is the studio\'s job, not the model\'s'],
	[/\bgit\s+(reset|rebase|checkout)\s+.*--hard\b/, 'destroys the durable tier (§2)'],
	[/\bgit\s+commit\b/, 'commit-per-turn is owned by the turn loop (§3)'],
	[/\brm\s+-rf\s+\/(?!\w)/, 'refusing to remove the filesystem root'],
	[/\bcurl\b|\bwget\b/, 'no network from the tool surface; declare deps in package.json'],
	// Accident-guard, not a jail (mode A has no isolation, §10): the file tools
	// are path-confined to the project, so the shell should not casually be the
	// way around them. The container makes this real in hosted mode.
	[/\.\.\//, 'paths above the project are out of bounds — everything you need is in the project and the skills'],
];

function defaultDeny(cmd: string): string | null {
	for (const [re, why] of DEFAULT_DENY) if (re.test(cmd)) return why;
	return null;
}

export function workspaceTools(opts: WorkspaceToolOptions) {
	const { workspace: ws, emit } = opts;
	const deny = opts.denyCommand ?? defaultDeny;

	return {
		read_file: tool({
			description:
				'Read a UTF-8 file from the workspace. Call this before editing any file you have not already read this session — never guess a file\'s current contents.',
			inputSchema: z.object({
				path: z.string().describe('Path relative to the workspace root, e.g. demos/foo/src/module.ts'),
			}),
			execute: async ({ path }) => {
				emit({ type: 'tool-call', tool: 'read_file', summary: path });
				try {
					const content = await ws.readFile(path);
					// Cap what one read can cost: head + tail with an honest gap marker.
					const CAP = 24_000;
					if (content.length <= CAP) return content;
					return (
						content.slice(0, CAP / 2) +
						`\n\n…[${content.length - CAP} chars omitted — re-read a narrower file or use run_command with grep]…\n\n` +
						content.slice(-CAP / 2)
					);
				} catch (err) {
					return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
		}),

		write_file: tool({
			description:
				'Create or overwrite a file with the full content given. Parent directories are created automatically. Use this for new files and for whole-file rewrites; for a small change to a large file, read it first and write it back complete.',
			inputSchema: z.object({
				path: z.string().describe('Path relative to the workspace root'),
				content: z.string().describe('The complete file content'),
			}),
			execute: async ({ path, content }) => {
				try {
					await ws.writeFile(path, content);
					emit({ type: 'file-written', path, bytes: content.length });
					return `wrote ${path} (${content.length} bytes)`;
				} catch (err) {
					return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
		}),

		list_files: tool({
			description:
				'List the entries of a directory. Directories are suffixed with "/". Call this to orient before assuming a layout.',
			inputSchema: z.object({ path: z.string().describe('Directory relative to the workspace root') }),
			execute: async ({ path }) => {
				emit({ type: 'tool-call', tool: 'list_files', summary: path });
				try {
					const entries = await ws.listFiles(path);
					return entries.length ? entries.join('\n') : '(empty)';
				} catch (err) {
					return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
				}
			},
		}),

		propose_plan: tool({
			description:
				'Declare the build plan BEFORE writing any file, on substantial build turns only (initial scaffold, a new feature — never a trivial edit). List every file you intend to create or edit, packages you will add, and 3-4 assumptions the plan commits to, each phrased as assumption + one-shot alternative and ordered by reversal cost (surface shape and permission model first; styling never). The concept interview handles domain questions — assumptions cover BUILD defaults only: UI-or-API-only, app skin (React+Vite served by the API is the platform default), portal surface, seed world, engine selection.',
			inputSchema: z.object({
				summary: z.string().describe('One sentence: what this turn builds'),
				files: z
					.array(z.object({ path: z.string(), action: z.enum(['create', 'edit']) }))
					.describe('Every file this turn will touch, in rough order'),
				dependencies: z.array(z.string()).describe('Packages to add; empty if none'),
				assumptions: z
					.array(
						z.object({
							id: z.string().describe('short-kebab id, e.g. "app-skin"'),
							category: z.enum(['surface', 'roles', 'seed', 'engines', 'stack', 'other']),
							assumption: z.string().describe('What you assumed, stated as a commitment'),
							alternative: z.string().describe('The one-shot reversal the builder can queue'),
							reversalCost: z.enum(['high', 'medium', 'low']),
						}),
					)
					.max(4)
					.describe('3-4, ordered most-expensive-to-reverse first; [] on trivial turns'),
			}),
			execute: async ({ summary, files, dependencies, assumptions }) => {
				emit({ type: 'plan', summary, files, dependencies, assumptions });
				return 'Plan shown to the builder. Execute it now — do not wait for approval; queued alternatives arrive as a later message.';
			},
		}),

		set_project_name: tool({
			description:
				'Propose a short product name for this project. Call ONCE, at the moment the builder agrees to the concept — never before, never on later turns. 1-3 words, the product\'s name as a user would say it (e.g. "Fältservice", "Invoice Radar"), not a description. The studio may ignore it if the builder already named the project themselves.',
			inputSchema: z.object({
				name: z.string().min(2).max(48).describe('The proposed product name'),
			}),
			execute: async ({ name }) => {
				emit({ type: 'project-named', name });
				return 'Name proposed to the studio.';
			},
		}),

		ask_user: tool({
			description:
				'Ask the builder ONE question and offer 2–5 concrete options to choose from. Use this during the interview phase instead of writing several questions into one message. After calling it, END YOUR TURN and wait — the answer arrives as the next user message (a bare number means that option).',
			inputSchema: z.object({
				question: z.string().describe('One question, plainly phrased'),
				options: z
					.array(z.string())
					.min(2)
					.max(5)
					.describe('Concrete answers the builder can pick; the UI adds free-text automatically'),
			}),
			execute: async ({ question, options }) => {
				emit({ type: 'question', question, options });
				return 'Question shown to the builder. End your turn now; their choice arrives as the next message.';
			},
		}),

		run_command: tool({
			description:
				'Run a shell command in the workspace root and return its exit code, stdout and stderr. Use it for typechecking, tests and lint tools. Do not use it to commit, push, or fetch from the network.',
			inputSchema: z.object({
				cmd: z.string().describe('The command line, e.g. "pnpm -r typecheck"'),
				cwd: z.string().optional().describe('Optional subdirectory, relative to the workspace root'),
			}),
			execute: async ({ cmd, cwd }) => {
				const refusal = deny(cmd);
				if (refusal) return `REFUSED: ${refusal}`;
				const r = await ws.exec(cmd, cwd ? { cwd } : undefined);
				emit({ type: 'command', cmd, exitCode: r.exitCode });
				const body = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join('\n');
				// Success output is confirmation, not information — a passing vitest
				// run's chatter would be re-billed on every later step of the turn.
				// Failures keep a real tail; both caps are tail-biased because build
				// tools put the verdict last.
				const cap = r.exitCode === 0 ? 1_500 : 8_000;
				const kept = body.slice(-cap);
				return `exit ${r.exitCode}\n${body.length > cap ? `…[${body.length - cap} chars omitted]…\n` : ''}${kept}`;
			},
		}),
	};
}

export type WorkspaceTools = ReturnType<typeof workspaceTools>;
