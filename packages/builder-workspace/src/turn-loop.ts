/**
 * The host turn loop — pass → continuations → checks → capped repair (#974).
 *
 * Three hosts run a generator turn (the local server, the hosted DO, the dev
 * CLI) and each used to carry its own copy of this loop. One copy grew the
 * abort guard from #676 and the other two did not, so a stopped hosted turn
 * kept burning continuations and repairs. What differs between hosts is HOW a
 * pass runs (which generator, which events, usage metering) and what a check
 * does beside the gates (emit, bundle, print) — those are the two hooks. The
 * loop itself, its caps (gates.ts) and its abort behaviour exist once.
 */
import {
	continuationPrompt,
	gateRepairPrompt,
	gateReport,
	MAX_CONTINUATIONS,
	MAX_GATE_REPAIRS,
	repairNeeded,
} from './gates.js';
import type { TurnResult } from './turn.js';

export interface TurnLoopHooks {
	/**
	 * One generator pass; resolves to whether the step ceiling cut it mid-work.
	 * `carriedReport` is the previous TURN's red-gate state — first pass only;
	 * repair prompts already embed the fresh report.
	 */
	readonly runPass: (text: string, carriedReport?: string) => Promise<boolean>;
	/** Gates + commit for one pass (commit-per-turn lives above the seam, §3). */
	readonly runChecks: (label: string) => Promise<TurnResult>;
	/**
	 * Stops the loop between passes: no further continuation and no further
	 * repair once aborted. Cancelling a pass already in flight is the host's job
	 * (it hands the same signal to its generator).
	 */
	readonly signal?: AbortSignal | undefined;
	readonly onContinuation?: ((attempt: number, max: number) => void) | undefined;
	readonly onRepair?: ((attempt: number, max: number) => void) | undefined;
}

export interface TurnLoopInput {
	readonly message: string;
	readonly turnNo: number;
	/** The previous turn's red-gate report, carried into the first pass only. */
	readonly lastGateReport?: string | undefined;
}

export interface TurnLoopResult {
	/** The last check of the turn — after the final repair, if any ran. */
	readonly turn: TurnResult;
	/** What the NEXT turn opens with — undefined the moment the tree goes green. */
	readonly lastGateReport: string | undefined;
	readonly continuations: number;
	readonly repairs: number;
}

/**
 * A truncated pass is "not done yet", not "done but broken" — it is continued
 * before the gates run, so the repair budget stays reserved for genuine
 * breakage (MAX_CONTINUATIONS). The cap is per turn: repair passes draw from
 * the same continuation budget as the first pass.
 *
 * Red gates are the model's problem, not the builder's (H5): capped repair
 * attempts, only while attempts make progress (changed files) — a chat-only
 * turn over a pre-existing red tree must not burn budget, and `blocked` gates
 * never trigger repair (the checker crashed, not the code).
 */
export async function runTurnLoop(input: TurnLoopInput, hooks: TurnLoopHooks): Promise<TurnLoopResult> {
	const { signal } = hooks;
	let continuations = 0;
	const runToCompletion = async (text: string, carriedReport?: string): Promise<void> => {
		let truncated = await hooks.runPass(text, carriedReport);
		while (truncated && continuations < MAX_CONTINUATIONS && !signal?.aborted) {
			continuations += 1;
			hooks.onContinuation?.(continuations, MAX_CONTINUATIONS);
			truncated = await hooks.runPass(continuationPrompt(continuations, MAX_CONTINUATIONS));
		}
	};

	await runToCompletion(input.message, input.lastGateReport);
	let turn = await hooks.runChecks(`studio turn ${input.turnNo}: ${input.message.slice(0, 60)}`);

	let repairs = 0;
	for (
		let attempt = 1;
		attempt <= MAX_GATE_REPAIRS &&
		repairNeeded(turn.gates) &&
		turn.changedFiles.length > 0 &&
		!signal?.aborted;
		attempt++
	) {
		repairs = attempt;
		hooks.onRepair?.(attempt, MAX_GATE_REPAIRS);
		await runToCompletion(gateRepairPrompt(turn.gates, attempt, MAX_GATE_REPAIRS));
		turn = await hooks.runChecks(`studio turn ${input.turnNo} · gate repair ${attempt}/${MAX_GATE_REPAIRS}`);
	}

	return { turn, lastGateReport: gateReport(turn.gates) ?? undefined, continuations, repairs };
}
