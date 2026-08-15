/**
 * The usage tab — the studio's token spend, read from its own metering scope
 * (#646, /api/usage). Tiles for the headline numbers, a stacked daily bar
 * chart (input + output tokens per UTC day, last 30 days), and a per-project
 * table that doubles as the chart's accessible table view.
 *
 * Chart discipline (dataviz): series colors are validated per theme
 * (--viz-input / --viz-output in styles.css), marks are thin with 2px surface
 * gaps between bars and stacked segments, the data-end is 4px-rounded, text
 * wears text tokens (identity is carried by the legend chips), and every bar
 * has a hover tooltip with a hit target wider than the mark.
 */
import { useEffect, useRef, useState } from 'react';
import { api, type ProjectInfo, type UsageDay, type UsageReport } from './api.js';

const fmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('en');
const usd = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' });

/** Server cost strings are exact decimals; Number() only for display rounding. */
const money = (s: string | null) => (s === null ? '—' : usd.format(Number(s)));

/** The window's days, oldest first, zero-filled — silence is a 0-height day, not a missing one. */
function fillDays(daily: UsageDay[], windowDays: number): UsageDay[] {
	const byDate = new Map(daily.map((d) => [d.date, d]));
	const out: UsageDay[] = [];
	for (let i = windowDays - 1; i >= 0; i--) {
		const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
		out.push(byDate.get(date) ?? { date, input: 0, output: 0 });
	}
	return out;
}

