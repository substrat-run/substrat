/**
 * The project switcher + editable name in the top bar.
 *
 * The name is a click-to-edit inline input; saving marks it user-named, which
 * the AI's set_project_name proposal can never overwrite afterwards. The
 * dropdown lists projects by recency (each is its own repo under
 * .builder/projects/, §4.6) and offers "New project" — switching swaps the
 * whole session: repo, history, gates.
 */
import { useEffect, useRef, useState } from 'react';
import { api, type ProjectInfo } from './api.js';

export function ProjectMenu(props: {
	name: string;
	dir: string;
	busy: boolean;
	/** Called after a switch/create/rename so the app reloads session + chat. */
	onChanged: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(props.name);
	const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
	const [current, setCurrent] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);
	const newNameRef = useRef<HTMLInputElement>(null);
	const menuRef = useRef<HTMLSpanElement>(null);

	useEffect(() => setDraft(props.name), [props.name]);
	useEffect(() => {
		if (editing) inputRef.current?.select();
	}, [editing]);
	useEffect(() => {
		if (creating) newNameRef.current?.focus();
	}, [creating]);
	useEffect(() => {
		if (!open) return;
		void api.projects().then(({ current, projects }) => {
			setCurrent(current);
			setProjects(projects);
		});
		const onPointerDown = (e: PointerEvent) => {
			if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
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

	async function saveName(): Promise<void> {
		setEditing(false);
		const name = draft.trim();
		if (!name || name === props.name) {
			setDraft(props.name);
			return;
		}
		await api.renameProject(name).catch(() => setDraft(props.name));
		props.onChanged();
	}

	async function select(id: string): Promise<void> {
		setOpen(false);
		if (id === current) return;
		await api.selectProject(id);
		props.onChanged();
	}

	async function create(): Promise<void> {
		setCreating(false);
		await api.createProject(newName.trim() || undefined);
		props.onChanged();
	}

	return (
		<span className="project-menu" ref={menuRef}>
			{editing ? (
				<input
					ref={inputRef}
					className="project-name-input"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => void saveName()}
					onKeyDown={(e) => {
						if (e.key === 'Enter') void saveName();
						if (e.key === 'Escape') {
							setDraft(props.name);
							setEditing(false);
						}
					}}
				/>
			) : (
				<button
					className="project-name"
					title={`${props.dir} — click to rename`}
					onClick={() => !props.busy && setEditing(true)}
				>
					{props.name}
				</button>
			)}
			<button
				className="icon-btn"
				title="Switch project"
				onClick={() => setOpen((o) => !o)}
				disabled={props.busy}
			>
				▾
			</button>
			{open && (
				<div className="project-dropdown">
					{projects === null && <div className="pd-row muted">loading…</div>}
					{projects?.map((p) => (
						<button
							key={p.id}
							className={`pd-row ${p.id === current ? 'current' : ''}`}
							onClick={() => void select(p.id)}
						>
							<span className="pd-name">{p.name}</span>
							<span className="pd-dir mono">{p.dir.split('/').pop()}</span>
						</button>
					))}
					<button
						className="pd-row pd-new"
						onClick={() => {
							setOpen(false);
							setNewName('');
							setCreating(true);
						}}
					>
						＋ New project
					</button>
				</div>
			)}
			{creating && (
				<div className="picker-backdrop" onClick={() => setCreating(false)}>
					<div className="picker prompt-dialog" onClick={(e) => e.stopPropagation()}>
						<h2>New project</h2>
						<div className="sub">Leave the name empty to let the AI name it at concept time.</div>
						<input
							ref={newNameRef}
							className="prompt-input"
							placeholder="Project name (optional)"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') void create();
								if (e.key === 'Escape') setCreating(false);
							}}
						/>
						<div className="prompt-actions">
							<button className="pill" onClick={() => setCreating(false)}>
								Cancel
							</button>
							<button className="primary" onClick={() => void create()}>
								Create
							</button>
						</div>
					</div>
				</div>
			)}
		</span>
	);
}
