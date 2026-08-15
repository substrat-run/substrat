/**
 * The studio shell, per the design handoff: 56px top bar (strata glyph, title,
 * project slug, repo badge, model chip), 360px chat, tab pills
 * Preview · Code · Database · Gates.
 *
 * Database is present but disabled: it needs restored-snapshot support
 * (preview-and-snapshots.md) that the platform has not built yet — a visible
 * disabled tab is honest, an absent one hides the roadmap and a fake one lies.
 * Same for "Create preview PR", which needs the push seam.
 */
import { Badge, Button } from '@substrat-run/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setApiTeam, streamTurn, type BuildPhase, type MeInfo, type PlanAssumption, type SessionInfo, type TeamInfo } from './api.js';
import { appendEvent, Chat, type ChatItem } from './Chat.js';
import { CodePane } from './CodePane.js';
import { ConceptPane } from './ConceptPane.js';
import { GatesPane } from './GatesPane.js';
import { ModelPicker } from './ModelPicker.js';
import { PreviewPane } from './PreviewPane.js';
import { ProjectMenu } from './ProjectMenu.js';
import { rememberedTeam, rememberTeam, TeamMenu } from './TeamMenu.js';
import { UsagePane } from './UsagePane.js';

type Tab = 'preview' | 'concept' | 'code' | 'database' | 'gates' | 'usage';

const PHASE_STEPS: readonly { key: BuildPhase; label: string; hint: string }[] = [
	{ key: 'interview', label: 'Interview', hint: 'No approved concept yet — the model asks, one question at a time' },
	{ key: 'scaffold', label: 'Scaffold', hint: 'Concept approved (spec/concept.md) — first build in progress' },
	{ key: 'iterate', label: 'Iterate', hint: 'The module exists — extending against the approved concept' },
];

/**
 * The build-phase ladder, as a stepper. Renders ONLY server-derived state
 * (workspace facts: spec/concept.md, src/module.ts) — the same facts that
 * decide which skills the model carries, so what the user sees IS what the
 * generator is loaded for.
 */
function PhaseStepper(props: { phase: BuildPhase }) {
	const cur = PHASE_STEPS.findIndex((s) => s.key === props.phase);
	return (
		<div className="phase-stepper" role="group" aria-label="build phase">
			{PHASE_STEPS.map((s, i) => (
				<span
					key={s.key}
					title={s.hint}
					className={`phase-step ${i < cur ? 'done' : ''} ${i === cur ? 'current' : ''}`}
				>
					{i < cur ? '✓ ' : ''}{s.label}
				</span>
			))}
		</div>
	);
}

/**
 * The builder mark (logo/builder-mark-*.svg), inlined so the hammer head themes
 * itself: brand-600 in light, brand-400 in dark — the exact colors of the two
 * shipped variants — via one CSS variable instead of an image swap. The amber
 * handle is --layer-vertical in both themes, as in the source files.
 */
function BuilderMark(props: { size?: number }) {
	const s = props.size ?? 22;
	return (
		<svg viewBox="0 0 48 48" width={s} height={s} aria-hidden>
			<g transform="rotate(30 24 24)">
				<rect x="10" y="7" width="28" height="10" rx="3" fill="var(--mark-head)" />
				<rect x="20" y="16" width="8" height="5" fill="var(--mark-head)" />
				<rect x="21" y="19" width="6" height="24" rx="3" fill="var(--layer-vertical)" />
			</g>
		</svg>
	);
}

function toggleTheme(): void {
	const next = document.documentElement.dataset['theme'] === 'dark' ? 'light' : 'dark';
	document.documentElement.dataset['theme'] = next;
	localStorage.setItem('builder-theme', next);
}

