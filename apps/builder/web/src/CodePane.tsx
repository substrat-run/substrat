/**
 * The code tab — Monaco (§7.2: the editor component of VS Code, not the IDE).
 * File tree on the left, editor right.
 *
 * Reads come from ONE `/api/snapshot` fetch per refresh (the whole working
 * tree, served from R2 in hosted mode — the sandbox container stays asleep);
 * tree expansion and file opens are then instant and local. Saving is confined
 * to the vertical, mirroring the commit scope, and patches the in-memory
 * snapshot so the view stays consistent without a refetch. Hosts without a
 * snapshot yet (pre-first-commit) fall back to the per-directory endpoints.
 * Refreshes after each turn so the model's writes appear.
 */
import Editor from '@monaco-editor/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const LANG: Record<string, string> = {
	ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
	json: 'json', md: 'markdown', css: 'css', html: 'html', sql: 'sql', yaml: 'yaml', yml: 'yaml',
};

function language(path: string): string {
	return LANG[path.split('.').pop() ?? ''] ?? 'plaintext';
}

/** One directory level derived from the snapshot's flat rel-paths: child dirs
 * (as `name/`) then files, both sorted — the same shape /api/files returns. */
function levelEntries(paths: string[], dirRel: string): string[] {
	const prefix = dirRel ? `${dirRel}/` : '';
	const dirs = new Set<string>();
	const files: string[] = [];
	for (const p of paths) {
		if (!p.startsWith(prefix)) continue;
		const rest = p.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash === -1) files.push(rest);
		else dirs.add(`${rest.slice(0, slash)}/`);
	}
	return [...[...dirs].sort(), ...files.sort()];
}

/** A directory level. Snapshot mode answers from the flat path list; fallback
 * mode (no snapshot on this host) fetches the level from /api/files. */
function Dir(props: {
	/** Repo-root path of this level (vertical dir at depth 0). */
	path: string;
	/** Rel-paths of every file in the snapshot; null = fallback mode. */
	snapshot: string[] | null;
	/** This level's path relative to the vertical dir ('' at the root). */
	rel: string;
	depth: number;
	selected: string | null;
	refreshKey: number;
	onOpen: (path: string) => void;
}) {
	const [fetched, setFetched] = useState<string[] | null>(null);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	const fallback = props.snapshot === null;
	useEffect(() => {
		if (!fallback) return;
		api.files(props.path).then(
			({ entries }) => setFetched(entries),
			() => setFetched([]),
		);
	}, [fallback, props.path, props.refreshKey]);

	const entries = props.snapshot !== null ? levelEntries(props.snapshot, props.rel) : fetched;
	if (entries === null) return null;
	return (
		<>
			{entries.map((entry) => {
				const isDir = entry.endsWith('/');
				const name = isDir ? entry.slice(0, -1) : entry;
				const full = `${props.path}/${name}`;
				const pad = { paddingLeft: 12 + props.depth * 14 };
				if (isDir) {
					return (
						<div key={full}>
							<button
								className="dir"
								style={pad}
								onClick={() => setExpanded((x) => ({ ...x, [full]: !x[full] }))}
							>
								{expanded[full] ? '▾' : '▸'} {name}
							</button>
							{expanded[full] && (
								<Dir
									path={full}
									snapshot={props.snapshot}
									rel={props.rel ? `${props.rel}/${name}` : name}
									depth={props.depth + 1}
									selected={props.selected}
									refreshKey={props.refreshKey}
									onOpen={props.onOpen}
								/>
							)}
						</div>
					);
				}
				return (
					<button
						key={full}
						style={pad}
						className={props.selected === full ? 'sel' : ''}
						onClick={() => props.onOpen(full)}
					>
						{name}
					</button>
				);
			})}
		</>
	);
}

export function CodePane(props: { vertical: string; refreshKey: number }) {
	// undefined = snapshot not resolved yet; null = this host has none (fallback).
	const [snap, setSnap] = useState<Record<string, string> | null | undefined>(undefined);
	const [selected, setSelected] = useState<string | null>(null);
	const [content, setContent] = useState<string>('');
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState('');
	// The open()/effect below needs the latest snapshot without re-running on
	// every snapshot change — a ref keeps the callbacks stable.
	const snapRef = useRef(snap);
	snapRef.current = snap;

	const toRel = useCallback(
		(path: string) => path.slice(props.vertical.length + 1),
		[props.vertical],
	);

	const open = useCallback(
		(path: string) => {
			const local = snapRef.current?.[toRel(path)];
			if (local !== undefined) {
				setSelected(path);
				setContent(local);
				setDirty(false);
				setStatus('');
				return;
			}
			// Fallback (no snapshot, or a `skipped` oversize file): one fetch.
			void api.file(path).then(({ content }) => {
				setSelected(path);
				setContent(content);
				setDirty(false);
				setStatus('');
			});
		},
		[toRel],
	);

	// One snapshot fetch per refresh; each turn bumps refreshKey so the model's
	// writes appear. The open file re-reads from the fresh snapshot unless the
	// builder has unsaved edits.
	useEffect(() => {
		let stale = false;
		api.snapshot().then(
			(s) => {
				if (stale) return;
				setSnap(s ? s.files : null);
				if (s && selected && !dirty) {
					const rel = selected.slice(props.vertical.length + 1);
					if (s.files[rel] !== undefined) {
						setContent(s.files[rel]);
					}
				}
			},
			() => {
				if (!stale) setSnap(null);
			},
		);
		return () => {
			stale = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.refreshKey]);

	// Fallback mode only: snapshot never arrived, keep the old re-read behavior.
	useEffect(() => {
		if (snap === null && selected && !dirty) open(selected);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.refreshKey, snap === null]);

	async function save(): Promise<void> {
		if (!selected) return;
		try {
			await api.saveFile(selected, content);
			setDirty(false);
			setStatus('saved');
			// Keep the local snapshot true to what the server now has.
			setSnap((s) => (s ? { ...s, [toRel(selected)]: content } : s));
		} catch (e) {
			setStatus((e as Error).message);
		}
	}

	return (
		<>
			<div className="tree">
				{snap !== undefined && (
					<Dir
						path={props.vertical}
						snapshot={snap ? Object.keys(snap) : null}
						rel=""
						depth={0}
						selected={selected}
						refreshKey={props.refreshKey}
						onOpen={open}
					/>
				)}
			</div>
			<div className="editor-wrap">
				{selected ? (
					<>
						<div className="editor-bar">
							<span className="mono">{selected}{dirty ? ' •' : ''}</span>
							<span>{status}</span>
							<button className="pill" onClick={() => void save()} disabled={!dirty}>
								save
							</button>
						</div>
						<Editor
							theme="vs-dark"
							path={selected}
							language={language(selected)}
							value={content}
							onChange={(v) => {
								setContent(v ?? '');
								setDirty(true);
							}}
							options={{ minimap: { enabled: false }, fontSize: 13 }}
						/>
					</>
				) : (
					<div className="empty">select a file — the tree shows {props.vertical}/</div>
				)}
			</div>
		</>
	);
}
