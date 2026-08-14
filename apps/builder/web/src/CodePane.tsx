/**
 * The code tab — Monaco (§7.2: the editor component of VS Code, not the IDE).
 * File tree on the left, editor right. Reading works off git/the workspace and
 * never needs the sandbox awake; saving is confined to the vertical, mirroring
 * the commit scope. Refreshes after each turn so the model's writes appear.
 */
import Editor from '@monaco-editor/react';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

const LANG: Record<string, string> = {
	ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
	json: 'json', md: 'markdown', css: 'css', html: 'html', sql: 'sql', yaml: 'yaml', yml: 'yaml',
};

function language(path: string): string {
	return LANG[path.split('.').pop() ?? ''] ?? 'plaintext';
}

function Dir(props: {
	path: string;
	depth: number;
	selected: string | null;
	refreshKey: number;
	onOpen: (path: string) => void;
}) {
	const [entries, setEntries] = useState<string[] | null>(null);
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});

	useEffect(() => {
		api.files(props.path).then(
			({ entries }) => setEntries(entries),
			() => setEntries([]),
		);
	}, [props.path, props.refreshKey]);

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
	const [selected, setSelected] = useState<string | null>(null);
	const [content, setContent] = useState<string>('');
	const [dirty, setDirty] = useState(false);
	const [status, setStatus] = useState('');

	const open = useCallback((path: string) => {
		void api.file(path).then(({ content }) => {
			setSelected(path);
			setContent(content);
			setDirty(false);
			setStatus('');
		});
	}, []);

	// After a turn, re-read the open file — the model may have rewritten it.
	useEffect(() => {
		if (selected && !dirty) open(selected);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.refreshKey]);

	async function save(): Promise<void> {
		if (!selected) return;
		try {
			await api.saveFile(selected, content);
			setDirty(false);
			setStatus('saved');
		} catch (e) {
			setStatus((e as Error).message);
		}
	}

	return (
		<>
			<div className="tree">
				<Dir
					path={props.vertical}
					depth={0}
					selected={selected}
					refreshKey={props.refreshKey}
					onOpen={open}
				/>
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