/** A rect whose TOP corners are rounded — the data-end; the baseline end stays square. */
function topRounded(x: number, y: number, w: number, h: number): string {
	const r = Math.min(4, w / 2, h);
	return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

interface Hover {
	day: UsageDay;
	cx: number;
}

function DailyChart({ days }: { days: UsageDay[] }) {
	const wrap = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(560);
	const [hover, setHover] = useState<Hover | null>(null);

	useEffect(() => {
		const el = wrap.current;
		if (!el) return;
		const measure = () => setWidth(Math.max(320, el.clientWidth));
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const H = 168;
	const padTop = 8;
	const padBottom = 20;
	const plotH = H - padTop - padBottom;
	const max = Math.max(1, ...days.map((d) => d.input + d.output));
	const slot = width / days.length;
	const barW = Math.max(3, Math.min(18, slot - 2)); // ≥2px gap between adjacent bars
	const y = (v: number) => padTop + plotH * (1 - v / max);

	return (
		<div className="usage-chart" ref={wrap}>
			<div className="usage-legend">
				<span>
					<i className="chip" style={{ background: 'var(--viz-input)' }} /> Input tokens
				</span>
				<span>
					<i className="chip" style={{ background: 'var(--viz-output)' }} /> Output tokens
				</span>
			</div>
			<svg width={width} height={H} role="img" aria-label="Tokens per day, last 30 days">
				{/* recessive grid: baseline + midline + max label */}
				<line x1={0} y1={y(0)} x2={width} y2={y(0)} className="usage-axis" />
				<line x1={0} y1={y(max / 2)} x2={width} y2={y(max / 2)} className="usage-grid" />
				<text x={4} y={y(max) + 10} className="usage-tick">
					{fmt.format(max)}
				</text>
				{days.map((d, i) => {
					const x = i * slot + (slot - barW) / 2;
					const inH = (d.input / max) * plotH;
					const outH = (d.output / max) * plotH;
					const inY = y(0) - inH;
					// 2px surface gap between stacked segments (drawn only when both exist).
					const gap = d.input > 0 && d.output > 0 ? 2 : 0;
					const outY = inY - gap - outH;
					const marks = [] as React.ReactNode[];
					if (d.input > 0 && d.output > 0) {
						marks.push(
							<rect key="in" x={x} y={inY} width={barW} height={inH} fill="var(--viz-input)" />,
							<path key="out" d={topRounded(x, outY, barW, outH)} fill="var(--viz-output)" />,
						);
					} else if (d.input > 0) {
						marks.push(<path key="in" d={topRounded(x, inY, barW, inH)} fill="var(--viz-input)" />);
					} else if (d.output > 0) {
						marks.push(
							<path key="out" d={topRounded(x, y(0) - outH, barW, outH)} fill="var(--viz-output)" />,
						);
					}
					return (
						<g key={d.date}>
							{marks}
							{/* full-height hit target, wider than the mark */}
							<rect
								x={i * slot}
								y={0}
								width={slot}
								height={H}
								fill="transparent"
								onMouseEnter={() => setHover({ day: d, cx: i * slot + slot / 2 })}
								onMouseLeave={() => setHover(null)}
							/>
						</g>
					);
				})}
				{/* sparse x labels: first, middle, last */}
				{[0, Math.floor(days.length / 2), days.length - 1].map((i) => (
					<text
						key={i}
						x={i * slot + slot / 2}
						y={H - 6}
						textAnchor="middle"
						className="usage-tick"
					>
						{days[i]!.date.slice(5)}
					</text>
				))}
			</svg>
			{hover && (
				<div
					className="usage-tooltip"
					style={{ left: Math.min(Math.max(hover.cx, 70), width - 70) }}
				>
					<div className="usage-tooltip-date">{hover.day.date}</div>
					<div>
						<i className="chip" style={{ background: 'var(--viz-input)' }} /> in{' '}
						{full.format(hover.day.input)}
					</div>
					<div>
						<i className="chip" style={{ background: 'var(--viz-output)' }} /> out{' '}
						{full.format(hover.day.output)}
					</div>
					<div className="usage-tooltip-total">Σ {full.format(hover.day.input + hover.day.output)}</div>
				</div>
			)}
		</div>
	);
}

export function UsagePane() {
	const [report, setReport] = useState<UsageReport | null>(null);
	const [names, setNames] = useState<Map<string, string>>(new Map());
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void api.usage().then(setReport, (e: Error) => setError(e.message));
		void api
			.projects()
			.then(({ projects }: { projects: ProjectInfo[] }) =>
				setNames(new Map(projects.map((p) => [p.id, p.name]))),
			)
			.catch(() => undefined);
	}, []);

	if (error) return <div className="usage empty">Usage unavailable: {error}</div>;
	if (!report) return <div className="usage empty">Loading usage…</div>;

	const windowTotal = report.daily.reduce((s, d) => s + d.input + d.output, 0);
	const allTime = report.totals.input + report.totals.output;

	if (allTime === 0) {
		return (
			<div className="usage empty">
				No usage recorded yet — the meter starts with the first turn after this deploys.
			</div>
		);
	}

	return (
		<div className="usage">
			<div className="usage-tiles">
				<div className="usage-tile">
					<div className="usage-tile-label">Last {report.windowDays} days</div>
					<div className="usage-tile-value">{fmt.format(windowTotal)}</div>
					<div className="usage-tile-sub">tokens</div>
				</div>
				<div className="usage-tile">
					<div className="usage-tile-label">All-time input</div>
					<div className="usage-tile-value">{fmt.format(report.totals.input)}</div>
					<div className="usage-tile-sub">tokens</div>
				</div>
				<div className="usage-tile">
					<div className="usage-tile-label">All-time output</div>
					<div className="usage-tile-value">{fmt.format(report.totals.output)}</div>
					<div className="usage-tile-sub">tokens</div>
				</div>
				<div className="usage-tile">
					<div className="usage-tile-label">All-time total</div>
					<div className="usage-tile-value">{fmt.format(allTime)}</div>
					<div className="usage-tile-sub">tokens</div>
				</div>
				<div className="usage-tile">
					<div className="usage-tile-label">All-time cost</div>
					<div className="usage-tile-value">{money(report.cost.billedUsd)}</div>
					<div className="usage-tile-sub">
						{report.cost.unpricedTokens > 0
							? `+ ${fmt.format(report.cost.unpricedTokens)} unpriced tokens`
							: `incl. ${report.markupPercent}% markup`}
					</div>
				</div>
			</div>

			<DailyChart days={fillDays(report.daily, report.windowDays)} />

			<table className="usage-table">
				<thead>
					<tr>
						<th>Model</th>
						<th>Input</th>
						<th>Output</th>
						<th>List</th>
						<th>Billed</th>
					</tr>
				</thead>
				<tbody>
					{report.byModel.map((m) => (
						<tr key={m.model ?? '(unattributed)'}>
							<td>{m.model ?? 'unattributed (pre-model entries)'}</td>
							<td>{full.format(m.input)}</td>
							<td>{full.format(m.output)}</td>
							<td>{money(m.listUsd)}</td>
							<td>{money(m.billedUsd)}</td>
						</tr>
					))}
				</tbody>
			</table>
			<div className="usage-footnote">
				Billed = provider list price + {report.markupPercent}% markup. Models without a rate card
				entry show “—” and count toward unpriced tokens.
			</div>

			<table className="usage-table">
				<thead>
					<tr>
						<th>Project</th>
						<th>Turns</th>
						<th>Input</th>
						<th>Output</th>
						<th>Total</th>
					</tr>
				</thead>
				<tbody>
					{report.byProject.map((p) => (
						<tr key={p.projectId}>
							<td>{names.get(p.projectId) ?? p.projectId}</td>
							<td>{full.format(p.turns)}</td>
							<td>{full.format(p.input)}</td>
							<td>{full.format(p.output)}</td>
							<td>{full.format(p.input + p.output)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
