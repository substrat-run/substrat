/**
 * `BuildEvent` — builder-studio.md §5.2.
 *
 * THIS UNION IS THE PROVIDER BOUNDARY. It is ours, not any SDK's stream shape:
 * the chat pane, the diff view, the preview and the review gate all render off
 * it and never see a provider type. That is what makes a second generator a
 * contained piece of work rather than a permanent tax on the first (D-49).
 *
 * Adding a field here is cheap; leaking a provider type through it is not.
 */
import type { GateResult, GateRun } from '@substrat-run/builder-workspace';

/**
 * One default the plan committed to, phrased as assumption + alternative — never
 * an open question (the build is already writing the files; asking "do you want
 * a UI?" would make the product look like it isn't reading itself). Ordered by
 * how expensive the alternative is to adopt later: surface shape and permission
 * model first, styling never.
 */
export interface PlanAssumption {
	/** Stable id for queueing and tap metrics. */
	readonly id: string;
	/** Where our defaults might be wrong — the tap-rate dimension. */
	readonly category: 'surface' | 'roles' | 'seed' | 'engines' | 'stack' | 'other';
	/** What the plan assumed, e.g. "React app skin served by the API (the demo pattern)". */
	readonly assumption: string;
	/** The one-shot reversal, e.g. "API-only — skip the web app". */
	readonly alternative: string;
	readonly reversalCost: 'high' | 'medium' | 'low';
}

export type BuildEvent =
	/** Assistant prose destined for the chat pane. */
	| { readonly type: 'assistant-text'; readonly text: string }
	/** The model decided to call a workspace tool. Emitted before execution. */
	| { readonly type: 'tool-call'; readonly tool: string; readonly summary: string }
	| { readonly type: 'file-written'; readonly path: string; readonly bytes: number }
	| { readonly type: 'command'; readonly cmd: string; readonly exitCode: number }
	| { readonly type: 'check'; readonly result: GateResult }
	| { readonly type: 'gates'; readonly run: GateRun }
	| { readonly type: 'commit'; readonly sha: string; readonly summary: string }
	| { readonly type: 'preview-ready'; readonly url: string }
	/**
	 * A human checkpoint (§6). `kind` selects which of CLAUDE.md's two
	 * checkpoints this is; the studio renders it and blocks on it.
	 */
	| {
			readonly type: 'needs-review';
			readonly kind: 'migration' | 'permission';
			readonly diff: string;
	  }
	/**
	 * Structured build plan — the model's first act on a substantial build turn
	 * (the propose_plan tool). One call, same run, no second model pass. The UI
	 * renders the file list as tick-off rows and `assumptions` as tappable chips;
	 * everything in it is a commitment the following tool calls then execute.
	 */
	| {
			readonly type: 'plan';
			readonly summary: string;
			readonly files: readonly { readonly path: string; readonly action: 'create' | 'edit' }[];
			readonly dependencies: readonly string[];
			readonly assumptions: readonly PlanAssumption[];
	  }
	/**
	 * Reasoning is happening — presence only, never content. Exists so the turn's
	 * opening silence shows a truthful "thinking…" tied to actual reasoning
	 * tokens, not a timer.
	 */
	| { readonly type: 'thinking' }
	/**
	 * The model asked the builder one question, with concrete options. The UI
	 * renders the options clickable, always adds a free-text "Other" answer, and
	 * groups several question events from one turn into tabs — so the interview
	 * never degrades into a wall of prose questions.
	 */
	| {
			readonly type: 'question';
			readonly question: string;
			readonly options: readonly string[];
			/** Short tab label (≤ 3 words) for when several questions share a turn. */
			readonly header?: string;
	  }
	/**
	 * The model proposed a project name (the set_project_name tool) — called once,
	 * when the concept is agreed. The studio applies it only while the current
	 * name is still automatic; a user-typed name is never overwritten.
	 */
	| { readonly type: 'project-named'; readonly name: string }
	/**
	 * The build-phase ladder position — emitted by the STUDIO (not the model),
	 * derived from workspace facts (does spec/concept.md exist; does
	 * src/module.ts), at turn start and again when a turn's work moves it. The
	 * UI's phase stepper renders only these, so it shows real state.
	 */
	| { readonly type: 'phase'; readonly phase: 'interview' | 'scaffold' | 'iterate' }
	/**
	 * Turn accounting — what §4.4 says actually dominates the bill. Totals are
	 * summed across ALL tool-loop steps of the turn. `cachedInputTokens` is the
	 * slice of input read from the provider's prompt cache (~10% price on
	 * Anthropic); `cacheWriteTokens` is what was newly written to cache this
	 * turn. Both absent when the provider reports nothing — absence means "not
	 * measured", never "zero".
	 */
	| {
			readonly type: 'usage';
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly steps: number;
			readonly cachedInputTokens?: number;
			readonly cacheWriteTokens?: number;
			/**
			 * Per-request breakdown, one entry per tool-loop step. Present so the
			 * host can price tiered rate cards correctly — tier selection is
			 * all-or-nothing per REQUEST, and the turn totals above land in a tier
			 * no single request reached. Absent when the provider reports no
			 * per-step usage; consumers fall back to the totals.
			 */
			readonly stepUsage?: readonly StepUsage[];
	  }
	| { readonly type: 'error'; readonly message: string; readonly fatal: boolean };

/**
 * One provider request's token counts. `inputTokens` is the request's TOTAL
 * input as the provider reported it, including the cached slices.
 */
export interface StepUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedInputTokens?: number;
	readonly cacheWriteTokens?: number;
}

export type BuildEventOf<T extends BuildEvent['type']> = Extract<BuildEvent, { type: T }>;

/** Compact one-line rendering, for a terminal or a log. */
export function formatEvent(e: BuildEvent): string {
	switch (e.type) {
		case 'assistant-text':
			return e.text;
		case 'tool-call':
			return `· ${e.tool}: ${e.summary}`;
		case 'file-written':
			return `· wrote ${e.path} (${e.bytes}b)`;
		case 'command':
			return `· $ ${e.cmd} → ${e.exitCode}`;
		case 'check':
			return `· ${e.result.name}: ${e.result.status}`;
		case 'gates':
			return e.run.ok ? '✓ gates green' : '✗ gates red';
		case 'commit':
			return `· commit ${e.sha.slice(0, 8)} ${e.summary}`;
		case 'preview-ready':
			return `· preview ${e.url}`;
		case 'needs-review':
			return `⚠ ${e.kind} diff needs review`;
		case 'question':
			return `? ${e.question}\n${e.options.map((o, i) => `    ${i + 1}. ${o}`).join('\n')}`;
		case 'plan':
			return `plan: ${e.summary} (${e.files.length} files, ${e.dependencies.length} deps, ${e.assumptions.length} assumptions)`;
		case 'project-named':
			return `✓ project named "${e.name}"`;
		case 'phase':
			return `· phase: ${e.phase}`;
		case 'thinking':
			return '· thinking…';
		case 'usage':
			return `· ${e.steps} steps, ${e.inputTokens}+${e.outputTokens} tokens${
				e.cachedInputTokens != null && e.inputTokens > 0
					? ` (${Math.round((100 * e.cachedInputTokens) / e.inputTokens)}% cached)`
					: ''
			}`;
		case 'error':
			return `${e.fatal ? '✗' : '!'} ${e.message}`;
	}
}
