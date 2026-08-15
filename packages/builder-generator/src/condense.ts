/**
 * Mechanical transcript condensation for context-overflow recovery —
 * builder-harness.md H3 (#663 row 5).
 *
 * OpenHands' masking shape, deliberately NOT their LLM-summarizing condenser:
 * deterministic, free, and incapable of overflowing itself (a summarizer call
 * over an oversized transcript is the exact failure being recovered from).
 * What actually blows a build turn's context is accumulated TOOL traffic —
 * whole-file write bodies and read/command outputs — so that is what gets
 * dropped, oldest first, structure preserved:
 *
 *   - system and user messages are never touched (prompt, skills, concept,
 *     history, the turn instruction — all load-bearing);
 *   - the newest `keepTail` messages stay verbatim (the model's working set);
 *   - older assistant tool-call payloads (write_file bodies, edit strings)
 *     and tool-result values become one-line stubs — the tool_call/tool_result
 *     PAIRING survives, so the replayed transcript stays provider-valid
 *     (OpenHands' tool_call_matching property, enforced here by construction).
 *
 * Reactive-only by design (RFC row 5): this runs when a provider actually
 * rejects the transcript, which is maximal reluctance on every dialect — on
 * Anthropic the prefix cache is already forfeit at that point, so there is
 * nothing left to protect. A proactive token-threshold trigger stays out
 * until evals can measure it against the cache cost it would incur.
 */
import type { ModelMessage } from 'ai';

export const CONDENSE_STUB =
	'[dropped to recover from context overflow — re-read the file if you need it]';

export interface CondenseResult {
	readonly messages: ModelMessage[];
	/** Characters removed — the caller gates the retry on a meaningful shrink. */
	readonly savedChars: number;
}

/**
 * Stub old tool payloads outside the tail. Returns null when there is nothing
 * to drop — an overflow with an undroppable transcript (an oversized prefix,
 * a first-request overflow) cannot be recovered here and should stay fatal.
 */
export function condenseTranscript(
	messages: ModelMessage[],
	opts: { keepTail?: number } = {},
): CondenseResult | null {
	const keepTail = opts.keepTail ?? 6;
	const cutoff = Math.max(0, messages.length - keepTail);
	let savedChars = 0;

	const stubText = (value: string): string => {
		savedChars += value.length - CONDENSE_STUB.length;
		return CONDENSE_STUB;
	};

	const out = messages.map((m, mi): ModelMessage => {
		if (mi >= cutoff) return m;
		if (m.role !== 'assistant' && m.role !== 'tool') return m;
		if (!Array.isArray(m.content)) return m;

		let touched = false;
		const content = m.content.map((p) => {
			if (m.role === 'assistant' && p.type === 'tool-call') {
				const input = p.input as Record<string, unknown> | null;
				if (p.toolName === 'write_file' && typeof input?.['content'] === 'string') {
					const body = input['content'] as string;
					if (body.length > CONDENSE_STUB.length) {
						touched = true;
						return { ...p, input: { ...input, content: stubText(body) } };
					}
				}
				if (p.toolName === 'edit_file') {
					const oldS = input?.['oldString'];
					const newS = input?.['newString'];
					if (
						(typeof oldS === 'string' && oldS.length > CONDENSE_STUB.length) ||
						(typeof newS === 'string' && newS.length > CONDENSE_STUB.length)
					) {
						touched = true;
						return {
							...p,
							input: {
								...input,
								...(typeof oldS === 'string' && oldS.length > CONDENSE_STUB.length
									? { oldString: stubText(oldS) }
									: {}),
								...(typeof newS === 'string' && newS.length > CONDENSE_STUB.length
									? { newString: stubText(newS) }
									: {}),
							},
						};
					}
				}
			} else if (m.role === 'tool' && p.type === 'tool-result') {
				const output = p.output as { type?: string; value?: unknown };
				if (
					(output?.type === 'text' || output?.type === 'json') &&
					typeof output.value === 'string' &&
					output.value.length > CONDENSE_STUB.length
				) {
					touched = true;
					return { ...p, output: { type: output.type, value: stubText(output.value) } };
				}
			}
			return p;
		});
		return touched ? ({ ...m, content } as ModelMessage) : m;
	});

	return savedChars > 0 ? { messages: out, savedChars } : null;
}
