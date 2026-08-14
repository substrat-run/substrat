/**
 * The chat pane — renders the same `BuildEvent` union the terminal driver does.
 * Assistant text merges into bubbles; everything else renders as event lines, so
 * the user sees files written, commands run, gates and commits as they happen.
 */
import { useEffect, useRef, useState } from 'react';
import type { BuildEvent, PlanAssumption } from './api.js';
import { BuildPanel } from './BuildPanel.js';

export type ChatItem =
	| { kind: 'user'; text: string }
	| { kind: 'assistant'; text: string }
	| { kind: 'event'; e: BuildEvent };

export function appendEvent(items: ChatItem[], e: BuildEvent): ChatItem[] {
	if (e.type === 'assistant-text') {
		const last = items[items.length - 1];
		if (last?.kind === 'assistant') {
			return [...items.slice(0, -1), { kind: 'assistant', text: last.text + e.text }];
		}
		return [...items, { kind: 'assistant', text: e.text }];
	}
	return [...items, { kind: 'event', e }];
}

/** Event types that collapse into a Lovable-style tool-call group. */
const GROUPABLE = new Set<BuildEvent['type']>(['tool-call', 'file-written', 'command', 'check']);

type Rendered =
	| { kind: 'item'; item: ChatItem; index: number }
	| { kind: 'group'; events: BuildEvent[]; index: number };

/** Batches consecutive groupable events; everything else passes through. */
function groupItems(items: ChatItem[]): Rendered[] {
	const out: Rendered[] = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i] as ChatItem;
		if (item.kind === 'event' && GROUPABLE.has(item.e.type)) {
			const last = out[out.length - 1];
			if (last?.kind === 'group') last.events.push(item.e);
			else out.push({ kind: 'group', events: [item.e], index: i });
		} else {
			out.push({ kind: 'item', item, index: i });
		}
	}
	return out;
}

function groupSummary(events: BuildEvent[]): { label: string; meta: string } {
	const files = new Set(
		events.filter((e): e is Extract<BuildEvent, { type: 'file-written' }> => e.type === 'file-written')
			.map((e) => e.path),
	);
	const label = files.size > 0
		? `Edited ${files.size} file${files.size === 1 ? '' : 's'}`
		: 'Explored the project';
	return { label, meta: `${events.length} call${events.length === 1 ? '' : 's'}` };
}

function groupRow(e: BuildEvent): { text: string; bad: boolean } {
	switch (e.type) {
		case 'tool-call':
			return { text: `${e.tool}: ${e.summary}`, bad: false };
		case 'file-written':
			return { text: `wrote ${e.path} (${e.bytes}b)`, bad: false };
		case 'command':
			return { text: `$ ${e.cmd} → ${e.exitCode}`, bad: e.exitCode !== 0 };
		case 'check':
			return { text: `${e.result.name}: ${e.result.status}`, bad: e.result.status === 'failed' };
		default:
			return { text: '', bad: false };
	}
}

/** A collapsed tool-call group; expands on click, streams open while live. */
function ToolGroup(props: { events: BuildEvent[]; live: boolean }) {
	const [open, setOpen] = useState(false);
	const expanded = open || props.live;
	const { label, meta } = groupSummary(props.events);
	return (
		<div className="tool-group">
			<div className="tool-group-head" onClick={() => setOpen((o) => !o)}>
				<span className="chev">{expanded ? '▾' : '▸'}</span>
				<span className="label">{props.live ? `${label}…` : label}</span>
				<span className="meta">{meta}</span>
			</div>
			{expanded && (
				<div className="tool-group-body">
					{props.events.map((e, i) => {
						const { text, bad } = groupRow(e);
						return <div key={i} className={bad ? 'bad' : ''}>{text}</div>;
					})}
				</div>
			)}
		</div>
	);
}

function eventLine(e: BuildEvent): { text: string; cls: string } {
	switch (e.type) {
		case 'tool-call':
			return { text: `${e.tool}: ${e.summary}`, cls: '' };
		case 'file-written':
			return { text: `wrote ${e.path}`, cls: '' };
		case 'command':
			return { text: `$ ${e.cmd} → ${e.exitCode}`, cls: e.exitCode === 0 ? '' : 'error' };
		case 'check':
			return { text: `${e.result.name}: ${e.result.status}`, cls: '' };
		case 'gates':
			return {
				text: e.run.ok ? '✓ gates green' : '✗ gates red',
				cls: e.run.ok ? 'commit' : 'error',
			};
		case 'commit':
			return { text: `committed ${e.sha.slice(0, 8)} (${e.summary})`, cls: 'commit' };
		case 'preview-ready':
			return { text: `preview ${e.url}`, cls: '' };
		case 'needs-review':
			return { text: `⚠ ${e.kind} diff needs review`, cls: 'error' };
		case 'usage':
			return { text: usageLine(e), cls: '' };
		case 'plan':
			return { text: `plan: ${e.summary} (${e.files.length} files)`, cls: '' };
		case 'thinking':
			return { text: 'thinking…', cls: '' };
		case 'error':
			return { text: e.message, cls: 'error' };
		default:
			return { text: JSON.stringify(e), cls: '' };
	}
}

