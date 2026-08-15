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

export type BuildPhase = 'interview' | 'scaffold' | 'iterate';

export const PHASES: readonly BuildPhase[] = ['interview', 'scaffold', 'iterate'];

/** The slice of Workspace this module needs — keeps it importable anywhere. */
interface HasExists {
	exists(path: string): Promise<boolean>;
}

/**
 * interview → no approved concept yet; scaffold → concept approved, no module
 * code yet; iterate → the module exists and the project's own files are the
 * reference. Paths are relative to the PROJECT workspace root.
 */
export async function detectPhase(projectWs: HasExists): Promise<BuildPhase> {
	if (!(await projectWs.exists('spec/concept.md'))) return 'interview';
	if (!(await projectWs.exists('src/module.ts'))) return 'scaffold';
	return 'iterate';
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
		'write spec/concept.md and end the turn; the scaffold begins next turn with ' +
		'the scaffold references loaded'
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
