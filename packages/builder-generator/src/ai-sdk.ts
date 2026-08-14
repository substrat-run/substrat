/**
 * `AiSdkGenerator` — the default implementation (builder-studio.md §5.3, D-49).
 *
 * Provider-agnostic by construction: this file imports NO provider package. The
 * caller passes a `LanguageModel` — `anthropic('claude-opus-5')`, `openai(...)`,
 * a local model via Ollama — and the AI SDK normalises tool calling and streaming
 * across all of them. Provider-specific settings survive through
 * `providerOptions`, so Claude's adaptive thinking, effort and cache breakpoints
 * are passed through rather than abstracted away.
 *
 * The honest bound, restated because the code cannot enforce it: "any LLM" is an
 * architectural guarantee, not a capability claim. Writing a correct Substrat
 * vertical is a hard agentic task and weak models will simply fail the tier-1
 * gates — which is the right outcome, and self-reporting once `evals/` exists
 * (§9.6).
 */
import {
	stepCountIs,
	streamText,
	type LanguageModel,
	type ModelMessage,
	type ProviderMetadata,
} from 'ai';
import type { BuildEvent } from './events.js';
import type { GeneratorInput, VerticalGenerator } from './generator.js';
import { workspaceTools } from './tools.js';

export interface AiSdkGeneratorOptions {
	readonly model: LanguageModel;
	/** For logs and evals — which model actually ran. */
	readonly label: string;
	/** Ceiling on tool-loop steps per turn. Also the runaway backstop. */
	readonly maxSteps?: number;
	/**
	 * Provider-specific settings, passed straight through. For Claude:
	 * `{ anthropic: { thinking: { type: 'adaptive' } } }` — leave thinking ON;
	 * with it disabled the model occasionally writes a tool call into visible
	 * text instead of emitting a tool_use block, so the call silently never runs.
	 */
	readonly providerOptions?: ProviderMetadata;
	/** Overrides the default system prompt. Normally you want `skills` instead. */
	readonly system?: string;
	/**
	 * The stable prefix: the substrat + new-vertical skills, and any spec the
	 * vertical is built against. Large and byte-stable, so it is the thing worth
	 * caching (§5.4) — keep volatile content out of it.
	 */
	readonly skills?: readonly string[];
	/**
	 * Turns a provider error into something a human can act on. Optional, and
	 * provider knowledge lives in the CALLER, not here — this file stays free of
	 * any provider's semantics (D-49). Return null to fall back to the raw message.
	 */
	readonly explainError?: (err: unknown) => string | null;
}

/** Best-effort extraction of the useful parts of an AI SDK API error. */
export interface ApiErrorFacts {
	readonly statusCode?: number;
	readonly code?: string;
	readonly url?: string;
	readonly message: string;
}

export function apiErrorFacts(err: unknown): ApiErrorFacts {
	const e = err as Record<string, unknown> | null;
	const data = (e?.['data'] as Record<string, unknown> | undefined)?.['error'] as
		| Record<string, unknown>
		| undefined;
	return {
		statusCode: typeof e?.['statusCode'] === 'number' ? (e['statusCode'] as number) : undefined,
		code: typeof data?.['code'] === 'string' ? (data['code'] as string) : undefined,
		url: typeof e?.['url'] === 'string' ? (e['url'] as string) : undefined,
		message: err instanceof Error ? err.message : String(err),
	};
}

const DEFAULT_SYSTEM = `You are building a Substrat vertical. THE WORKSPACE ROOT IS THE
PROJECT — every path is relative to it (src/module.ts, spec/concept.md, test/…). You
cannot read anything outside it, and you do not need to: everything about Substrat,
the engines, and the reference patterns is in the skill documents included below.
Each turn includes a current project map (files, recent commits, last diff) — trust
it: never call list_files to discover structure, and read a file only when you are
about to change it or the gates point at it. Re-reading files you wrote last turn
wastes the builder's budget.

Phases, in order:
1. INTERVIEW. If the project has no approved spec/concept.md, your job this turn is
   the interview, not code. Ask ONE question at a time with the ask_user tool,
   offering 2–5 concrete options — then end your turn and wait. A bare number in
   the reply means that option. Ask only the questions whose answers decide the
   domain model (who uses it; the entity lifecycle; who must be DENIED what;
   whether money or sign-off is involved). When you have enough, propose the
   concept in prose for approval; write spec/concept.md only after the builder
   agrees, and only then start code. In the turn where the concept is agreed,
   also call set_project_name once with a short product name.
2. BUILD. On a substantial build turn (initial scaffold, a new feature) your FIRST
   act is one propose_plan call: the files you will touch, packages you will add,
   and 3-4 build assumptions phrased as assumption + alternative (surface shape,
   app skin, portal, seed world, engines — never domain questions, those belong to
   the interview; never styling). Then execute the plan immediately — do not wait
   for approval; queued alternatives arrive as a later message. Trivial edits get
   no plan call. Work in increments against the approved concept and keep it
   updated.

Substrat is a multi-tenant kernel plus headless engines; a vertical owns vocabulary,
pricing, screens and roles, and composes engine in-scope functions inside its own
operations. The layer rules are enforced mechanically, so code that violates them
does not merely get reviewed badly — it fails a gate.

Non-negotiable rules for module code (everything reachable from a ModuleRegistration):
- Data access is ctx.sql only. Never import better-sqlite3, an adapter, or node:*.
- No fetch or network. Connectors handle the outside world.
- Never write to _substrat_* tables. Reads for projections are fine.
- Every operation's first line: assertAllowed(await ctx.check(PERM)).
- Every mutation emits a fat event; the consumer validates with its own Zod parse.
- Migrations are append-only and ordered; never edit a shipped version.
- Another module's tables are private. Reach engine data through exported in-scope
  functions; add your own side table keyed by the engine's id if you need more.
- IDs come from ulid(); money and decimals are strings via @substrat-run/contracts
  helpers. Never floats.
- Web-standard APIs only: globalThis.crypto, TextEncoder, URL.
- Parse, don't trust: operation inputs go through Zod at the boundary.

Working method:
- Read before you write. Never guess a file's current contents.
- Follow the patterns in the skill documents; declare @substrat-run/* dependencies
  with "workspace:*" versions and run pnpm install via run_command after changing
  package.json.
- After a meaningful change, run pnpm typecheck and pnpm test via run_command and
  fix what they report; the studio runs the full gate suite after every turn. The
  gates are the oracle, not your own judgement about the code.
- Do not write tests that re-assert engine invariants (state machines, append-only,
  permission checks) — those are verified once in the engines and inherited.
- Do not commit; the studio commits every turn for you.

Report what you did in one or two sentences. Do not narrate routine tool calls.`;

