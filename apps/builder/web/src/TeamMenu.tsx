/**
 * The team switcher in the top bar — the studio's analog of the dashboard's
 * sidebar switcher (dashboard-teams.md), hosted mode only. The current team's
 * slug is the URL's first segment; switching navigates to `/<slug>` with a full
 * reload, so the whole studio re-scopes server-side (per-team DO, per-team
 * projects) exactly like the dashboard does on switch. Teams are created in the
 * dashboard, not here — the studio only ever picks among existing memberships.
 */
import { useEffect, useRef, useState } from 'react';
import type { TeamInfo } from './api.js';

const REMEMBER_KEY = 'builder-team';

export function rememberTeam(id: string): void {
	localStorage.setItem(REMEMBER_KEY, id);
}

export function rememberedTeam(): string | null {
	return localStorage.getItem(REMEMBER_KEY);
}

export function TeamMenu(props: { teams: TeamInfo[]; current: TeamInfo; busy: boolean }) {
	const [open, setOpen] = useState(false);
	const menuRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (!open) return;
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

	function switchTo(t: TeamInfo): void {
		setOpen(false);
		if (t.id === props.current.id) return;
		rememberTeam(t.id);
		// Full reload, dashboard-style: the DO behind every endpoint changes.
		window.location.assign(`/${t.slug}`);
	}

	return (
		<span className="project-menu team-menu" ref={menuRef}>
			<button
				className="project-name team-name"
				title={`Team — projects are per team`}
				onClick={() => !props.busy && setOpen((o) => !o)}
				disabled={props.busy}
			>
				{props.current.name}
				<span className="chev">▾</span>
			</button>
			{open && (
				<div className="project-dropdown">
					{props.teams.map((t) => (
						<button
							key={t.id}
							className={`pd-row ${t.id === props.current.id ? 'current' : ''}`}
							onClick={() => switchTo(t)}
						>
							<span className="pd-name">{t.name}</span>
							<span className="pd-dir mono">{t.slug}</span>
						</button>
					))}
					<div className="pd-row muted">New teams are created in the dashboard</div>
				</div>
			)}
		</span>
	);
}
