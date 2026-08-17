/**
 * The build-phase ladder (D-54 follow-up): which skills ride in the prompt
 * prefix is decided by WORKSPACE FACTS, never by model self-report — a phase
 * the loader can't detect at turn start is a phase it can't enforce. The
 * ladder is monotonic in practice (concept lands, then the module lands), and
 * prefix content changes ONLY at these boundaries, so each phase's prefix
 * stays byte-stable and caches independently (§token-economy). Anything
 * finer-grained than a phase belongs behind a read tool, not in the prefix.
 *
 * Worker-safe on purpose: server.ts and the agent DO both import this, so the
 * two hosts cannot drift on what a phase means.
 */

import type { BuildPhase } from '@substrat-run/builder-generator';

/** Re-exported: the ladder's semantics live here, the type lives where the event needs it. */
export type { BuildPhase };

export const PHASES: readonly BuildPhase[] = ['interview', 'model', 'scaffold', 'iterate'];

/** The slice of Workspace this module needs — keeps it importable anywhere. */
interface HasExists {
	exists(path: string): Promise<boolean>;
}

/**
 * interview → no approved concept yet; **model** → concept approved, no declared
 * model yet; scaffold → model approved, no module code yet; iterate → the module
 * exists and the project's own files are the reference. Paths are relative to
 * the PROJECT workspace root.
 *
 * The model phase (#680) exists because the build was making design decisions
 * and stabilising them through the gates at the same time. Entities, operations,
 * permissions and returns are decided ONCE, in an artifact a human approves,
 * before any handler is written.
 */
export async function detectPhase(projectWs: HasExists): Promise<BuildPhase> {
	if (!(await projectWs.exists('spec/concept.md'))) return 'interview';
	if (!(await projectWs.exists('spec/model.ts'))) return 'model';
	if (!(await projectWs.exists('src/module.ts'))) return 'scaffold';
	return 'iterate';
}

/** Phases whose turns write the spec rather than the code. */
export function isSpecPhase(phase: BuildPhase): boolean {
	return phase === 'interview' || phase === 'model';
}

/**
 * The write guard for interview turns — the ladder's teeth. The transcript that
 * motivated it: a model presented the concept in prose, got approval, then
 * scaffolded code without ever writing spec/concept.md — so the phase never
 * left interview, the scaffold skills never loaded, and the session dead-ended.
 * Refusing non-spec writes during interview turns makes that impossible; the
 * refusal message tells the model the one action that unblocks it.
 */
export function interviewWriteGuard(path: string): string | null {
	const p = path.replace(/^\.\//, '');
	if (p === 'spec' || p.startsWith('spec/')) return null;
	return (
		'interview turns write only spec/** — when the builder approves the concept, ' +
		'write spec/concept.md and end the turn; the model phase begins next turn ' +
		'with the model references loaded'
	);
}

/**
 * The model phase writes only the spec, for the same reason interview does.
 */
export function modelWriteGuard(path: string): string | null {
	const p = path.replace(/^\.\//, '');
	if (p === 'spec' || p.startsWith('spec/')) return null;
	return (
		'model turns write only spec/** — declare the entities and operations in ' +
		'spec/model.ts and end the turn; the scaffold begins next turn, and it ' +
		'transcribes this model rather than re-deciding it'
	);
}

/**
 * The MIRROR of the spec guards, and the mechanical half of the direction rule:
 * the model changes because the business changed or was misunderstood, never to
 * accommodate what got built.
 *
 * Downstream may FALSIFY the model — a handler that cannot return what the model
 * declares is real information — but it may not AUTHOR it. Without this a
 * failing build can quietly redraw the contract at continuation 14 and everything
 * agrees again, which is how 159 operations come to match a model that is wrong
 * 51 times.
 *
 * A genuine modelling error therefore STOPS the build rather than being worked
 * around: re-enter the model phase, where the change is visible and approved.
 */
export function buildWriteGuard(path: string): string | null {
	const p = path.replace(/^\.\//, '');
	if (!/^spec\/model\./.test(p)) return null;
	return (
		'build turns cannot write spec/model.* — the model changes only from ' +
		'upstream (a requirement, a corrected understanding of the domain), never ' +
		'to make a build pass. If the model is genuinely wrong, say so and stop: ' +
		'it is corrected in the model phase, not here'
	);
}

export interface SkillManifestEntry {
	/** Path relative to the STUDIO checkout root (the trusted side, §5.4). */
	readonly file: string;
	readonly phases: readonly BuildPhase[];
}

/**
 * Ordered — the order here is the order in the prompt prefix. platform.md is
 * the always-on grounding (engine coverage map); interview.md the question
 * craft + concept template; scaffold.md the code skeletons (dropped once the
 * project's own module is the better reference); iterate.md the patterns and
 * test truths that hold for the project's whole life.
 */
export const SKILL_MANIFEST: readonly SkillManifestEntry[] = [
	{ file: 'apps/builder/skills/platform.md', phases: ['interview', 'scaffold', 'iterate'] },
	{ file: 'apps/builder/skills/interview.md', phases: ['interview'] },
	{ file: 'apps/builder/skills/model.md', phases: ['model'] },
	{ file: 'apps/builder/skills/scaffold.md', phases: ['scaffold'] },
	{ file: 'apps/builder/skills/iterate.md', phases: ['scaffold', 'iterate'] },
];

/** Filter loaded skill contents (parallel to SKILL_MANIFEST order) to a phase. */
export function skillsForPhase(
	loaded: ReadonlyMap<string, string>,
	phase: BuildPhase,
): string[] {
	return SKILL_MANIFEST.filter((e) => e.phases.includes(phase))
		.map((e) => loaded.get(e.file))
		.filter((s): s is string => Boolean(s));
}
