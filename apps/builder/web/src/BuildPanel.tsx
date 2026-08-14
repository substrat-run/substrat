/**
 * The live build view for one turn: named phases ticking off, planned files
 * appearing as they are written, assumption chips.
 *
 * Every element reflects real state — phases derive from harness events (the
 * plan call, file writes, per-gate results, the commit), never from timers, and
 * there is deliberately no percentage bar: named steps that tick cannot park at
 * 94%. Chips queue and never interrupt (the plan tool told the model to keep
 * executing); untapped chips disappear silently with the next turn.
 */
import { useMemo } from 'react';
import type { BuildEvent, PlanAssumption } from './api.js';

export interface BuildPanelProps {
	/** All events of the turn that contained the plan, in arrival order. */
	events: BuildEvent[];
	live: boolean;
	queued: readonly PlanAssumption[];
	onToggleChip: (a: PlanAssumption) => void;
}

interface PhaseRow {
	name: string;
	state: 'done' | 'active' | 'pending' | 'failed';
}

export function derivePhases(events: BuildEvent[], live: boolean): PhaseRow[] {
	const wrote = events.some((e) => e.type === 'file-written');
	const checks = events.filter(
		(e): e is Extract<BuildEvent, { type: 'check' }> => e.type === 'check',
	);
	const committed = events.some((e) => e.type === 'commit');
	const gatesStarted = checks.length > 0;

	const rows: PhaseRow[] = [
		{ name: 'Plan', state: 'done' }, // the panel only exists once the plan event arrived
		{
			name: 'Build',
			state: gatesStarted || committed ? 'done' : wrote ? 'active' : live ? 'active' : 'done',
		},
	];
	for (const c of checks) {
		rows.push({
			name: c.result.name,
			state: c.result.status === 'failed' || c.result.status === 'blocked' ? 'failed' : 'done',
		});
	}
	rows.push({
		name: 'Commit',
		state: committed ? 'done' : live ? 'pending' : 'pending',
	});
	return rows;
}

const GLYPH: Record<PhaseRow['state'], string> = {
	done: '✓',
	active: '●',
	pending: '○',
	failed: '✗',
};

export function BuildPanel(props: BuildPanelProps) {
	const plan = props.events.find(
		(e): e is Extract<BuildEvent, { type: 'plan' }> => e.type === 'plan',
	);
	const written = useMemo(
		() =>
			new Map(
				props.events
					.filter(
						(e): e is Extract<BuildEvent, { type: 'file-written' }> => e.type === 'file-written',
					)
					.map((e) => [e.path, e.bytes]),
			),
		[props.events],
	);
	if (!plan) return null;

	const phases = derivePhases(props.events, props.live);
	const queuedIds = new Set(props.queued.map((q) => q.id));

	return (
		<div className="build-panel">
			<div className="bp-summary">{plan.summary}</div>

			<div className="bp-phases">
				{phases.map((p) => (
					<span key={p.name} className={`bp-phase ${p.state}`}>
						<i>{GLYPH[p.state]}</i> {p.name}
					</span>
				))}
			</div>

			<div className="bp-files">
				{plan.files.map((f) => {
					const bytes = written.get(f.path);
					return (
						<div key={f.path} className={`bp-file ${bytes !== undefined ? 'done' : ''}`}>
							<span className="bp-file-glyph">{bytes !== undefined ? '✓' : '·'}</span>
							<span className="bp-file-path">{f.path}</span>
							<span className="bp-file-meta">
								{bytes !== undefined ? `${bytes}b` : f.action}
							</span>
						</div>
					);
				})}
				{/* Files the model wrote that the plan did not name — shown, not hidden:
				    the panel reflects what happened, not what was promised. */}
				{[...written.keys()]
					.filter((p) => !plan.files.some((f) => f.path === p))
					.map((p) => (
						<div key={p} className="bp-file done unplanned">
							<span className="bp-file-glyph">+</span>
							<span className="bp-file-path">{p}</span>
							<span className="bp-file-meta">unplanned</span>
						</div>
					))}
			</div>

			{plan.dependencies.length > 0 && (
				<div className="bp-deps mono">deps: {plan.dependencies.join(' · ')}</div>
			)}

			{plan.assumptions.length > 0 && (
				<div className="bp-chips">
					{plan.assumptions.map((a) => (
						<button
							key={a.id}
							className={`bp-chip ${queuedIds.has(a.id) ? 'queued' : ''}`}
							title={`${a.category} · ${a.reversalCost} reversal cost`}
							onClick={() => props.onToggleChip(a)}
						>
							{queuedIds.has(a.id) ? '✓ ' : ''}
							{a.assumption} — {a.alternative}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
