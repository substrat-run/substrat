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
	type LanguageModelUsage,
	type ModelMessage,
	type ProviderMetadata,
	type StopCondition,
} from 'ai';
import type { BuildEvent, BuildEventOf, StepUsage } from './events.js';
import { condenseTranscript, type CondenseResult } from './condense.js';
import type { GeneratorInput, VerticalGenerator } from './generator.js';
import { classifyProviderError, retryDelayMs } from './retry.js';
import { workspaceTools } from './tools.js';

export interface AiSdkGeneratorOptions {
	readonly model: LanguageModel;
	/** For logs and evals — which model actually ran. */
	readonly label: string;
	/** Ceiling on tool-loop steps per turn. Also the runaway backstop. */
	readonly maxSteps?: number;
	/**
	 * Uncached-equivalent tokens one turn may spend before it is cut off.
	 *
	 * A step ceiling bounds ITERATIONS, not spend, and the two diverge fast:
	 * every step re-sends a growing transcript, so cost per step climbs through
	 * the turn. Measured on #740's first real run — the turn hit the 40-step
	 * ceiling AND spent 2,036,785 input tokens chasing a phantom type error, so
	 * `maxSteps` fired and bounded nothing that mattered.
	 *
	 * Budgeted on UNCACHED-equivalent tokens (`input - cacheRead + output`)
	 * because 96% of that run was cache reads, billed around a tenth of the rate.
	 * A raw-token budget would cut off a long, well-cached, perfectly behaved
	 * build while letting a short badly-cached one run.
	 */
	readonly maxTokens?: number;
	/**
	 * Retries per turn on TRANSIENT provider failures (429/5xx/network), with
	 * retry-after honored and jittered backoff (retry.ts). Default 5. The turn
	 * resumes from the failed request; overflow and client errors never retry.
	 */
	readonly maxRetries?: number;
	/**
	 * Offer the edit_file search/replace tool (builder-harness.md H1). Default
	 * OFF: the host declares it per model (model-pairs.ts `editToolFor`) —
	 * frontier models hold the exact-match format ~97–99% of the time, sub-tier
	 * models collapse (aider's leaderboard), so weak models keep whole-file
	 * writes by declaration rather than by failure.
	 */
	readonly editTool?: boolean;
	/**
	 * Sampling temperature, when the host declares one per model (H4 —
	 * model-pairs.ts `samplingFor`: qwen wants 0.55, not the SDK default).
	 * Absent = the provider's own default.
	 */
	readonly temperature?: number;
	/**
	 * Nucleus sampling, same declaration path as temperature. Qwen needs 0.8:
	 * without it the family falls into single-token repetition loops on long
	 * agentic turns. Absent = the provider's own default.
	 */
	readonly topP?: number;
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
	/**
	 * Paths write_file must refuse this turn (returns the reason). The hosts use
	 * it to make the phase ladder mechanical — interview turns write only spec/**.
	 */
	readonly denyWrite?: (path: string) => string | null;
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

type CachePO = { anthropic: { cacheControl: { type: 'ephemeral' } } };
const CACHE_PO: CachePO = { anthropic: { cacheControl: { type: 'ephemeral' } } };

/**
 * Per-step breakpoint advance (Anthropic dialect). The tool loop re-sends the
 * whole growing transcript on every step; without a moving breakpoint each step
 * re-bills all prior steps' tool traffic at full price — roughly quadratic in
 * steps. Strategy: keep the assembly-time breakpoints on the two system
 * messages, strip any previous per-step mark, and mark the current last
 * message, so each step reads everything before it from cache and writes one
 * new increment. Never more than 3 concurrent breakpoints (Anthropic allows 4).
 */
export function withMovingBreakpoint(messages: ModelMessage[]): ModelMessage[] {
	const out = messages.map((m): ModelMessage => {
		if (m.role === 'system') return m;
		if ((m.providerOptions as CachePO | undefined)?.anthropic?.cacheControl) {
			const { providerOptions: _drop, ...rest } = m;
			return rest as ModelMessage;
		}
		return m;
	});
	const last = out[out.length - 1];
	if (last && last.role !== 'system') {
		out[out.length - 1] = { ...last, providerOptions: CACHE_PO } as ModelMessage;
	}
	return out;
}

/**
 * Stale-payload pruning for providers WITHOUT placeable cache breakpoints
 * (OpenAI-compatible dialects) — there, every byte of transcript is re-billed
 * at full price each step, so dead payloads are pure waste. A payload is dead
 * once a later call touches the same target: an old write_file body is
 * superseded by the next write/read of that path, an old read result by a
 * later read, an old run_command log by re-running the same command. Only the
 * newest payload per target keeps its bytes; older ones become one-line stubs.
 * Pruning mutates only newly-superseded entries, so the transcript prefix
 * stays byte-stable for providers that do implicit prefix caching.
 *
 * NOT used on the Anthropic dialect: there the cache makes old payloads cheap,
 * and rewriting history would invalidate it — worse than leaving them.
 */
export function pruneStalePayloads(messages: ModelMessage[]): ModelMessage[] {
	// Pass 1: assign each payload-bearing call/result a sequence per target key.
	const keyOfCall = (toolName: string, input: unknown): string | null => {
		const path = (input as { path?: unknown } | null)?.path;
		// edit_file shares the file key: an edit changes the file, so an older
		// read/write payload for that path is stale (the model must re-read
		// before further exact-match edits anyway). Edit payloads themselves are
		// small and are never stubbed — they only supersede.
		if (
			(toolName === 'write_file' || toolName === 'read_file' || toolName === 'edit_file') &&
			typeof path === 'string'
		)
			return `file:${path}`;
		const cmd = (input as { cmd?: unknown } | null)?.cmd;
		if (toolName === 'run_command' && typeof cmd === 'string') return `cmd:${cmd}`;
		return null;
	};
	const callKey = new Map<string, string>(); // toolCallId -> key
	const callSeq = new Map<string, number>(); // toolCallId -> seq (result shares it)
	const lastSeq = new Map<string, number>(); // key -> newest seq
	let seq = 0;
	const seqs = new Map<string, number>(); // "<mi>:<pi>" -> seq
	messages.forEach((m, mi) => {
		if (!Array.isArray(m.content)) return;
		m.content.forEach((p, pi) => {
			if (m.role === 'assistant' && p.type === 'tool-call') {
				const key = keyOfCall(p.toolName, p.input);
				if (!key) return;
				callKey.set(p.toolCallId, key);
				callSeq.set(p.toolCallId, seq);
				seqs.set(`${mi}:${pi}`, seq);
				lastSeq.set(key, seq);
				seq += 1;
			} else if (m.role === 'tool' && p.type === 'tool-result') {
				// A result shares its call's seq — a call must never be "stale"
				// merely because its own result follows it.
				const s = callSeq.get(p.toolCallId);
				if (s !== undefined) seqs.set(`${mi}:${pi}`, s);
			}
		});
	});

	// Pass 2: stub every payload whose key has a newer occurrence.
	const STUB = '[superseded — a later call touched the same target; content dropped to save budget]';
	const stale = (mi: number, pi: number, key: string | undefined): boolean => {
		if (key === undefined) return false;
		const s = seqs.get(`${mi}:${pi}`);
		return s !== undefined && s < (lastSeq.get(key) ?? -1);
	};
	return messages.map((m, mi): ModelMessage => {
		if (!Array.isArray(m.content)) return m;
		let touched = false;
		const content = m.content.map((p, pi) => {
			if (m.role === 'assistant' && p.type === 'tool-call' && p.toolName === 'write_file') {
				const input = p.input as { path?: string; content?: unknown };
				if (
					stale(mi, pi, callKey.get(p.toolCallId)) &&
					typeof input?.content === 'string' &&
					input.content.length > STUB.length
				) {
					touched = true;
					return { ...p, input: { path: input.path, content: STUB } };
				}
			} else if (m.role === 'tool' && p.type === 'tool-result') {
				const out = p.output as { type?: string; value?: unknown };
				const heavy =
					(out?.type === 'text' || out?.type === 'json') &&
					typeof out.value === 'string' &&
					out.value.length > STUB.length;
				if (heavy && stale(mi, pi, callKey.get(p.toolCallId))) {
					touched = true;
					return { ...p, output: { type: out.type, value: STUB } };
				}
			}
			return p;
		});
		return touched ? ({ ...m, content } as ModelMessage) : m;
	});
}

const DEFAULT_SYSTEM = `You are building a Substrat vertical. THE WORKSPACE ROOT IS THE
PROJECT — every path is relative to it (src/module.ts, spec/concept.md, test/…). You
cannot read anything outside it, and you do not need to: everything about Substrat,
the engines, and the reference patterns is in the skill documents included below.
Each turn includes a current project map (files, recent commits, last diff) — trust
it: never call list_files to discover structure, and read a file only when you are
about to change it or the gates point at it. Re-reading files you wrote last turn
wastes the builder's budget.

Chat messages render as Markdown — write normal markdown (short paragraphs, bold,
lists) and never rely on plain-text spacing for layout.

Phases, in order. The ladder advances ONLY on workspace facts: spec/concept.md
existing moves interview → scaffold; src/module.ts existing moves scaffold →
iterate. A phase you claim but the files don't show does not exist.
1. INTERVIEW. If the project has no approved spec/concept.md, your job this turn is
   the interview, not code — during interview turns, write_file mechanically
   refuses every path outside spec/. Questions go through the ask_user tool and
   NEVER as numbered lists in prose text (prose options are not clickable). One
   question per ask_user call; if 2–4 answers are genuinely coupled, make one
   call per question in the same turn — the UI shows them as tabs and returns
   all answers in one message. The UI always adds a free-text "Other" answer;
   never offer an "Other" option yourself. Ask only the questions whose answers
   decide the domain model (who uses it; the entity lifecycle; who must be
   DENIED what; whether money or sign-off is involved). When you have enough,
   propose the concept in prose for approval. In the turn where the builder
   agrees: FIRST write spec/concept.md with write_file, then call
   set_project_name once with a short product name, then confirm in a sentence
   and END the turn, telling the builder to say "build it" (or anything) to
   start — the scaffold begins next turn, with the scaffold references loaded.
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

/**
 * Joined into the stable prefix ONLY when the edit_file tool is offered —
 * prompting for an absent tool would send the model chasing it.
 */
const EDIT_GUIDANCE = `Editing files: for a small change to an existing file, use edit_file
(exact search/replace) instead of re-emitting the whole file with write_file — whole-file
rewrites of long files waste the builder's budget. oldString must match the file exactly,
including every space and indent; keep it as short as uniqueness allows. A line containing
only "..." in BOTH strings stands for an unchanged middle section, so you can anchor on a
function's first and last lines without re-sending its body. write_file remains the right
tool for NEW files and full rewrites. If an edit fails, the error tells you exactly why —
fix that one block and retry; never fall back to write_file just to force a change through.`;

/**
 * Stop the turn once it has spent `budget` UNCACHED-equivalent tokens.
 *
 * Exported so it can be tested directly: a stop condition that never fires is
 * indistinguishable from one that is not wired up, and this one only runs on the
 * path nobody exercises in a normal build.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `stepCountIs`
// is typed the same way: a stop condition is tool-agnostic, and the specific
// ToolSet the SDK infers at the call site is not assignable to a general one.
export function tokenBudgetIs(budget: number): StopCondition<any> {
	return ({ steps }) => uncachedEquivalent(steps) >= budget;
}

/**
 * `input - cacheRead + output`, summed over the steps so far.
 *
 * Cache reads are billed at roughly a tenth of fresh input, so counting them at
 * face value would make a well-cached long build look like a runaway. Clamped at
 * zero per step because a provider that reports more cached than input tokens
 * should not be able to buy the turn extra budget.
 */
/** A recorded `StepUsage` back into the SDK's usage shape, for the budget sum. */
function asUsage(u: StepUsage): LanguageModelUsage {
	return {
		inputTokens: u.inputTokens,
		outputTokens: u.outputTokens,
		totalTokens: u.inputTokens + u.outputTokens,
		inputTokenDetails: { cacheReadTokens: u.cachedInputTokens ?? 0 },
	} as LanguageModelUsage;
}

export function uncachedEquivalent(
	steps: readonly { readonly usage: LanguageModelUsage }[],
): number {
	let spent = 0;
	for (const s of steps) {
		const u = s.usage;
		const cached = u.inputTokenDetails?.cacheReadTokens ?? 0;
		spent += Math.max(0, (u.inputTokens ?? 0) - cached) + (u.outputTokens ?? 0);
	}
	return spent;
}

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

		const editTool = this.#opts.editTool ?? false;
		const tools = workspaceTools({
			workspace: input.workspace,
			emit,
			editTool,
			...(this.#opts.denyWrite ? { denyWrite: this.#opts.denyWrite } : {}),
		});

		// Prefix discipline (§5.4): everything before the chat history must be
		// byte-stable across turns, because a changed byte invalidates the cache
		// for all that follows. So the prefix holds only the system prompt +
		// skills (stable per phase) and the concept (stable once approved), each
		// closing with an Anthropic breakpoint. The workspace brief changes
		// EVERY turn — it rides in the final user message, after the history,
		// where it can't break the conversation's cache.
		const anthropic = this.#opts.label.startsWith('anthropic');

		// The qwen dialect also has a working prompt cache — but its explicit
		// markers cannot ride providerOptions (DashScope wants them on content
		// BLOCKS; the openai-compatible provider only spreads message-level), so
		// the HOST injects them at the wire (apps/builder qwenCacheFetch). What
		// this file owes that cache: a byte-stable transcript. No pruning — same
		// reasoning as the Anthropic branch below.
		const qwenDialect = this.#opts.label.startsWith('qwen/');

		// Cache plumbing for the OpenAI dialect (H4): Anthropic gets placeable
		// breakpoints (below); OpenAI's caching is automatic but shard-routed —
		// a stable per-project promptCacheKey routes every request of a project
		// to the same cache shard, and store:false keeps transcripts out of
		// OpenAI's server-side response storage. Dialect knowledge, like the
		// breakpoint helpers — not provider config (D-49 stays intact).
		const openaiDialect = this.#opts.label.startsWith('openai/');
		const providerOptions = {
			...(openaiDialect
				? {
						openai: {
							promptCacheKey: `substrat-builder:${input.verticalDir}`,
							store: false,
							...((this.#opts.providerOptions as Record<string, object> | undefined)?.[
								'openai'
							] ?? {}),
						},
					}
				: {}),
			...(openaiDialect
				? Object.fromEntries(
						Object.entries(this.#opts.providerOptions ?? {}).filter(([k]) => k !== 'openai'),
					)
				: (this.#opts.providerOptions ?? {})),
		} as ProviderMetadata;
		const hasProviderOptions = Object.keys(providerOptions).length > 0;

		// Present only when the edit_file tool is (format-per-model, H1): a prompt
		// naming an absent tool would send weak models chasing it. Stable per
		// session — the model, and with it this block, never changes mid-project.
		const stable = [
			this.#opts.system ?? DEFAULT_SYSTEM,
			...(editTool ? [EDIT_GUIDANCE] : []),
			...(this.#opts.skills ?? []),
		].join('\n\n---\n\n');
		const conceptCtx = [
			`The vertical under construction lives at: ${input.verticalDir}`,
			`Approved concept:\n${input.concept}`,
		].join('\n\n---\n\n');

		const history = (input.history ?? []).map(
			(t): ModelMessage => ({ role: t.role, content: t.text }),
		);

		const userText = [
			...(input.workspaceBrief
				? [
						`Project map (current — trust it; never call list_files to re-discover it):\n${input.workspaceBrief}`,
					]
				: []),
			...(input.gateReport
				? [
						`Tier-1 gates are RED from the previous turn — the tree is broken until these pass. Getting them green is part of whatever you do next:\n${input.gateReport}`,
					]
				: []),
			input.message,
		].join('\n\n---\n\n');

		const messages: ModelMessage[] = [
			{
				role: 'system',
				content: stable,
				...(anthropic ? { providerOptions: CACHE_PO } : {}),
			},
			{
				role: 'system',
				content: conceptCtx,
				...(anthropic ? { providerOptions: CACHE_PO } : {}),
			},
			...history,
			{ role: 'user', content: userText },
		];

		let steps = 0;
		// Per-request usage, one entry per step — the host needs it because tier
		// pricing is all-or-nothing per REQUEST (pricing happens host-side; this
		// file stays provider- and price-agnostic per D-49).
		const stepUsage: StepUsage[] = [];
		// The final step's finishReason. 'tool-calls' after a clean stream end
		// means stopWhen cut the loop while the model still wanted tools — the
		// turn is unfinished, and both the UI and the next turn's history must
		// say so (the 'truncated' event below).
		let lastFinishReason: string | null = null;

		const explain = (err: unknown): string =>
			this.#opts.explainError?.(err) ?? apiErrorFacts(err).message;

		const maxSteps = this.#opts.maxSteps ?? 40;
		const maxTokens = this.#opts.maxTokens;
		const maxRetries = this.#opts.maxRetries ?? 5;
		const MAX_CONDENSATIONS = 2;
		let attempt = 0;
		let condensations = 0;
		// The exact transcript of the most recent request, captured in
		// prepareStep AFTER the dialect transform — on retry it IS the failed
		// request's input, so resuming re-issues that request and nothing else.
		let resumeMessages: ModelMessage[] | null = null;

		// One iteration per provider attempt. A transient failure classifies,
		// backs off, and resumes from the failed request (builder-harness.md H2)
		// — one mid-turn 529 must not kill 30 steps of work. A context overflow
		// condenses the transcript and resumes (H3: mechanical, reactive-only,
		// escalation-capped). Client errors stay fatal; the SDK's own pre-stream
		// retry is disabled (maxRetries: 0) so delays never compound.
		while (true) {
			let streamError: unknown = null;
			try {
				const result = streamText({
					model: this.#opts.model,
					messages: resumeMessages ?? messages,
					// v7 rejects role:'system' inside `messages` by default. We need system
					// MESSAGES (not the `system` string param) because Anthropic prompt
					// caching hangs cacheControl off per-message providerOptions — the
					// stable prefix gets a breakpoint, the volatile context does not.
					allowSystemInMessages: true,
					tools,
					// Two ceilings, and they catch different runaways: steps bounds a
					// model that will not stop calling tools, tokens bounds one whose
					// individual steps have grown enormous.
					stopWhen: maxTokens
						? [stepCountIs(Math.max(1, maxSteps - steps)), tokenBudgetIs(maxTokens)]
						: stepCountIs(Math.max(1, maxSteps - steps)),
					maxRetries: 0,
					// Step-economies, mutually exclusive by dialect (see the helpers):
					// Anthropic gets a moving cache breakpoint; qwen passes through
					// untouched (its markers are injected at the wire by the host, and
					// its cache needs the byte-stable transcript); everyone else gets
					// stale tool payloads pruned. Returned messages carry forward, so
					// stubs persist and the next step only touches newly-superseded
					// entries.
					prepareStep: ({ messages: stepMessages }) => {
						const prepared = anthropic
							? withMovingBreakpoint(stepMessages)
							: qwenDialect
								? stepMessages
								: pruneStalePayloads(stepMessages);
						resumeMessages = prepared;
						return { messages: prepared };
					},
					// The SDK's default onError console.errors the whole object. We surface
					// errors as BuildEvents, so the default is pure noise in a chat pane.
					onError: () => {},
					...(this.#opts.temperature !== undefined ? { temperature: this.#opts.temperature } : {}),
					...(this.#opts.topP !== undefined ? { topP: this.#opts.topP } : {}),
				...(hasProviderOptions ? { providerOptions } : {}),
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
						case 'finish-step': {
							steps += 1;
							lastFinishReason = part.finishReason;
							const u = part.usage;
							if (u.inputTokens != null || u.outputTokens != null) {
								const cacheRead = u.inputTokenDetails.cacheReadTokens;
								const cacheWrite = u.inputTokenDetails.cacheWriteTokens;
								stepUsage.push({
									inputTokens: u.inputTokens ?? 0,
									outputTokens: u.outputTokens ?? 0,
									...(cacheRead != null ? { cachedInputTokens: cacheRead } : {}),
									...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
								});
							}
							break;
						}
						case 'error':
							streamError = part.error ?? new Error('provider stream error');
							break;
						default:
							break;
					}
				}
				while (queue.length) yield queue.shift() as BuildEvent;

				if (streamError === null) {
					// A clean end with the model still mid-tool-call = stopWhen fired:
					// the step ceiling cut the turn, it did not finish (H6). Said out
					// loud, because a silent cut reads as "done" everywhere downstream.
					if (lastFinishReason === 'tool-calls') {
						// WHICH ceiling fired matters to whoever reads the log: a step
						// cut-off usually means the work was big, a budget cut-off almost
						// always means the turn was looping.
						const spent = uncachedEquivalent(stepUsage.map((u) => ({ usage: asUsage(u) })));
						// `reason` is omitted for the step ceiling, which is what
						// `truncated` meant before a budget existed — consumers that
						// predate this keep reading it unchanged.
						yield maxTokens && spent >= maxTokens
							? { type: 'truncated', steps, maxSteps, reason: 'tokens', spent, budget: maxTokens }
							: { type: 'truncated', steps, maxSteps };
					}
					yield this.#usageEvent(result, steps, stepUsage);
					return;
				}
			} catch (err) {
				while (queue.length) yield queue.shift() as BuildEvent;
				streamError = err;
			}

			const decision = classifyProviderError(streamError);

			// Context overflow (H3): drop old tool payloads and re-issue the failed
			// request. Escalation-capped, and gated on a MEANINGFUL shrink (≥10%) —
			// re-sending a barely-smaller transcript is a spin, not a recovery. An
			// overflow with nothing to drop (oversized prefix, first request) falls
			// through to the fatal path with the provider's own message.
			if (decision.overflow && condensations < MAX_CONDENSATIONS && resumeMessages) {
				const before: number = JSON.stringify(resumeMessages).length;
				// Escalation ladder (OpenHands' shape): first preserve the working-set
				// tail; if that frees too little — or the whole transcript IS the tail
				// — drop every droppable payload. Only then give up.
				const gentle: CondenseResult | null = condenseTranscript(resumeMessages);
				const condensed: CondenseResult | null =
					gentle && gentle.savedChars >= before * 0.1
						? gentle
						: condenseTranscript(resumeMessages, { keepTail: 0 });
				if (condensed && condensed.savedChars >= before * 0.1) {
					condensations += 1;
					resumeMessages = condensed.messages;
					yield {
						type: 'retry',
						attempt: condensations,
						maxAttempts: MAX_CONDENSATIONS,
						delayMs: 0,
						reason: 'context overflow — condensed old tool output',
					};
					continue;
				}
			}

			if (decision.retryable && attempt < maxRetries && !input.signal?.aborted) {
				attempt += 1;
				const delayMs = retryDelayMs(attempt, decision);
				yield { type: 'retry', attempt, maxAttempts: maxRetries, delayMs, reason: decision.reason };
				await abortableSleep(delayMs, input.signal);
				if (input.signal?.aborted) return;
				continue;
			}

			// Exhausted or non-retryable. Steps that DID finish were billed by the
			// provider — meter them before the fatal error, never silently drop.
			if (stepUsage.length) yield this.#usageEvent(null, steps, stepUsage);
			yield { type: 'error', message: explain(streamError), fatal: true };
			return;
		}
	}

	/**
	 * The turn's usage event. With retries a turn spans several streams, so the
	 * per-step records are the ground truth: totals are their SUM (a failed
	 * attempt's finished steps were still billed). `result.totalUsage` is only
	 * consulted when no step reported usage — and never after a failure, where
	 * the SDK rejects it with a vague "No output generated".
	 */
	async #usageEvent(
		result: { totalUsage: PromiseLike<LanguageModelUsage> } | null,
		steps: number,
		stepUsage: readonly StepUsage[],
	): Promise<BuildEventOf<'usage'>> {
		if (stepUsage.length === 0 && result) {
			const usage = await result.totalUsage;
			const cacheRead = usage.inputTokenDetails.cacheReadTokens;
			const cacheWrite = usage.inputTokenDetails.cacheWriteTokens;
			return {
				type: 'usage',
				inputTokens: usage.inputTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0,
				steps,
				...(cacheRead != null ? { cachedInputTokens: cacheRead } : {}),
				...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
			};
		}
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheRead: number | undefined;
		let cacheWrite: number | undefined;
		for (const s of stepUsage) {
			inputTokens += s.inputTokens;
			outputTokens += s.outputTokens;
			if (s.cachedInputTokens != null) cacheRead = (cacheRead ?? 0) + s.cachedInputTokens;
			if (s.cacheWriteTokens != null) cacheWrite = (cacheWrite ?? 0) + s.cacheWriteTokens;
		}
		return {
			type: 'usage',
			inputTokens,
			outputTokens,
			steps,
			...(cacheRead != null ? { cachedInputTokens: cacheRead } : {}),
			...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
			...(stepUsage.length ? { stepUsage: [...stepUsage] } : {}),
		};
	}
}

/** Sleep that ends early on abort — a cancelled turn must not serve out its backoff. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const t = setTimeout(done, ms);
		function done(): void {
			clearTimeout(t);
			signal?.removeEventListener('abort', done);
			resolve();
		}
		signal?.addEventListener('abort', done);
	});
}
