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
 *
 * WHICH files: the builder-distilled set in `phase.ts`'s SKILL_MANIFEST (D-54)
 * — not the repo's Claude Code skills, which assume monorepo access and denied
 * tools. WHICH of them ride a given turn is the phase ladder (also phase.ts):
 * prefix content changes only at phase boundaries, so each phase's prefix stays
 * byte-stable and caches independently.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SKILL_MANIFEST } from './phase.js';

export interface LoadedSkills {
	/** file path (manifest key) → content, for phase.ts `skillsForPhase`. */
	readonly byFile: ReadonlyMap<string, string>;
	readonly loaded: readonly string[];
	readonly missing: readonly string[];
}

/** Reads the skill documents from the studio's own checkout. Missing files are
 * reported, not fatal — a studio without skills still runs, just dumber. */
export async function loadSkills(studioRoot: string): Promise<LoadedSkills> {
	const byFile = new Map<string, string>();
	const loaded: string[] = [];
	const missing: string[] = [];
	for (const { file } of SKILL_MANIFEST) {
		try {
			byFile.set(file, await readFile(join(studioRoot, file), 'utf8'));
			loaded.push(file);
		} catch {
			missing.push(file);
		}
	}
	return { byFile, loaded, missing };
}
