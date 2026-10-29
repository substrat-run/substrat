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
	sourceProjects: boolean;
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
	const [verticals, setVerticals] = useState<Array<{ slug: string; name: string }>>([]);
	const [slug, setSlug] = useState('');
	const [github, setGithub] = useState('');
	const [branch, setBranch] = useState('main');
	const [directory, setDirectory] = useState('.');
	const [error, setError] = useState('');
	const [saving, setSaving] = useState(false);
	const [releasing, setReleasing] = useState(false);
	const [version, setVersion] = useState('1.0.0');
	const [releaseResult, setReleaseResult] = useState('');
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
		if (props.sourceProjects) void api.verticals().then(({ entries }) => setVerticals(entries)).catch(() => setVerticals([]));
		void api.projects().then(({ current, projects }) => {
			setCurrent(current);
			setProjects(projects);
		}).catch((e: Error) => { setProjects([]); setError(e.message); });
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
		if (saving) return;
		setSaving(true);
		setError('');
		try {
			const parts = github.trim().split('/');
			if (github.trim() && (parts.length !== 2 || !parts[0] || !parts[1])) throw new Error('Enter the GitHub repository as owner/repository');
			await api.createProject(newName.trim() || undefined, {
				slug: slug || undefined,
				...(github.trim() ? { repository: { kind: 'github', owner: parts[0]!, repo: parts[1]!, branch, directory } } : {}),
			});
			setCreating(false);
			props.onChanged();
		} catch (e) { setError((e as Error).message); }
		finally { setSaving(false); }
	}

	async function release(): Promise<void> {
		if (saving) return;
		setSaving(true);
		setError('');
		setReleaseResult('');
		try {
			const result = await api.buildRelease(version);
			setReleaseResult(`Release ${result.id} is ${result.admission}. Promote it from the dashboard or CLI to go live.`);
		} catch (e) { setError((e as Error).message); }
		finally { setSaving(false); }
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
					{error && <div className="pd-row" role="alert">{error}</div>}
					{projects === null && <div className="pd-row muted">loading…</div>}
					{projects?.map((p) => (
						<button
							key={p.id}
							className={`pd-row ${p.id === current ? 'current' : ''}`}
							onClick={() => void select(p.id)}
						>
							<span className="pd-name">{p.name}</span>
							<span className="pd-dir mono">{p.slug ?? p.dir.split('/').pop()}</span>
						</button>
					))}
					<button
						className="pd-row pd-new"
						onClick={() => {
							setOpen(false);
							setNewName('');
							setSlug(''); setGithub(''); setBranch('main'); setDirectory('.'); setError('');
							setCreating(true);
						}}
					>
						＋ New project
					</button>
					{props.sourceProjects && <button className="pd-row" onClick={() => { setOpen(false); setError(''); setReleaseResult(''); setReleasing(true); }}>Build release…</button>}
				</div>
			)}
			{creating && (
				<div className="picker-backdrop" onClick={() => setCreating(false)}>
					<div className="picker prompt-dialog" onClick={(e) => e.stopPropagation()}>
						<h2>New project</h2>
						<div className="sub">{props.sourceProjects ? "Start a project or open a repository from your team’s connected GitHub account." : "Leave the name empty to let the AI name it at concept time."}</div>
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
						{props.sourceProjects && <>
						<label>Vertical
							<select value={slug} onChange={(e) => { setSlug(e.target.value); const v = verticals.find((v) => v.slug === e.target.value); if (v) setNewName(v.name); }}>
								<option value="">New vertical</option>
								{verticals.filter((v) => !projects?.some((p) => p.slug === v.slug)).map((v) => <option key={v.slug} value={v.slug}>{v.name}</option>)}
							</select>
						</label>
						<label>GitHub repository (optional)<input className="prompt-input" placeholder="owner/repository" value={github} onChange={(e) => setGithub(e.target.value)} /></label>
						{github && <>
							<label>Branch<input className="prompt-input" value={branch} onChange={(e) => setBranch(e.target.value)} /></label>
							<label>App directory<input className="prompt-input" value={directory} onChange={(e) => setDirectory(e.target.value)} /></label>
						</>}
						</>}
						{error && <p role="alert">{error}</p>}
						<div className="prompt-actions">
							<button className="pill" onClick={() => setCreating(false)}>
								Cancel
							</button>
							<button className="primary" disabled={saving} onClick={() => void create()}>
								{saving ? 'Opening…' : 'Create'}
							</button>
						</div>
					</div>
				</div>
			)}
			{releasing && <div className="picker-backdrop" onClick={() => !saving && setReleasing(false)}>
				<div className="picker prompt-dialog" onClick={(e) => e.stopPropagation()}>
					<h2>Build release</h2>
					<p>Build the saved source on the platform. Promotion is a separate step.</p>
					<label>Version<input className="prompt-input" value={version} onChange={(e) => setVersion(e.target.value)} disabled={saving} /></label>
					{error && <p role="alert">{error}</p>}
					{releaseResult && <p role="status">{releaseResult}</p>}
					<div className="prompt-actions">
						<button className="pill" disabled={saving} onClick={() => setReleasing(false)}>Close</button>
						<button className="primary" disabled={saving || !version.trim()} onClick={() => void release()}>{saving ? 'Building…' : 'Build'}</button>
					</div>
				</div>
			</div>}
		</span>
	);
}
