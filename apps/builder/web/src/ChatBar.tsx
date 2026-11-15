/**
 * The chat bar above the conversation: which chat this is, the project's other
 * chats to switch to, "New chat", and how this chat's work reaches the base.
 *
 * A chat is a conversation on a branch of its own (src/chats.ts on the host).
 * Turns commit to that branch; the base — what a release builds — moves only
 * by a merge: here for a studio project, through a pull request on GitHub for
 * a connected repository. So "New chat" is a fresh context for the model and a
 * fresh branch from the base at once. Hidden where the host has no chats (the
 * local server keeps one conversation per project).
 */
import { Button } from '@substrat-run/ui';
import { useEffect, useRef, useState } from 'react';
import { api, type ChatInfo, type ChatsInfo } from './api.js';

const STATUS: Record<ChatInfo['status'], string> = {
	empty: 'no changes yet',
	unmerged: 'not merged',
	merged: 'merged',
};

export function ChatBar(props: {
	busy: boolean;
	/** Bumped by the app after every turn and commit: a turn changes this chat's status. */
	refreshKey: number;
	/** Called after a switch, create or remove so the app reloads session + transcript. */
	onChanged: () => void;
}) {
	const [info, setInfo] = useState<ChatsInfo | null>(null);
	const [open, setOpen] = useState(false);
	const [working, setWorking] = useState(false);
	const [merging, setMerging] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
	const ref = useRef<HTMLDivElement>(null);

	const load = (): Promise<void> => api.chats().then(setInfo, () => setInfo(null));
	useEffect(() => {
		void load();
	}, [props.refreshKey]);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setOpen(false);
		};
		document.addEventListener('pointerdown', onPointerDown);
		document.addEventListener('keydown', onKeyDown);
		return () => {
			document.removeEventListener('pointerdown', onPointerDown);
			document.removeEventListener('keydown', onKeyDown);
		};
	}, [open]);

	if (!info) return null;
	const current = info.chats.find((c) => c.id === info.current);
	const locked = props.busy || working;

	async function act(run: () => Promise<unknown>, done?: string): Promise<void> {
		setOpen(false);
		setConfirmRemove(false);
		setWorking(true);
		setNotice(null);
		try {
			await run();
			if (done) setNotice({ text: done, error: false });
			props.onChanged();
		} catch (e) {
			setNotice({ text: (e as Error).message, error: true });
		} finally {
			setWorking(false);
			await load();
		}
	}

	async function merge(): Promise<void> {
		setWorking(true);
		setMerging(true);
		setNotice(null);
		try {
			const r = await api.mergeChat();
			setNotice({
				text: r.how === 'up-to-date'
					? `${r.base} already has everything in this chat.`
					: `Merged into ${r.base}${r.how === 'merge' ? ` — together with what ${r.base} gained meanwhile, and the checks passed` : ''}.`,
				error: false,
			});
		} catch (e) {
			setNotice({ text: (e as Error).message, error: true });
		} finally {
			setWorking(false);
			setMerging(false);
			await load();
		}
	}

	return (
		<div className="chat-bar-wrap" ref={ref}>
			<div className="chat-bar">
				<button className="chat-title" onClick={() => setOpen((o) => !o)} disabled={locked} title={current?.branch}>
					{current?.title ?? 'Chat'} ▾
				</button>
				{current && <span className={`chat-status ${current.status}`}>{STATUS[current.status]}</span>}
				<span className="spacer" />
				<Button size="sm" variant="ghost" disabled={locked} onClick={() => void act(() => api.newChat())}>
					＋ New chat
				</Button>
				{info.merge === 'studio' ? (
					<span title={`Bring this chat's work into ${info.base}, which is what a release builds`}>
						<Button
							size="sm"
							loading={merging}
							disabled={locked || current?.status !== 'unmerged'}
							onClick={() => void merge()}
						>
							Merge into {info.base}
						</Button>
					</span>
				) : current?.compareUrl ? (
					<a className="pill" href={current.compareUrl} target="_blank" rel="noreferrer" title={`Review and merge on GitHub into ${info.base}`}>
						Open pull request ↗
					</a>
				) : null}
			</div>
			{open && (
				<div className="project-dropdown chat-dropdown">
					{info.chats.map((c) => (
						<button
							key={c.id}
							className={`pd-row ${c.id === info.current ? 'current' : ''}`}
							onClick={() => void (c.id === info.current ? setOpen(false) : act(() => api.selectChat(c.id)))}
						>
							<span className="pd-name">{c.title}</span>
							<span className="pd-dir">{STATUS[c.status]}</span>
						</button>
					))}
					{info.chats.length > 1 && current && (
						<button
							className="pd-row pd-new"
							onClick={() => (confirmRemove ? void act(() => api.removeChat(current.id)) : setConfirmRemove(true))}
						>
							{confirmRemove
								? `Remove “${current.title}”? Click again — its conversation is deleted, its branch stays`
								: 'Remove this chat…'}
						</button>
					)}
				</div>
			)}
			{notice && (
				<div className={`chat-notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>
					<span>{notice.text}</span>
					<button className="icon-btn" onClick={() => setNotice(null)} title="Dismiss">×</button>
				</div>
			)}
		</div>
	);
}