/** 1234 → "1.2k", 1234567 → "1.2M" — token counts, not bytes. */
function fmtTok(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

/**
 * The per-turn bill, honestly labelled: the cached share is what the provider
 * served from prompt cache (~10% price on Anthropic). No cache figure means the
 * provider reported none — "not measured", never "0%".
 */
function usageLine(e: Extract<BuildEvent, { type: 'usage' }>): string {
	const cached =
		e.cachedInputTokens != null && e.inputTokens > 0
			? ` (${Math.round((100 * e.cachedInputTokens) / e.inputTokens)}% cached)`
			: '';
	return `${e.steps} step${e.steps === 1 ? '' : 's'} · ${fmtTok(e.inputTokens)} in${cached} · ${fmtTok(e.outputTokens)} out`;
}

/**
 * Numbered options written into PLAIN assistant text — the fallback for models
 * that answer in prose instead of calling ask_user. Recognised only when the
 * message ends in a run of sequentially numbered lines starting at 1, so a
 * mid-text enumeration ("the three layer rules are…") does not sprout buttons.
 */
export function extractInlineOptions(text: string): string[] | null {
	const lines = text.trimEnd().split('\n');
	const options: string[] = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /^\s*(\d{1,2})[.)]\s+(.+)$/.exec(lines[i] ?? '');
		if (!m) {
			if (options.length > 0 && (lines[i] ?? '').trim() === '') continue; // blank lines between options
			break;
		}
		options.unshift(m[2]?.replace(/\*\*/g, '').trim() ?? '');
		if (m[1] === '1') {
			return options.length >= 2 ? options : null;
		}
	}
	return null;
}

/**
 * A model question with clickable options (the ask_user tool, §interview).
 * Clicking sends "N. <option>" — the number survives so a typed bare number
 * means the same thing, and the transcript reads identically either way.
 */
function Question(props: {
	e: Extract<BuildEvent, { type: 'question' }>;
	answered: boolean;
	onPick: (text: string) => void;
}) {
	return (
		<div className="msg assistant">
			<div style={{ marginBottom: 8 }}>{props.e.question}</div>
			<div className="model-list">
				{props.e.options.map((opt, i) => (
					<button
						key={i}
						disabled={props.answered}
						onClick={() => props.onPick(`${i + 1}. ${opt}`)}
					>
						{i + 1}. {opt}
					</button>
				))}
			</div>
			{!props.answered && (
				<div className="evt" style={{ padding: '6px 0 0' }}>
					…or type your own answer below
				</div>
			)}
		</div>
	);
}

/** Event types the BuildPanel visualises — suppressed as individual rows when a
 * plan governs the current turn, so the work is not rendered twice. */
const PANEL_TYPES = new Set<BuildEvent['type']>([
	'plan', 'tool-call', 'file-written', 'command', 'check', 'commit', 'thinking',
]);

/**
 * The live tail while a turn runs. Animated only while the transport is
 * demonstrably alive (bytes within the heartbeat window); past that it switches
 * to a measured stall warning — never an animation over silence, which is how a
 * UI looks alive while being dead.
 */
function WorkingIndicator(props: { label: string; silentForS: number }) {
	// Heartbeats arrive every 10s, so >15s of true silence means the connection
	// or the server is actually gone quiet — say so, with the real number.
	if (props.silentForS >= 15) {
		return (
			<div className="working stalled">
				no signal for {props.silentForS}s — connection open but nothing arriving; if this
				persists, the turn may have died (every completed turn commits, so nothing done is lost)
			</div>
		);
	}
	return (
		<div className="working">
			<span className="dots"><i /><i /><i /></span>
			{props.label}…
		</div>
	);
}

/**
 * Session total under the transcript — the sum of every turn's usage event in
 * THIS browser session (reloads start at zero; the per-turn lines in the
 * transcript remain the durable record). Hidden until something was measured.
 */
