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
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => setDraft(props.name), [props.name]);
	useEffect(() => {
		if (editing) inputRef.current?.select();
	}, [editing]);
	useEffect(() => {
		if (open) {
			void api.projects().then(({ current, projects }) => {
				setCurrent(current);
				setProjects(projects);
			});
		}
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
		setOpen(false);
		// prompt() is deliberate spike pragmatism: no modal system exists yet and
		// the name is optional — the AI proposes one at concept time anyway.
		const name = window.prompt('Project name (leave empty to let the AI name it):') ?? undefined;
		if (name === undefined) return; // cancelled
		await api.createProject(name.trim() || undefined);
		props.onChanged();
	}

	return (
		<span className="project-menu">
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
					<button className="pd-row pd-new" onClick={() => void create()}>
						＋ New project
					</button>
				</div>
			)}
		</span>
	);
}
