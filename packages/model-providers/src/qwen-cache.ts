/**
 * Explicit context-cache markers for the qwen dialect (H4 follow-up).
 *
 * DashScope's cache is per-model: qwen3.8-max caches implicitly, but the flash
 * tier caches ONLY when the request carries explicit Anthropic-style
 * `cache_control: {type:'ephemeral'}` markers on CONTENT BLOCKS — verified
 * against the token-plan gateway 2026-08-15: block-level markers cache ~99% of
 * the prefix (creation billed at 125%, hits at 10%, 5-minute TTL, ≥1024-token
 * blocks, max 4 markers/request); message-level markers are silently ignored,
 * and `@ai-sdk/openai-compatible` can only emit message-level ones. So the
 * markers are injected here, at the wire: a fetch wrapper rewrites each
 * chat/completions body just-in-time.
 *
 * Placement is the same strategy `withMovingBreakpoint` runs for Claude —
 * system prefix + the request's last message — and because the rewrite is
 * stateless per request, the "moving" part comes free: each step marks its own
 * tail, and the previous step's mark simply never existed on the wire again.
 * Explicit markers are sent to ALL qwen models (max included): explicit read
 * price (10%) undercuts the implicit discount, and the behavior is
 * deterministic instead of best-effort.
 *
 * Worker-safe on purpose: both provider hosts (providers.ts, the node CLI, and
 * providers-worker.ts, the hosted agent) wire this into `createOpenAICompatible`.
 */

const CACHE_CONTROL = { type: 'ephemeral' } as const;

/** DashScope allows 4 markers per request; one is reserved for the tail. */
const MAX_SYSTEM_MARKERS = 3;

interface WireMessage {
	role?: unknown;
	content?: unknown;
	[key: string]: unknown;
}

type WireBlock = Record<string, unknown>;

/** Marks a message's content in block form. Returns null when it cannot carry
 * a marker (no content — e.g. an assistant message that is only tool_calls). */
function markMessage(m: WireMessage): WireMessage | null {
	if (typeof m.content === 'string') {
		// DashScope rejects empty text blocks; an empty string cannot cache anyway.
		if (m.content === '') return null;
		return {
			...m,
			content: [{ type: 'text', text: m.content, cache_control: CACHE_CONTROL }],
		};
	}
	if (Array.isArray(m.content) && m.content.length > 0) {
		const blocks = m.content as WireBlock[];
		const last = blocks[blocks.length - 1];
		if (typeof last !== 'object' || last === null) return null;
		return {
			...m,
			content: [...blocks.slice(0, -1), { ...last, cache_control: CACHE_CONTROL }],
		};
	}
	return null;
}

/**
 * The body transform: marker on each system message (the cross-turn-stable
 * prefix — the only part reusable between turns) and on the last markable
 * message (the within-turn moving breakpoint — each tool-loop step re-reads
 * everything before its own tail from cache). Non-chat bodies pass through
 * untouched.
 */
export function withQwenCacheMarkers(body: unknown): unknown {
	const b = body as { messages?: unknown } | null;
	if (b === null || typeof b !== 'object' || !Array.isArray(b.messages)) return body;
	const messages = (b.messages as WireMessage[]).slice();

	// The moving tail marker first — it is the one that compounds. Walk back
	// past messages that cannot carry a block (tool_calls-only assistants).
	let tail = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as WireMessage;
		if (msg.role === 'system') break; // nothing but prefix left — its own markers below
		const marked = markMessage(msg);
		if (marked) {
			messages[i] = marked;
			tail = i;
			break;
		}
	}

	let budget = MAX_SYSTEM_MARKERS;
	for (let i = 0; i < messages.length && budget > 0; i++) {
		const msg = messages[i] as WireMessage;
		if (msg.role !== 'system' || i === tail) continue;
		const marked = markMessage(msg);
		if (marked) {
			messages[i] = marked;
			budget -= 1;
		}
	}

	return { ...(body as object), messages };
}

type FetchLike = typeof globalThis.fetch;

/**
 * Fetch wrapper for the qwen provider: rewrites POST chat/completions bodies
 * through `withQwenCacheMarkers`. Anything unexpected — non-chat URL, a
 * Request-object body, unparseable JSON — passes through unchanged: a request
 * without markers is merely uncached, never broken.
 */
export function qwenCacheFetch(inner?: FetchLike): FetchLike {
	const base: FetchLike = inner ?? ((...args) => globalThis.fetch(...args));
	// Typed via the fetch signature itself — this file compiles under both the
	// node and workers tsconfigs, which disagree on the DOM lib types.
	const wrapped = async (
		input: Parameters<FetchLike>[0],
		init?: Parameters<FetchLike>[1],
	): Promise<Response> => {
		const url =
			typeof input === 'string'
				? input
				: ((input as { url?: string }).url ?? String(input));
		if (!url.includes('/chat/completions') || typeof init?.body !== 'string') {
			return base(input, init);
		}
		try {
			const body = JSON.stringify(withQwenCacheMarkers(JSON.parse(init.body)));
			return base(input, { ...init, body });
		} catch {
			return base(input, init);
		}
	};
	return wrapped as FetchLike;
}