function SessionUsage(props: { items: ChatItem[] }) {
	let inTok = 0;
	let outTok = 0;
	let cached = 0;
	for (const it of props.items) {
		if (it.kind === 'event' && it.e.type === 'usage') {
			inTok += it.e.inputTokens;
			outTok += it.e.outputTokens;
			cached += it.e.cachedInputTokens ?? 0;
		}
	}
	if (inTok + outTok === 0) return null;
	const pct = cached > 0 && inTok > 0 ? ` · ${Math.round((100 * cached) / inTok)}% cached` : '';
	return (
		<div className="evt session-usage">
			session: {fmtTok(inTok)} in · {fmtTok(outTok)} out{pct}
		</div>
	);
}

export function Chat(props: {
	items: ChatItem[];
	busy: boolean;
	liveness: { label: string; silentForS: number };
	queued: readonly PlanAssumption[];
	onToggleChip: (a: PlanAssumption) => void;
	onSend: (message: string) => void;
	onAbort: () => void;
}) {
	const [draft, setDraft] = useState('');
	const bottom = useRef<HTMLDivElement>(null);

	useEffect(() => {
		bottom.current?.scrollIntoView({ behavior: 'smooth' });
	}, [props.items]);

	// The current turn = everything after the last user message. If it contains
	// a plan event, the BuildPanel owns that turn's work events.
	const lastUser = (() => {
		for (let i = props.items.length - 1; i >= 0; i--) {
			if (props.items[i]?.kind === 'user') return i;
		}
		return -1;
	})();
	const turnEvents = props.items
		.slice(lastUser + 1)
		.filter((it): it is Extract<ChatItem, { kind: 'event' }> => it.kind === 'event')
		.map((it) => it.e);
	const planTurn = turnEvents.some((e) => e.type === 'plan');
	const planAt = planTurn
		? props.items.findIndex((it, i) => i > lastUser && it.kind === 'event' && it.e.type === 'plan')
		: -1;

	function send(): void {
		const text = draft.trim();
		if (!text || props.busy) return;
		setDraft('');
		props.onSend(text);
	}

	return (
		<>
			<div className="messages">
				{props.items.length === 0 && (
					<div className="evt">What would you like to build today?</div>
				)}
				{groupItems(props.items).map((r) => {
					const isLast = r.index + (r.kind === 'group' ? r.events.length : 1) >= props.items.length;
					// A plan-governed turn: the panel renders once (at the plan event's
					// position) and owns every work event after it in this turn.
					if (planAt !== -1 && r.index >= planAt) {
						if (r.index === planAt) {
							return (
								<BuildPanel
									key="panel"
									events={turnEvents}
									live={props.busy}
									queued={props.queued}
									onToggleChip={props.onToggleChip}
								/>
							);
						}
						if (r.kind === 'group') return null;
						if (r.item.kind === 'event' && PANEL_TYPES.has(r.item.e.type)) return null;
					}
					if (r.kind === 'group') {
						return <ToolGroup key={r.index} events={r.events} live={props.busy && isLast} />;
					}
					const { item, index: i } = r;
					if (item.kind === 'user') return <div key={i} className="msg user">{item.text}</div>;
					if (item.kind === 'assistant') {
						// Fallback clickability: a prose message ending in "1. … 2. …"
						// gets buttons too, but only while it is the live question.
						const live = !props.busy && isLast;
						const opts = live ? extractInlineOptions(item.text) : null;
						return (
							<div key={i} className="msg assistant">
								{item.text}
								{opts && (
									<div className="model-list" style={{ marginTop: 8 }}>
										{opts.map((opt, n) => (
											<button key={n} onClick={() => props.onSend(`${n + 1}. ${opt}`)}>
												{n + 1}. {opt.length > 80 ? `${opt.slice(0, 77)}…` : opt}
											</button>
										))}
									</div>
								)}
							</div>
						);
					}
					if (item.e.type === 'question') {
						// Only the last question is live; earlier ones are transcript.
						const answered = props.busy || !isLast;
						return (
							<Question key={i} e={item.e} answered={answered} onPick={props.onSend} />
						);
					}
					// The WorkingIndicator is the live tail; thinking rows as text would
					// duplicate it, statically — the "looks dead" bug.
					if (item.e.type === 'thinking') return null;
					const { text, cls } = eventLine(item.e);
					return <div key={i} className={`evt ${cls}`}>{text}</div>;
				})}
				{props.busy && (
					<WorkingIndicator label={props.liveness.label} silentForS={props.liveness.silentForS} />
				)}
				<div ref={bottom} />
			</div>
			<SessionUsage items={props.items} />
			<div className="composer">
				<textarea
					rows={2}
					placeholder={props.busy ? 'turn running…' : 'Describe what to build or change…'}
					value={draft}
					disabled={props.busy}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							send();
						}
					}}
				/>
				{props.busy ? (
					<button onClick={props.onAbort}>stop</button>
				) : (
					<button onClick={send} disabled={!draft.trim()}>send</button>
				)}
			</div>
		</>
	);
}
