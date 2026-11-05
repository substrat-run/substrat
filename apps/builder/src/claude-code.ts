/**
 * `ClaudeCodeGenerator` — the generator seam (D-49) bound to a local Claude Code
 * session through the Claude Agent SDK, so an eval sweep can run on the
 * builder's own Claude subscription instead of a metered API key.
 *
 * What is the SAME as `AiSdkGenerator`, on purpose: the prompt (one
 * `generatorPrompt` call, byte-identical parts), the tools (the very
 * `workspaceTools` objects, served as an in-process MCP server, with every
 * Claude Code built-in turned off), and therefore the write guard, the command
 * deny-list and the ask_user ledger. What differs is only the agent loop —
 * Claude Code's instead of `streamText`'s: its retry, its context handling, its
 * step accounting. A result here measures the skills and the tools; a result on
 * the API path is still what measures the studio as hosted.
 *
 * Node-only and local-only: the SDK spawns a Claude Code process signed in as
 * whoever runs it. It lives in the app, never in builder-generator, because the
 * hosted worker imports that package. Nothing here ships a credential anywhere —
 * and `ANTHROPIC_API_KEY` is stripped from the child's environment, because
 * Claude Code prefers a key over the subscription login when it sees one, which
 * would bill the run while the report said it was free.
 */
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import {
	generatorPrompt,
	workspaceTools,
	type BuildEvent,
	type GeneratorInput,
	type StepUsage,
	type VerticalGenerator,
} from '@substrat-run/builder-generator';
import type { z } from 'zod';

export const CLAUDE_CODE_PROVIDER = 'claude-code';

/** `claude-code:sonnet` → `sonnet`; anything Claude Code's `--model` accepts. */
export function claudeCodeModel(spec: string): string | null {
	const [provider, ...rest] = spec.split(':');
	if (provider !== CLAUDE_CODE_PROVIDER) return null;
	const model = rest.join(':');
	return model || 'sonnet';
}

export interface ClaudeCodeGeneratorOptions {
	/** Claude Code's model alias or id: `sonnet`, `haiku`, `claude-sonnet-5-5`, … */
	readonly model: string;
	/** Absolute path of the project — the session's cwd. */
	readonly cwd: string;
	readonly skills?: readonly string[];
	/** Claude Code's `maxTurns`: model round-trips in one pass, the step ceiling. */
	readonly maxSteps?: number;
	readonly denyWrite?: (path: string) => string | null;
}

/** The MCP server's name; Claude sees each tool as `mcp__builder__<tool>`. */
const SERVER = 'builder';

/** Prior turns, rendered into the prompt: each pass is a fresh Claude Code session. */
function renderHistory(input: GeneratorInput): string | null {
	const turns = input.history ?? [];
	if (turns.length === 0) return null;
	return (
		'Conversation so far (earlier turns of this build, oldest first):\n\n' +
		turns.map((t) => `[${t.role === 'user' ? 'builder' : 'you'}]\n${t.text}`).join('\n\n')
	);
}

export class ClaudeCodeGenerator implements VerticalGenerator {
	readonly id: string;
	readonly #opts: ClaudeCodeGeneratorOptions;

	constructor(opts: ClaudeCodeGeneratorOptions) {
		this.#opts = opts;
		this.id = `${CLAUDE_CODE_PROVIDER}:${opts.model}`;
	}

	async *run(input: GeneratorInput): AsyncIterable<BuildEvent> {
		const queue: BuildEvent[] = [];
		const emit = (e: BuildEvent): void => {
			queue.push(e);
		};

		// edit_file on: every model Claude Code serves is frontier-tier, the same
		// declaration model-pairs.ts makes for the anthropic provider.
		const tools = workspaceTools({
			workspace: input.workspace,
			emit,
			editTool: true,
			...(this.#opts.denyWrite ? { denyWrite: this.#opts.denyWrite } : {}),
		});
		const server = createSdkMcpServer({
			name: SERVER,
			version: '1.0.0',
			tools: Object.entries(tools).map(([name, t]) =>
				tool(
					name,
					typeof t.description === 'string' ? t.description : name,
					(t.inputSchema as z.ZodObject).shape,
					async (args) => {
						const out = await t.execute!(args as never, { toolCallId: name, messages: [], context: {} as never });
						return { content: [{ type: 'text' as const, text: String(out) }] };
					},
				),
			),
		});

		const prompt = generatorPrompt(input, {
			...(this.#opts.skills ? { skills: this.#opts.skills } : {}),
			editTool: true,
		});
		const history = renderHistory(input);

		const abort = new AbortController();
		input.signal?.addEventListener('abort', () => abort.abort(), { once: true });
		const { ANTHROPIC_API_KEY: _key, ...env } = process.env;

		const stepUsage: StepUsage[] = [];
		const seen = new Set<string>();
		let steps = 0;

		try {
			for await (const msg of query({
				prompt: [...(history ? [history] : []), prompt.user].join('\n\n---\n\n'),
				options: {
					model: this.#opts.model,
					cwd: this.#opts.cwd,
					systemPrompt: `${prompt.stable}\n\n---\n\n${prompt.concept}`,
					// No built-ins: the builder's tools are the whole surface, so the
					// guards that bind the studio bind this run too.
					tools: [],
					mcpServers: { [SERVER]: server },
					strictMcpConfig: true,
					allowedTools: Object.keys(tools).map((n) => `mcp__${SERVER}__${n}`),
					permissionMode: 'dontAsk',
					// Isolation from the machine's own Claude Code setup: no user or
					// repo CLAUDE.md, no plugins, no hooks — the skills are the prompt.
					settingSources: [],
					persistSession: false,
					maxTurns: this.#opts.maxSteps ?? 40,
					abortController: abort,
					env,
				},
			})) {
				if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
					for (const block of msg.message.content) {
						if (block.type === 'text' && block.text) emit({ type: 'assistant-text', text: block.text });
						if (block.type === 'thinking') emit({ type: 'thinking' });
					}
					// A streamed message can arrive once per content block with the
					// same id and usage; count each request once.
					if (!seen.has(msg.message.id)) {
						seen.add(msg.message.id);
						steps += 1;
						const u = msg.message.usage;
						stepUsage.push({
							inputTokens:
								u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
							outputTokens: u.output_tokens,
							cachedInputTokens: u.cache_read_input_tokens ?? 0,
							cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
						});
					}
				}
				if (msg.type === 'result') {
					if (msg.subtype === 'error_max_turns') {
						emit({ type: 'truncated', steps, maxSteps: this.#opts.maxSteps ?? 40 });
					} else if (msg.is_error) {
						const detail =
							msg.subtype === 'success' ? msg.result : (msg.errors ?? []).join('; ') || msg.subtype;
						emit({ type: 'error', message: `claude-code: ${detail}`, fatal: true });
					}
				}
				yield* queue.splice(0);
			}
		} catch (err) {
			emit({ type: 'error', message: `claude-code: ${err instanceof Error ? err.message : String(err)}`, fatal: true });
		}
		yield* queue.splice(0);

		const sum = (f: (s: StepUsage) => number) => stepUsage.reduce((n, s) => n + f(s), 0);
		yield {
			type: 'usage',
			inputTokens: sum((s) => s.inputTokens),
			outputTokens: sum((s) => s.outputTokens),
			cachedInputTokens: sum((s) => s.cachedInputTokens ?? 0),
			cacheWriteTokens: sum((s) => s.cacheWriteTokens ?? 0),
			steps,
			stepUsage,
		};
	}
}
