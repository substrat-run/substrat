/**
 * The chat pane — renders the same `BuildEvent` union the terminal driver does.
 * Assistant text merges into bubbles; everything else renders as event lines, so
 * the user sees files written, commands run, gates and commits as they happen.
 */
import { type DragEvent as ReactDragEvent, useEffect, useRef, useState } from 'react';
import { api, type BuildEvent, type PlanAssumption } from './api.js';
import { BuildPanel } from './BuildPanel.js';
import { Markdown } from './Markdown.js';

type QuestionEvent = Extract<BuildEvent, { type: 'question' }>;

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
	| { kind: 'group'; events: BuildEvent[]; index: number }
	| { kind: 'questions'; events: QuestionEvent[]; index: number };

/** Batches consecutive groupable events and consecutive questions (one turn's
 * ask_user calls become one tabbed block); everything else passes through. */
function groupItems(items: ChatItem[]): Rendered[] {
	const out: Rendered[] = [];
	for (let i = 0; i < items.length; i++) {
		const item = items[i] as ChatItem;
		if (item.kind === 'event' && GROUPABLE.has(item.e.type)) {
			const last = out[out.length - 1];
			if (last?.kind === 'group') last.events.push(item.e);
			else out.push({ kind: 'group', events: [item.e], index: i });
		} else if (item.kind === 'event' && item.e.type === 'question') {
			// Group across intervening thinking rows (they render as nothing), so a
			// reasoning burst between two ask_user calls doesn't split the tabs.
			let j = out.length - 1;
			while (j >= 0) {
				const r = out[j];
				if (r?.kind === 'item' && r.item.kind === 'event' && r.item.e.type === 'thinking') j--;
				else break;
			}
			const anchor = out[j];
			if (anchor?.kind === 'questions') anchor.events.push(item.e);
			else out.push({ kind: 'questions', events: [item.e], index: i });
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
		case 'project-named':
			return { text: `✓ project named "${e.name}"`, cls: 'commit' };
		case 'thinking':
			return { text: 'thinking…', cls: '' };
		case 'phase':
			return { text: `phase: ${e.phase}`, cls: '' };
		case 'retry':
			return {
				text: `${e.reason} — retrying in ${Math.round(e.delayMs / 1000)}s (${e.attempt}/${e.maxAttempts})`,
				cls: '',
			};
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

/** The always-present free-text answer — the "Other" the options don't cover. */
function OtherAnswer(props: { onSubmit: (text: string) => void }) {
	const [text, setText] = useState('');
	function submit(): void {
		const t = text.trim();
		if (!t) return;
		setText('');
		props.onSubmit(t);
	}
	return (
		<div className="q-other">
			<input
				value={text}
				placeholder="Other — type your own answer…"
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') submit();
				}}
			/>
			<button disabled={!text.trim()} onClick={submit}>
				use
			</button>
		</div>
	);
}

/**
 * One turn's ask_user calls (the interview). A single question keeps the
 * classic layout: clicking an option sends "N. <option>" immediately, so a
 * typed bare number means the same thing. Several questions render as tabs —
 * answers are collected per tab (options or free text), and one combined
 * message is sent when all are answered, mirroring how the model asked them.
 */
function QuestionBlock(props: {
	events: readonly QuestionEvent[];
	answered: boolean;
	onSend: (text: string) => void;
}) {
	const qs = props.events;
	const [active, setActive] = useState(0);
	const [answers, setAnswers] = useState<Record<number, string>>({});

	if (qs.length === 1) {
		const q = qs[0] as QuestionEvent;
		return (
			<div className="msg assistant q-block">
				<Markdown text={q.question} />
				<div className="model-list">
					{q.options.map((opt, i) => (
						<button
							key={i}
							disabled={props.answered}
							onClick={() => props.onSend(`${i + 1}. ${opt}`)}
						>
							{i + 1}. {opt}
						</button>
					))}
				</div>
				{!props.answered && <OtherAnswer onSubmit={props.onSend} />}
			</div>
		);
	}

	const activeIdx = Math.min(active, qs.length - 1);
	const q = qs[activeIdx] as QuestionEvent;
	const done = qs.filter((_, i) => answers[i] != null).length;

	function record(i: number, a: string): void {
		const next = { ...answers, [i]: a };
		setAnswers(next);
		const open = qs.findIndex((_, k) => next[k] == null);
		if (open !== -1) setActive(open);
	}

	function sendAll(): void {
		props.onSend(qs.map((qq, i) => `${qq.header ?? qq.question} → ${answers[i]}`).join('\n'));
	}

	return (
		<div className="q-block q-multi">
			<div className="q-tabs">
				{qs.map((qq, i) => (
					<button
						key={i}
						className={`q-tab ${i === activeIdx ? 'active' : ''} ${answers[i] != null ? 'answered' : ''}`}
						onClick={() => setActive(i)}
					>
						{answers[i] != null ? '✓ ' : ''}
						{qq.header ?? `Q${i + 1}`}
					</button>
				))}
			</div>
			<Markdown text={q.question} />
			<div className="model-list">
				{q.options.map((opt, i) => {
					const val = `${i + 1}. ${opt}`;
					return (
						<button
							key={i}
							disabled={props.answered}
							className={answers[activeIdx] === val ? 'current' : ''}
							onClick={() => record(activeIdx, val)}
						>
							{i + 1}. {opt}
						</button>
					);
				})}
			</div>
			{!props.answered && (
				<>
					<OtherAnswer onSubmit={(t) => record(activeIdx, t)} />
					<div className="q-footer">
						<span>
							{done}/{qs.length} answered
						</span>
						<button className="q-send" disabled={done < qs.length} onClick={sendAll}>
							Send answers
						</button>
					</div>
				</>
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

/** A file staged for the next message — read client-side, saved to the project
 * (attachments/<name>) via the existing file API only when the message sends. */
interface Attachment {
	name: string;
	text: string;
}

/** Attachments are workspace files, so the generator reads them with its normal
 * tools — which also bounds the honest v1: text only, small enough to be a spec
 * or sample data, never a binary the model could not open anyway. */
const MAX_ATTACHMENT_BYTES = 512 * 1024;

function safeName(name: string): string {
	return name.replace(/[^\w.-]+/g, '-');
}

export function Chat(props: {
	items: ChatItem[];
	busy: boolean;
	liveness: { label: string; silentForS: number };
	queued: readonly PlanAssumption[];
	/** Project dir attachments are saved under; null before the session loads. */
	vertical: string | null;
	model: string;
	modelTitle?: string | undefined;
	onOpenPicker: () => void;
	onToggleChip: (a: PlanAssumption) => void;
	onSend: (message: string) => void;
	onAbort: () => void;
}) {
	const [draft, setDraft] = useState('');
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [attachErr, setAttachErr] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [dragging, setDragging] = useState(false);
	// dragenter/dragleave fire per child element — only depth 0 means "left".
	const dragDepth = useRef(0);
	const fileInput = useRef<HTMLInputElement>(null);
	const bottom = useRef<HTMLDivElement>(null);

	useEffect(() => {
		bottom.current?.scrollIntoView({ behavior: 'smooth' });
	}, [props.items]);

	async function addFiles(files: FileList | File[]): Promise<void> {
		setAttachErr(null);
		for (const f of Array.from(files)) {
			if (f.size > MAX_ATTACHMENT_BYTES) {
				setAttachErr(`${f.name}: too large (max ${MAX_ATTACHMENT_BYTES / 1024}KB)`);
				continue;
			}
			const text = await f.text();
			if (text.includes('\u0000')) {
				setAttachErr(`${f.name}: binary files are not supported — attach text (specs, data, code)`);
				continue;
			}
			const name = safeName(f.name);
			setAttachments((a) => (a.some((x) => x.name === name) ? a : [...a, { name, text }]));
		}
	}

	function dragEnter(e: ReactDragEvent<HTMLDivElement>): void {
		if (!e.dataTransfer.types.includes('Files')) return;
		e.preventDefault();
		dragDepth.current += 1;
		setDragging(true);
	}
	function dragLeave(): void {
		dragDepth.current = Math.max(0, dragDepth.current - 1);
		if (dragDepth.current === 0) setDragging(false);
	}
	function drop(e: ReactDragEvent<HTMLDivElement>): void {
		if (!e.dataTransfer.types.includes('Files')) return;
		e.preventDefault();
		dragDepth.current = 0;
		setDragging(false);
		void addFiles(e.dataTransfer.files);
	}

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

	async function send(): Promise<void> {
		const text = draft.trim();
		if (props.busy || sending) return;
		if (!text && attachments.length === 0) return;
		setAttachErr(null);
		let message = text;
		if (attachments.length > 0) {
			// Save first, send after: the message references paths that must exist by
			// the time the generator reads them. A failed save keeps draft + chips.
			if (!props.vertical) {
				setAttachErr('no active project to save attachments into');
				return;
			}
			setSending(true);
			try {
				const paths: string[] = [];
				for (const a of attachments) {
					await api.saveFile(`${props.vertical}/attachments/${a.name}`, a.text);
					paths.push(`attachments/${a.name}`);
				}
				message =
					`${text ? `${text}\n\n` : ''}Attached file${paths.length === 1 ? '' : 's'} ` +
					`(already saved in the project):\n${paths.map((p) => `- ${p}`).join('\n')}`;
			} catch (e) {
				setAttachErr(`attachment upload failed: ${(e as Error).message}`);
				return;
			} finally {
				setSending(false);
			}
		}
		setDraft('');
		setAttachments([]);
		props.onSend(message);
	}

	const canSend = (draft.trim().length > 0 || attachments.length > 0) && !sending;

	return (
		<div
			className="chat-body"
			onDragEnter={dragEnter}
			onDragOver={(e) => {
				if (e.dataTransfer.types.includes('Files')) e.preventDefault();
			}}
			onDragLeave={dragLeave}
			onDrop={drop}
		>
			<div className="messages">
				{props.items.length === 0 && (
					<div className="evt">What would you like to build today?</div>
				)}
				{groupItems(props.items).map((r) => {
					const isLast = r.index + (r.kind === 'item' ? 1 : r.events.length) >= props.items.length;
					// The interview block: live until the user's answer lands (a user
					// message after it) or a turn is running.
					if (r.kind === 'questions') {
						const answered = props.busy || r.index < lastUser;
						return (
							<QuestionBlock
								key={r.index}
								events={r.events}
								answered={answered}
								onSend={props.onSend}
							/>
						);
					}
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
								<Markdown text={item.text} />
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
				<div className={`composer-box ${dragging ? 'dragging' : ''}`}>
					{attachments.length > 0 && (
						<div className="attachments">
							{attachments.map((a) => (
								<span className="attachment-chip" key={a.name}>
									{a.name}
									<button
										title="Remove attachment"
										onClick={() => setAttachments((all) => all.filter((x) => x.name !== a.name))}
									>
										×
									</button>
								</span>
							))}
						</div>
					)}
					<textarea
						rows={2}
						placeholder={props.busy ? 'turn running…' : 'Describe what to build or change…'}
						value={draft}
						disabled={props.busy || sending}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								void send();
							}
						}}
					/>
					<div className="composer-row">
						<button
							className="attach-btn"
							title="Attach files (or drop them anywhere in the chat)"
							disabled={props.busy || sending}
							onClick={() => fileInput.current?.click()}
						>
							+
						</button>
						<button className="composer-model" title={props.modelTitle} onClick={props.onOpenPicker}>
							{props.model}
							<span className="chev">▾</span>
						</button>
						<span style={{ flex: 1 }} />
						{props.busy ? (
							<button className="send-btn" title="Stop the turn" onClick={props.onAbort}>
								■
							</button>
						) : (
							<button
								className="send-btn"
								title="Send (Enter)"
								disabled={!canSend}
								onClick={() => void send()}
							>
								↑
							</button>
						)}
					</div>
				</div>
				{attachErr && <div className="attach-err">{attachErr}</div>}
				<input
					ref={fileInput}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						if (e.target.files) void addFiles(e.target.files);
						e.target.value = '';
					}}
				/>
			</div>
			{dragging && <div className="drop-overlay">Drop files to attach</div>}
		</div>
	);
}
