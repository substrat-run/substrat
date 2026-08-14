/**
 * The generator's knowledge arrives as a PROMPT PREFIX, not as filesystem access.
 *
 * Observed failure this replaces: with a monorepo-rooted workspace and no skills
 * in the prompt, the model spent the start of every session wandering —
 * list_files over demos/, engines/, .claude/ — until it found and read the two
 * SKILL.md files itself, uncached, every time. Correct instincts, wrong
 * mechanism, and a filesystem surface that also exposed things no customer's
 * agent may ever see (apps/*, .env files).
 *
 * So: the skills are read ONCE at boot by the studio (which is trusted) and
 * passed to the generator as its stable, cacheable prefix (§5.4); the generator's
 * workspace is rooted at the project, and everything outside it is a
 * WorkspacePathError by construction.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SKILL_PATHS = [
	'.claude/skills/substrat/SKILL.md', // phase 1: interview → concept the user approves
	'.claude/skills/new-vertical/SKILL.md', // phase 2: approved concept → working vertical
];

export interface LoadedSkills {
	readonly skills: readonly string[];
	readonly loaded: readonly string[];
	readonly missing: readonly string[];
}

/** Reads the skill documents from the studio's own checkout. Missing files are
 * reported, not fatal — a studio without skills still runs, just dumber. */
export async function loadSkills(studioRoot: string): Promise<LoadedSkills> {
	const skills: string[] = [];
	const loaded: string[] = [];
	const missing: string[] = [];
	for (const rel of SKILL_PATHS) {
		try {
			skills.push(await readFile(join(studioRoot, rel), 'utf8'));
			loaded.push(rel);
		} catch {
			missing.push(rel);
		}
	}
	return { skills, loaded, missing };
}
