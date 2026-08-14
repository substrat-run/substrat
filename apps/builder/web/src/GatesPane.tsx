/**
 * The gates tab — the tier-1 gates (§9.1) on demand, same runner the turn loop
 * uses. Output is shown for failures because the gate output IS the feedback.
 */
import { useState } from 'react';
import { api, type GateRun } from './api.js';

const GLYPH: Record<string, string> = { passed: '✓', failed: '✗', blocked: '!', skipped: '–' };

export function GatesPane() {
	const [run, setRun] = useState<GateRun | null>(null);
	const [busy, setBusy] = useState(false);

	async function runGates(): Promise<void> {
		setBusy(true);
		try {
			setRun(await api.gates());
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="gates">
			<p>
				<button className="pill" onClick={() => void runGates()} disabled={busy}>
					{busy ? 'running…' : 'run gates'}
				</button>
				{run && (
					<span style={{ marginLeft: 10 }} className={run.ok ? 'badge ok' : 'badge bad'}>
						{run.ok ? 'all green' : 'red'} · {(run.durationMs / 1000).toFixed(1)}s
					</span>
				)}
			</p>
			{run && (
				<table>
					<tbody>
						{run.results.map((r) => (
							<tr key={r.name}>
								<td>{GLYPH[r.status]}</td>
								<td className="mono">{r.name}</td>
								<td>{r.status}</td>
								<td>{r.status === 'skipped' ? (r.note ?? '') : `${(r.durationMs / 1000).toFixed(1)}s`}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{run?.results
				.filter((r) => r.status === 'failed' || r.status === 'blocked')
				.map((r) => (
					<div key={r.name}>
						<h4 className="mono">{r.name} (exit {r.exitCode})</h4>
						<pre className="out">{r.output}</pre>
					</div>
				))}
		</div>
	);
}
