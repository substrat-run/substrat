/**
 * The preview tab. Two hosts, two meanings of Run:
 *
 * - LOCAL (mode A): the studio starts and manages the generated app's two dev
 *   processes (API + web) on freshly allocated ports and wires the iframe to the
 *   reported URL. "running" is only shown once the web port has actually
 *   answered — the liveness rule, applied to the app itself.
 * - HOSTED (#2895): Run releases the saved revision onto the studio's preview
 *   slot and frames the slot's URL — the app on the stack it ships on, with no
 *   process in the sandbox to keep awake. A refusal is shown in its own words.
 *   The slot holds the project's sample world by default; "production data"
 *   (#3108) runs it on a copy of the installed app instead, offered only where
 *   the control plane would admit it, and saying why where it would not.
 *
 * The manual URL field stays as an escape hatch for apps the user runs in their
 * own terminal.
 */
import { useEffect, useReducer, useRef, useState } from 'react';
import { api, type StudioDataPreview, type StudioPreview } from './api.js';

type DevState = 'stopped' | 'starting' | 'running' | 'error';

export function PreviewPane(props: { hosted: boolean }) {
	return props.hosted ? <HostedPreview /> : <LocalPreview />;
}

function LocalPreview() {
	const [state, setState] = useState<DevState>('stopped');
	const [url, setUrl] = useState<string | null>(null);
	const [log, setLog] = useState<string[]>([]);
	const [manual, setManual] = useState('');
	const [src, setSrc] = useState<string | null>(null);
	const [frame, reloadFrame] = useReducer((n: number) => n + 1, 0);
	const polling = useRef(false);

	async function refresh(): Promise<void> {
		const s = await api.devStatus().catch(() => null);
		if (!s) return;
		setState(s.state);
		setUrl(s.url);
		setLog(s.log);
		if (s.state === 'running' && s.url && !src) setSrc(s.url);
	}

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Poll while the app is coming up or running — status truth, not a timer
	// pretending to be progress.
	useEffect(() => {
		if (state !== 'starting' && state !== 'running') return;
		if (polling.current) return;
		polling.current = true;
		const t = setInterval(() => void refresh(), 2000);
		return () => {
			clearInterval(t);
			polling.current = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state]);

	async function start(): Promise<void> {
		setState('starting');
		setSrc(null);
		await api.dev('start').catch(() => setState('error'));
		void refresh();
	}

	async function stop(): Promise<void> {
		await api.dev('stop').catch(() => undefined);
		setSrc(null);
		void refresh();
	}

	return (
		<div className="preview">
			<div className="preview-bar">
				{state === 'stopped' || state === 'error' ? (
					<button className="pill" onClick={() => void start()}>▶ Run</button>
				) : (
					<button className="pill" onClick={() => void stop()}>■ Stop</button>
				)}
				<span className={`badge ${state === 'running' ? 'ok' : state === 'error' ? 'bad' : 'warn'}`}>
					{state}
					{url ? ` · ${url}` : ''}
				</span>
				<input
					value={manual}
					onChange={(e) => setManual(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && setSrc(manual)}
					placeholder="…or open a URL you started yourself"
				/>
				{src && <button className="pill" onClick={reloadFrame}>reload</button>}
			</div>
			{state === 'error' && log.length > 0 && (
				<pre className="dev-log">{log.slice(-20).join('\n')}</pre>
			)}
			{src ? (
				<iframe key={frame} src={src} title="preview" />
			) : (
				<div className="empty">
					{state === 'starting'
						? 'starting the app — waiting for the web port to answer…'
						: 'Run starts the app (API + web) with fresh ports; or paste a URL you started yourself'}
				</div>
			)}
		</div>
	);
}

type HostedState = 'idle' | 'building' | 'ready' | 'error';
/** Which slot Run deploys to: the sample world, or a copy of the installed app's data. */
type DataKind = 'sample' | 'production';

function HostedPreview() {
	const [kind, setKind] = useState<DataKind>('sample');
	const [state, setState] = useState<HostedState>('idle');
	const [url, setUrl] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [manual, setManual] = useState('');
	const [src, setSrc] = useState<string | null>(null);
	const [frame, reloadFrame] = useReducer((n: number) => n + 1, 0);
	/** Each slot as last read or run, so switching kind shows that slot's app. */
	const slots = useRef<Record<DataKind, StudioPreview>>({ sample: { state: 'none' }, production: { state: 'none' } });
	const [fork, setFork] = useState<StudioDataPreview['fork'] | null>(null);
	/** Set by Run: the tab's opening read must not land on top of a Run already under way. */
	const ran = useRef(false);

	function show(p: StudioPreview): void {
		setError(null);
		if (p.state !== 'ready') {
			setState('idle');
			setUrl(null);
			setSrc(null);
			setNote(null);
			return;
		}
		setState('ready');
		setUrl(p.url);
		setSrc(p.url);
		setNote(p.authNote ?? null);
		// A re-run rebinds the same URL, so the frame is reloaded rather than left on the old version.
		reloadFrame();
	}

	useEffect(() => {
		void api.studioPreview().then((p) => {
			slots.current.sample = p;
			if (!ran.current) show(p);
		}, () => undefined);
		void api.studioDataPreview().then(({ fork: f, ...p }) => {
			slots.current.production = p;
			setFork(f);
		}, () => setFork({ ok: false, reason: 'could not ask the control plane' }));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	function choose(next: DataKind): void {
		setKind(next);
		show(slots.current[next]);
	}

	async function run(): Promise<void> {
		ran.current = true;
		const running = kind;
		setState('building');
		setError(null);
		setNote(null);
		try {
			const p = await (running === 'production' ? api.runStudioDataPreview() : api.runStudioPreview());
			slots.current[running] = p;
			show(p);
		} catch (e) {
			setState('error');
			setError((e as Error).message);
		}
	}

	const busy = state === 'building';
	const blocked = kind === 'production' && fork?.ok !== true;
	const label =
		state === 'building' ? 'building and deploying' : state === 'ready' ? 'ready' : state === 'error' ? 'failed' : 'not running';
	return (
		<div className="preview">
			<div className="preview-bar">
				<select value={kind} disabled={busy} onChange={(e) => choose(e.target.value as DataKind)} aria-label="preview data">
					<option value="sample">Sample data</option>
					<option value="production" disabled={fork?.ok !== true} title={fork && !fork.ok ? fork.reason : undefined}>
						Production data{fork && !fork.ok ? ' (unavailable)' : ''}
					</option>
				</select>
				<button className="pill" disabled={busy || blocked} onClick={() => void run()}>
					{busy ? '… Running' : state === 'ready' ? '↻ Run again' : '▶ Run'}
				</button>
				<span className={`badge ${state === 'ready' ? 'ok' : state === 'error' ? 'bad' : 'warn'}`}>{label}</span>
				{url && (
					<a className="pill" href={url} target="_blank" rel="noreferrer">
						open in new tab
					</a>
				)}
				<input
					value={manual}
					onChange={(e) => setManual(e.target.value)}
					onKeyDown={(e) => e.key === 'Enter' && setSrc(manual)}
					placeholder="…or open a URL yourself"
				/>
				{src && <button className="pill" onClick={reloadFrame}>reload</button>}
			</div>
			{error && <pre className="dev-log" role="alert">{error}</pre>}
			{note && <pre className="dev-log">{note}</pre>}
			{src ? (
				<iframe key={frame} src={src} title="preview" />
			) : (
				<div className="empty">
					{busy
						? kind === 'production'
							? 'copying the installed app\'s data and deploying the saved source onto it — this takes a few minutes…'
							: 'building the saved source and deploying it to this project\'s preview — this takes a few minutes…'
						: kind === 'production'
							? 'Run deploys the saved source onto a private copy of the installed app\'s data; you sign in with the app\'s own login'
							: 'Run deploys the saved source to a private preview of this project, with its sample data and people to sign in as'}
					{fork && !fork.ok && <p>Production data: {fork.reason}</p>}
				</div>
			)}
		</div>
	);
}