export class AiSdkGenerator implements VerticalGenerator {
	readonly id: string;
	readonly #opts: AiSdkGeneratorOptions;

	constructor(opts: AiSdkGeneratorOptions) {
		this.#opts = opts;
		this.id = `ai-sdk:${opts.label}`;
	}

	async *run(input: GeneratorInput): AsyncIterable<BuildEvent> {
		const queue: BuildEvent[] = [];
		const emit = (e: BuildEvent): void => {
			queue.push(e);
		};

		const tools = workspaceTools({ workspace: input.workspace, emit });

		// Prefix discipline (§5.4, finally implemented): the system prompt +
		// skills are byte-stable per phase and marked cacheable on Anthropic —
		// the tool loop re-sends everything on EVERY step (up to maxSteps model
		// calls per turn), so an uncached prefix is billed dozens of times over.
		// Volatile context (concept, workspace brief) goes in a separate system
		// message AFTER the breakpoint; a second breakpoint rides the last
		// history message so the growing conversation prefix caches too.
		const anthropic = this.#opts.label.startsWith('anthropic');
		const cache = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

		const stable = [this.#opts.system ?? DEFAULT_SYSTEM, ...(this.#opts.skills ?? [])].join(
			'\n\n---\n\n',
		);
		const volatileCtx = [
			`The vertical under construction lives at: ${input.verticalDir}`,
			`Approved concept:\n${input.concept}`,
			...(input.workspaceBrief ? [`Project map (current — do not re-discover it with list_files):\n${input.workspaceBrief}`] : []),
		].join('\n\n---\n\n');

		const history = (input.history ?? []).map(
			(t): ModelMessage => ({ role: t.role, content: t.text }),
		);
		const lastHist = history[history.length - 1];
		if (anthropic && lastHist) lastHist.providerOptions = cache;

		const messages: ModelMessage[] = [
			{
				role: 'system',
				content: stable,
				...(anthropic ? { providerOptions: cache } : {}),
			},
			{ role: 'system', content: volatileCtx },
			...history,
			{ role: 'user', content: input.message },
		];

		let steps = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		// Once the provider has failed, the SDK also rejects `usage` with a vague
		// "No output generated" — reporting both turns one problem into two.
		let reported = false;

		const explain = (err: unknown): string =>
			this.#opts.explainError?.(err) ?? apiErrorFacts(err).message;

		try {
			const result = streamText({
				model: this.#opts.model,
				messages,
				// v7 rejects role:'system' inside `messages` by default. We need system
				// MESSAGES (not the `system` string param) because Anthropic prompt
				// caching hangs cacheControl off per-message providerOptions — the
				// stable prefix gets a breakpoint, the volatile context does not.
				allowSystemInMessages: true,
				tools,
				stopWhen: stepCountIs(this.#opts.maxSteps ?? 40),
				// The SDK's default onError console.errors the whole object. We surface
				// errors as BuildEvents, so the default is pure noise in a chat pane.
				onError: () => {},
				...(this.#opts.providerOptions ? { providerOptions: this.#opts.providerOptions } : {}),
				...(input.signal ? { abortSignal: input.signal } : {}),
			});

			for await (const part of result.fullStream) {
				// Side effects recorded by the tools themselves come out first, so the
				// UI sees "wrote file" before the prose that describes it.
				while (queue.length) yield queue.shift() as BuildEvent;

				switch (part.type) {
					case 'text-delta':
						yield { type: 'assistant-text', text: part.text };
						break;
					// Presence only, one per reasoning burst — a truthful "thinking…"
					// for the turn's opening silence. Content is never forwarded.
					case 'reasoning-start':
						yield { type: 'thinking' };
						break;
					case 'finish-step':
						steps += 1;
						break;
					case 'error':
						reported = true;
						yield { type: 'error', message: explain(part.error), fatal: true };
						break;
					default:
						break;
				}
			}
			while (queue.length) yield queue.shift() as BuildEvent;

			if (!reported) {
				const usage = await result.usage;
				inputTokens = usage.inputTokens ?? 0;
				outputTokens = usage.outputTokens ?? 0;
				yield { type: 'usage', inputTokens, outputTokens, steps };
			}
		} catch (err) {
			while (queue.length) yield queue.shift() as BuildEvent;
			if (!reported) yield { type: 'error', message: explain(err), fatal: true };
		}
	}
}
