/**
 * The preview tab — now with Run: the studio starts and manages the generated
 * app's two dev processes (API + web) on freshly allocated ports and wires the
 * iframe to the reported URL. "running" is only shown once the web port has
 * actually answered — the liveness rule, applied to the app itself.
 *
 * In the hosted version this same surface becomes §4.3: Run wakes the sandbox,
 * exposePort supplies the URL. The manual URL field stays as an escape hatch
 * for apps the user runs in their own terminal.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

type DevState = 'stopped' | 'starting' | 'running' | 'error';

export function PreviewPane() {
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
