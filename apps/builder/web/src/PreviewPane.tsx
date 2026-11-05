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
 *
 * The manual URL field stays as an escape hatch for apps the user runs in their
 * own terminal.
 */
import { useEffect, useRef, useState } from 'react';
import { api, type StudioPreview } from './api.js';

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
				{src && <button className="pill" onClick={() => setSrc(`${src.split('#')[0]}`)}>reload</button>}
			</div>
			{state === 'error' && log.length > 0 && (
				<pre className="dev-log">{log.slice(-20).join('\n')}</pre>
			)}
			{src ? (
				<iframe src={src} title="preview" />
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

type HostedState = 'idle' | 'building' | 'copying' | 'ready' | 'error';

function HostedPreview() {
	const [state, setState] = useState<HostedState>('idle');
	const [url, setUrl] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [manual, setManual] = useState('');
	const [src, setSrc] = useState<string | null>(null);
	const alive = useRef(true);

	function show(p: StudioPreview): void {
		if (p.state !== 'ready') return;
		setState('ready');
		setUrl(p.url);
		setSrc(p.url);
		setNote(p.authNote ?? null);
	}

	useEffect(() => {
		alive.current = true;
		void api.studioPreview().then(show, () => undefined);
		return () => {
			alive.current = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function run(): Promise<void> {
		setState('building');
		setError(null);
		setNote(null);
		try {
			let p = await api.runStudioPreview();
			// A copy still running answers `copying`: the same call again, once the plane says.
			while (p.state === 'copying' && alive.current) {
				setState('copying');
				const wait = p.retryAfter;
				await new Promise((r) => setTimeout(r, wait * 1000));
				p = await api.runStudioPreview(p.versionId);
			}
			show(p);
		} catch (e) {
			setState('error');
			setError((e as Error).message);
		}
	}

	const busy = state === 'building' || state === 'copying';
	const label =
		state === 'building' ? 'building and deploying' : state === 'copying' ? 'preparing data' : state === 'ready' ? 'ready' : state === 'error' ? 'failed' : 'not running';
	return (
		<div className="preview">
			<div className="preview-bar">
				<button className="pill" disabled={busy} onClick={() => void run()}>
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
				{src && <button className="pill" onClick={() => setSrc(`${src.split('#')[0]}`)}>reload</button>}
			</div>
			{error && <pre className="dev-log" role="alert">{error}</pre>}
			{note && <pre className="dev-log">{note}</pre>}
			{src ? (
				<iframe src={src} title="preview" />
			) : (
				<div className="empty">
					{busy
						? 'building the saved source and deploying it to this project\'s preview — this takes a few minutes…'
						: 'Run deploys the saved source to a private preview of this project, with its own empty data'}
				</div>
			)}
		</div>
	);
}