export function App() {
	/**
	 * Team resolution (hosted mode): undefined = resolving, null = the local
	 * server (mode A — no teams, no header), an object = hosted with the
	 * memberships listed. Resolved BEFORE any project/session call so every
	 * request carries the right `x-substrat-tenant` from the first fetch.
	 */
	const [me, setMe] = useState<MeInfo | null | undefined>(undefined);
	const [team, setTeam] = useState<TeamInfo | null>(null);
	const [meError, setMeError] = useState<string | null>(null);
	const [session, setSession] = useState<SessionInfo | null>(null);
	// The ladder position shown by the stepper. Sourced ONLY from server truth:
	// the session payload at load, then `phase` events during turns — never
	// inferred client-side, so the stepper cannot show a state that isn't real.
	const [phase, setPhase] = useState<BuildPhase | null>(null);
	const [items, setItems] = useState<ChatItem[]>([]);
	const [busy, setBusy] = useState(false);
	const [tab, setTab] = useState<Tab>('preview');
	const [pickerOpen, setPickerOpen] = useState(false);
	const [refreshKey, setRefreshKey] = useState(0);
	/** Assumption chips the builder tapped — applied later as ONE follow-up turn. */
	const [queued, setQueued] = useState<PlanAssumption[]>([]);

	/**
	 * Liveness: `lastActivity` is bumped by every received chunk (heartbeats
	 * included). While busy, a 1s ticker measures real silence — the indicator
	 * animates only while the request is demonstrably alive, and switches to a
	 * measured "no signal for Ns" once it is not. Nothing here is a fake timer:
	 * the elapsed number is the one thing a timer can honestly report.
	 */
	const lastActivity = useRef(Date.now());
	const [silentForS, setSilentForS] = useState(0);
	const [workLabel, setWorkLabel] = useState('working');
	useEffect(() => {
		if (!busy) return;
		const t = setInterval(
			() => setSilentForS(Math.floor((Date.now() - lastActivity.current) / 1000)),
			1000,
		);
		return () => clearInterval(t);
	}, [busy]);

	function toggleChip(a: PlanAssumption): void {
		setQueued((q) => {
			const on = q.some((x) => x.id === a.id);
			void api.metric({
				kind: on ? 'assumption-untap' : 'assumption-tap',
				id: a.id,
				category: a.category,
				reversalCost: a.reversalCost,
			});
			return on ? q.filter((x) => x.id !== a.id) : [...q, a];
		});
	}

	function applyQueued(): void {
		if (queued.length === 0) return;
		const message =
			'Apply these queued plan alternatives (one edit pass, keep everything else as built):\n' +
			queued.map((a) => `- ${a.alternative} (instead of: ${a.assumption})`).join('\n');
		setQueued([]);
		void send(message);
	}

	function dismissQueued(): void {
		for (const a of queued) void api.metric({ kind: 'assumption-dismiss', id: a.id, category: a.category });
		setQueued([]);
	}

	const refreshSession = useCallback(() => {
		void api.session().then(
			(s) => {
				setSession(s);
				setPhase(s.phase);
			},
			() => setSession(null),
		);
	}, []);

	/** Full reload: session + persisted history. Runs at boot (resume — "pick up
	 * where we were") and after a project switch/create/rename. */
	const reloadProject = useCallback(() => {
		refreshSession();
		void api.history().then((h) =>
			setItems(h.map((t) => ({ kind: t.role, text: t.text }) as ChatItem)),
		);
		setQueued([]);
		setRefreshKey((k) => k + 1);
	}, [refreshSession]);

	// Boot: resolve teams first. The URL's first segment is the team slug
	// (dashboard-style: /<team-slug>); an absent or unknown slug falls back to
	// the remembered team, then the first membership, and the URL is rewritten
	// to match — so a pasted link always lands in the team it names.
	useEffect(() => {
		void api.me().then(
			(m) => {
				setMe(m);
				if (!m || m.teams.length === 0) return; // local mode, or no memberships
				const slugInUrl = window.location.pathname.split('/').filter(Boolean)[0];
				const picked =
					m.teams.find((t) => t.slug === slugInUrl) ??
					m.teams.find((t) => t.id === rememberedTeam()) ??
					m.teams[0]!;
				if (picked.slug !== slugInUrl) window.history.replaceState(null, '', `/${picked.slug}`);
				rememberTeam(picked.id);
				setApiTeam(picked.id);
				setTeam(picked);
			},
			(e) => setMeError(e instanceof Error ? e.message : String(e)),
		);
	}, []);

	// Load the project only once the scope is settled — local mode (me === null)
	// or a pinned team. Before that, any /api call would race the team header.
	const scoped = me === null || team !== null;
	useEffect(() => {
		if (scoped) reloadProject();
	}, [scoped, reloadProject]);

	async function send(message: string): Promise<void> {
		setBusy(true);
		setItems((it) => [...it, { kind: 'user', text: message }]);
		lastActivity.current = Date.now();
		setSilentForS(0);
		setWorkLabel('working');
		// The server always emits a `gates` event at the end of a turn — even when
		// the generator failed — so a stream that closes without one died early.
		let sawGates = false;
		try {
			await streamTurn(
				message,
				(e) => {
					// Phase events feed the stepper, not the transcript — a line per
					// turn start would be noise; the stepper is the visualization.
					if (e.type === 'phase') {
						setPhase(e.phase);
						return;
					}
					if (e.type === 'gates') sawGates = true;
					// The moment the interview lands the concept, show it — this is the
					// document the whole interview exists to produce.
					if (e.type === 'file-written' && e.path.endsWith('spec/concept.md')) {
						setTab('concept');
					}
					if (e.type === 'thinking') setWorkLabel('thinking');
					else if (e.type === 'tool-call') setWorkLabel(`${e.tool}: ${e.summary.slice(0, 60)}`);
					else if (e.type === 'file-written') setWorkLabel(`writing ${e.path}`);
					else if (e.type === 'check') setWorkLabel(`gate: ${e.result.name}`);
					setItems((it) => appendEvent(it, e));
				},
				() => {
					lastActivity.current = Date.now();
				},
			);
			if (!sawGates) {
				setItems((it) => [
					...it,
					{
						kind: 'event',
						e: {
							type: 'error',
							message:
								'The stream ended before the turn completed. The server may still be finishing it — the result will be in the project on the next turn; nothing is lost (every turn commits).',
							fatal: false,
						},
					},
				]);
			}
		} catch (e) {
			setItems((it) => [
				...it,
				{
					kind: 'event',
					e: {
						type: 'error',
						message: `Connection lost mid-turn: ${(e as Error).message}. The server keeps running the turn and commits it; re-send only if the next session state shows no result.`,
						fatal: true,
					},
				},
			]);
		} finally {
			setBusy(false);
			setRefreshKey((k) => k + 1);
			refreshSession();
		}
	}

	const provider = session?.modelSpec.split(':')[0] ?? '';
	const model = session?.modelSpec.split(':')[1] ?? session?.modelSpec ?? '';
	const slug = session?.vertical.split('/').pop() ?? '…';

	// Hosted-mode dead ends, honestly stated: a membership lookup that failed is
	// an error (NOT silently treated as local mode), and an account with no team
	// yet has nowhere to build — teams are created in the dashboard.
	if (meError) {
		return (
			<div className="app">
				<div className="note">Could not resolve your teams: {meError}. Reload to retry.</div>
			</div>
		);
	}
	if (me && me.teams.length === 0) {
		return (
			<div className="app">
				<div className="note">
					Your account has no team yet. Create one in the dashboard, then come back — builder
					projects live in a team.
				</div>
			</div>
		);
	}
	// Nothing renders until the scope is settled: panes fetch on mount
	// (PreviewPane polls /api/dev immediately), and before the team is pinned
	// those requests would go out headerless and be refused with a 400.
	if (!scoped) {
		return (
			<div className="app">
				<div className="note">Resolving your teams…</div>
			</div>
		);
	}

	return (
		<div className="app">
			<header className="header">
				<BuilderMark />
				<h1>
					<span className="wm-builder">Builder</span> <span className="wm-studio">Studio</span>
				</h1>
				{me && team && (
					<>
						<span className="sep">·</span>
						<TeamMenu teams={me.teams} current={team} busy={busy} />
					</>
				)}
				<span className="sep">·</span>
				{session ? (
					<ProjectMenu
						name={session.project.name}
						dir={session.vertical}
						busy={busy}
						onChanged={reloadProject}
					/>
				) : (
					<span className="slug mono">{slug}</span>
				)}
				{session && (
					<Badge status={session.repoMode === 'project' ? 'brand' : 'warning'} dot={false}>
						{session.repoMode === 'project' ? 'own repo · main' : 'scoped · monorepo'}
					</Badge>
				)}
				{phase && <PhaseStepper phase={phase} />}
				{session?.modelError && <Badge status="danger">model unavailable</Badge>}
				<span className="spacer" />
				<button className="icon-btn" onClick={toggleTheme} title="Toggle light/dark theme">◐</button>
				<button
					className="model-chip"
					onClick={() => setPickerOpen(true)}
					title={session ? `${provider} · ${session.endpoint ?? 'default endpoint'}` : undefined}
				>
					{model}
					<span className="where">{provider}</span>
					<span className="chev">▾</span>
				</button>
				<span title="Requires the push seam (self-serve-deploy.md) — not wired yet">
					<Button size="sm" disabled>Create preview PR</Button>
				</span>
			</header>

			{session && session.foreign.length > 0 && (
				<div className="note">
					{session.foreign.length} uncommitted file(s) outside {session.vertical} — left alone;
					commits are scoped to the vertical
				</div>
			)}

			<div className="main">
				<div className="chat-col">
					{/* Post-build apply: queued chips become one follow-up edit turn.
					    Dismissible; never blocks; generation never waited on it. */}
					{!busy && queued.length > 0 && (
						<div className="apply-bar">
							<span>
								{queued.length} change{queued.length === 1 ? '' : 's'} queued
							</span>
							<Button size="sm" onClick={applyQueued}>Apply</Button>
							<Button size="sm" variant="ghost" onClick={dismissQueued}>Dismiss</Button>
						</div>
					)}
					<Chat
						items={items}
						busy={busy}
						liveness={{ label: workLabel, silentForS }}
						queued={queued}
						onToggleChip={toggleChip}
						onSend={(m) => void send(m)}
						onAbort={() => void api.abort()}
					/>
				</div>
				<div className="right-col">
					<nav className="tabs">
						<button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
							Preview
						</button>
						<button className={tab === 'concept' ? 'active' : ''} onClick={() => setTab('concept')}>
							Concept
						</button>
						<button className={tab === 'code' ? 'active' : ''} onClick={() => setTab('code')}>
							Code
						</button>
						<button
							disabled
							title="Requires restored-snapshot support (preview-and-snapshots.md) — not built yet"
						>
							Database
						</button>
						<button className={tab === 'gates' ? 'active' : ''} onClick={() => setTab('gates')}>
							Gates
						</button>
						<button className={tab === 'usage' ? 'active' : ''} onClick={() => setTab('usage')}>
							Usage
						</button>
					</nav>
					<div className="pane">
						{tab === 'preview' && <PreviewPane />}
						{tab === 'concept' && session && (
							<ConceptPane vertical={session.vertical} refreshKey={refreshKey} />
						)}
						{tab === 'code' && session && (
							<CodePane vertical={session.vertical} refreshKey={refreshKey} />
						)}
						{tab === 'gates' && <GatesPane />}
						{tab === 'usage' && <UsagePane />}
					</div>
				</div>
			</div>

			{pickerOpen && session && (
				<ModelPicker
					current={session.modelSpec}
					onPicked={() => {
						setPickerOpen(false);
						refreshSession();
					}}
					onClose={() => setPickerOpen(false)}
				/>
			)}
		</div>
	);
}
