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
import { normalise } from './project-path.js';

/** Re-exported: the ladder's semantics live here, the type lives where the event needs it. */
export type { BuildPhase };

export const PHASES: readonly BuildPhase[] = ['interview', 'model', 'scenario', 'scaffold', 'iterate'];

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
	// The tests come BEFORE the code they judge. A suite written afterwards can
	// only agree with whatever got built; written first, it is the second
	// description the build has to satisfy.
	if (!(await projectWs.exists('test/scenario.test.ts'))) return 'scenario';
	if (!(await projectWs.exists('src/module.ts'))) return 'scaffold';
	return 'iterate';
}

/** Phases whose turns write the spec rather than the code. */
export function isSpecPhase(phase: BuildPhase): boolean {
	return phase === 'interview' || phase === 'model';
}

/**
 * The path a guard judges: the one the workspace will actually write. Every
 * guard here is a prefix test, and a prefix test over the RAW path is fooled by
 * `app/../src/module.ts`, which starts with `app/` and lands in `src/`. The
 * workspace resolves `.` and `..` lexically before it writes (local.ts), so the
 * guard resolves them the same way first, with the normaliser the studio's file
 * routes use (#1225), so the two cannot answer differently for one path. A path
 * that climbs above the root is returned still climbing, so it matches no
 * allowed prefix (the workspace refuses it anyway).
 */
export const guardPath: (path: string) => string = normalise;

/**
 * The write guard for interview turns — the ladder's teeth. The transcript that
 * motivated it: a model presented the concept in prose, got approval, then
 * scaffolded code without ever writing spec/concept.md — so the phase never
 * left interview, the scaffold skills never loaded, and the session dead-ended.
 * Refusing non-spec writes during interview turns makes that impossible; the
 * refusal message tells the model the one action that unblocks it.
 */
export function interviewWriteGuard(path: string): string | null {
	const p = guardPath(path);
	if (p === 'spec' || p.startsWith('spec/')) return null;
	return (
		'interview turns write only spec/** — when the builder approves the concept, ' +
		'write spec/concept.md and end the turn; the model phase begins next turn ' +
		'with the model references loaded'
	);
}

/**
 * The scenario phase writes only `test/**` — the suite, before the code.
 *
 * Its gate is not "the tests pass": they cannot, since nothing implements them
 * yet. It is that they exist and are honest. What makes this worth a phase of
 * its own is the direction: a test written after the handler is a mirror of the
 * handler, and a mirror cannot disagree with what it reflects.
 */
export function scenarioWriteGuard(path: string): string | null {
	const p = guardPath(path);
	if (p === 'test' || p.startsWith('test/')) return null;
	return (
		'scenario turns write only test/** — replay the concept\'s scenario as a failing ' +
		'suite and end the turn; the build begins next turn and its job is to make ' +
		'these pass, not to edit them'
	);
}

/**
 * The model phase writes only the spec, for the same reason interview does.
 */
export function modelWriteGuard(path: string): string | null {
	const p = guardPath(path);
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
	const p = guardPath(path);
	// The oracle is not the build's to rewrite. A suite the build may edit is a
	// suite that agrees with whatever got built — the same failure as a model
	// redrawn at continuation 14, one level down. `test/server.test.ts` and any
	// other suite the build ADDS stay writable; only the scenario is frozen.
	if (/^test\/scenario\.test\./.test(p)) {
		return (
			'build turns cannot write test/scenario.test.* — it is the concept\'s claim ' +
			'about this app, written before the code so it could disagree with it. If an ' +
			'assertion is genuinely wrong, say so and stop: it is corrected where it came ' +
			'from, not here'
		);
	}
	if (!/^spec\/model\./.test(p)) return null;
	return (
		'build turns cannot write spec/model.* — the model changes only from ' +
		'upstream (a requirement, a corrected understanding of the domain), never ' +
		'to make a build pass. If the model is genuinely wrong, say so and stop: ' +
		'it is corrected in the model phase, not here'
	);
}

/**
 * The write guard for a phase — the ladder's teeth, as ONE dispatch.
 *
 * It lives here rather than at each call site because it had already drifted:
 * `server.ts` applied these guards and the eval CLI did not, under a comment
 * claiming "byte-identical construction to server.ts makeGenerator". So the
 * studio enforced the ladder and the harness that is supposed to MEASURE the
 * studio did not — an interview turn in an eval could write code, leave
 * `spec/concept.md` unwritten, and dead-end exactly as the transcript above
 * describes, while the same run in the studio was refused.
 *
 * A harness that drives the generator through a different ladder measures the
 * wrong thing (harness.ts §3), so there is now one function and both hosts call
 * it. A lane of a laned build turn (#682) is part of the same dispatch, for the
 * same reason.
 */
export function writeGuardFor(phase: BuildPhase, lane?: BuildLane): (path: string) => string | null {
	if (lane && isLanedPhase(phase)) return lane === 'api' ? apiLaneWriteGuard : uiLaneWriteGuard;
	if (phase === 'interview') return interviewWriteGuard;
	if (phase === 'model') return modelWriteGuard;
	if (phase === 'scenario') return scenarioWriteGuard;
	return buildWriteGuard;
}

/**
 * The build's lanes (#682): one build turn run as two passes over the same
 * workspace, API first, then UI, with disjoint write guards. Each lane carries a
 * smaller prompt prefix and a shorter tool transcript than one pass that does
 * everything. Whether that saves tokens is a claim for the eval sweep (#630) to
 * referee, which is why lanes are opt-in.
 *
 * The UI lane comes second because it consumes what the API lane builds. Both
 * read the same declared model, so the UI lane is never guessing at the surface.
 */
export type BuildLane = 'api' | 'ui';

export const LANES: readonly BuildLane[] = ['api', 'ui'];

/** Only build turns are laned; spec and scenario turns are one pass, as before. */
export function isLanedPhase(phase: BuildPhase): boolean {
	return phase === 'scaffold' || phase === 'iterate';
}

/** The UI lane's whole territory. */
const UI_ROOT = 'app';

/**
 * Where the UI lane records an operation it needed and the API does not offer.
 * Inside `app/` on purpose: recording a gap must not require reaching across
 * the guard it is reporting on.
 */
export const CONTRACT_GAPS_FILE = 'app/CONTRACT-GAPS.md';

const underUi = (p: string): boolean => p === UI_ROOT || p.startsWith(`${UI_ROOT}/`);

/**
 * The API lane writes everything EXCEPT `app/**`, under the build guard.
 *
 * The complement, not a `src/** + test/** + migrations/**` allowlist: the
 * scaffold also writes the root `package.json` and `tsconfig.json`. The lanes
 * stay disjoint because `app/**` belongs to exactly one of them.
 */
export function apiLaneWriteGuard(path: string): string | null {
	const p = guardPath(path);
	if (underUi(p)) {
		return (
			'the API lane cannot write app/** — the UI lane runs after you in this same ' +
			'turn and owns the screens. Finish the API (routes, operations, migrations, ' +
			'tests) and end the pass'
		);
	}
	return buildWriteGuard(p);
}

/**
 * The UI lane writes `app/**` only. A missing endpoint is not its to add: it
 * records the gap and the next turn's API lane reads it. That is the
 * additive-only surface discipline at build time, made mechanical.
 */
export function uiLaneWriteGuard(path: string): string | null {
	const p = guardPath(path);
	if (underUi(p)) return null;
	return (
		`the UI lane writes only app/** — ${p} belongs to the API lane. If the screens ` +
		`need an operation or field the API does not offer, add one line to ` +
		`${CONTRACT_GAPS_FILE} ("- <operation>: <what the screen needs>") and build the ` +
		'screen against what exists; the API lane reads that file next turn'
	);
}

/**
 * The bound on what the gap ledger can put into the next turn. The file is
 * written by a model, so it is read as untrusted input: only `- ` bullet lines
 * count, duplicates collapse, each line is clipped, and the count is capped. A
 * UI lane that loops on the same gap, or pastes a file into the ledger, cannot
 * grow the API lane's context past this.
 */
export const MAX_CONTRACT_GAPS = 20;
export const MAX_CONTRACT_GAP_CHARS = 200;

export function parseContractGaps(text: string): { gaps: string[]; dropped: number } {
	const seen = new Set<string>();
	const gaps: string[] = [];
	let dropped = 0;
	for (const line of text.split('\n')) {
		const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
		if (!m?.[1]) continue;
		const gap = m[1].replace(/\s+/g, ' ').slice(0, MAX_CONTRACT_GAP_CHARS);
		const key = gap.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (gaps.length < MAX_CONTRACT_GAPS) gaps.push(gap);
		else dropped += 1;
	}
	return { gaps, dropped };
}

export interface SkillManifestEntry {
	/** Path relative to the STUDIO checkout root (the trusted side, §5.4). */
	readonly file: string;
	readonly phases: readonly BuildPhase[];
	/**
	 * The phases each lane of a laned build turn carries it in (#682). Absent
	 * means the API lane, in `phases`: everything but the screens is the API's.
	 */
	readonly lanes?: { readonly [L in BuildLane]?: readonly BuildPhase[] };
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
	{ file: 'apps/builder/skills/scenario.md', phases: ['scenario'] },
	{ file: 'apps/builder/skills/scaffold.md', phases: ['scaffold'] },
	{ file: 'apps/builder/skills/iterate.md', phases: ['scenario', 'scaffold', 'iterate'] },
	// The screens, moved out of scaffold.md: unlaned, in the phase scaffold.md
	// carried them; laned, the UI lane's whole prefix in every build phase.
	{ file: 'apps/builder/skills/ui.md', phases: ['scaffold'], lanes: { ui: ['scaffold', 'iterate'] } },
];

/** The phases an entry rides in: unlaned, or in one lane of a laned turn. */
function phasesOf(e: SkillManifestEntry, lane: BuildLane | undefined): readonly BuildPhase[] {
	if (!lane) return e.phases;
	if (e.lanes) return e.lanes[lane] ?? [];
	return lane === 'api' ? e.phases : [];
}

/**
 * Filter loaded skill contents (parallel to SKILL_MANIFEST order) to a phase,
 * or to one lane of a laned build turn (#682).
 */
export function skillsForPhase(
	loaded: ReadonlyMap<string, string>,
	phase: BuildPhase,
	lane?: BuildLane,
): string[] {
	const useLane = lane && isLanedPhase(phase) ? lane : undefined;
	return SKILL_MANIFEST.filter((e) => phasesOf(e, useLane).includes(phase))
		.map((e) => loaded.get(e.file))
		.filter((s): s is string => Boolean(s));
}

/**
 * The context a build turn is given: the concept always, and the declared model
 * once it exists (#681).
 *
 * The model is APPENDED to the concept block rather than threaded as a second
 * parameter — the same seam, so the two hosts cannot drift on what a turn sees.
 * Read from the workspace on every turn, never carried in memory: the file on
 * disk is the artifact of record.
 */
export async function buildContext(
	ws: { exists(p: string): Promise<boolean>; readFile(p: string): Promise<string> },
	phase: BuildPhase,
): Promise<string> {
	if (phase === 'interview') {
		return '(no concept document yet — interview the builder before writing code)';
	}
	const concept = await ws.readFile('spec/concept.md');
	if (phase === 'model' || !(await ws.exists('spec/model.ts'))) return concept;
	const model = await ws.readFile('spec/model.ts');
	return `${concept}\n\n${modelBlock(model, 'transcribe, do not re-derive')}`;
}

/** The declared model as a turn sees it: marked approved, with what to do with it. */
function modelBlock(model: string, note: string): string {
	return `--- spec/model.ts (APPROVED — ${note}) ---\n\n${model}\n\n--- end spec/model.ts ---`;
}

type ContextWorkspace = Parameters<typeof buildContext>[0];

/**
 * The concept's screens section, or null when it names none. Matched by heading
 * rather than by section number: the interview template numbers it, a
 * hand-written concept may not.
 */
export function screensSection(concept: string): string | null {
	const lines = concept.split('\n');
	const start = lines.findIndex((l) => /^#{1,6}\s.*\bscreens?\b/i.test(l));
	if (start === -1) return null;
	const level = /^(#+)/.exec(lines[start] ?? '')?.[1]?.length ?? 2;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const m = /^(#+)\s/.exec(lines[i] ?? '');
		if (m?.[1] && m[1].length <= level) {
			end = i;
			break;
		}
	}
	return lines.slice(start, end).join('\n').trim();
}

/** "API-only for now" is a valid screens section (interview.md §8) and means no app. */
const apiOnly = (section: string): boolean => /\bapi[- ]only\b/i.test(section);

/** The recorded gaps as a context block, bounded by `parseContractGaps`. */
function gapsBlock({ gaps, dropped }: ReturnType<typeof parseContractGaps>, heading: string): string {
	if (gaps.length === 0) return '';
	const more = dropped ? `\n(${dropped} more not shown — the ledger is capped at ${MAX_CONTRACT_GAPS})` : '';
	return (
		`\n\n--- ${CONTRACT_GAPS_FILE} (${heading}) ---\n\n` +
		gaps.map((g) => `- ${g}`).join('\n') +
		more +
		`\n\n--- end ${CONTRACT_GAPS_FILE} ---`
	);
}

/** One lane of a laned build turn, with the context that lane is given. */
export interface LanePlan {
	readonly lane: BuildLane;
	readonly context: string;
}

/**
 * The lanes a build turn runs, in order, each with its context (#682). Empty for
 * a phase that is not laned.
 *
 * The API lane sees what an unlaned build sees, plus the gaps the UI lane
 * recorded. A gap naming an operation the model declares is the API lane's to
 * implement; one that needs a NEW operation is a model change, which a build
 * turn cannot make (buildWriteGuard) — so it says so and stops.
 *
 * The UI lane sees the concept's screens section and the declared model (the
 * operations, their inputs and their returns) and nothing else: no engine
 * coverage, migrations or scenario. It is skipped when the concept names no
 * screens or says the app is API-only, because a pass with nothing to build
 * still costs a prefix.
 */
export async function planLanes(ws: ContextWorkspace, phase: BuildPhase): Promise<LanePlan[]> {
	if (!isLanedPhase(phase)) return [];
	const ledger = parseContractGaps(
		(await ws.exists(CONTRACT_GAPS_FILE)) ? await ws.readFile(CONTRACT_GAPS_FILE) : '',
	);
	const api: LanePlan = {
		lane: 'api',
		context:
			(await buildContext(ws, phase)) +
			gapsBlock(
				ledger,
				'gaps the UI lane recorded — implement any the model declares; one that needs a new operation is a model change: say so and stop',
			),
	};
	const concept = await ws.readFile('spec/concept.md');
	const screens = screensSection(concept);
	if (screens === null || apiOnly(screens) || !(await ws.exists('spec/model.ts'))) return [api];
	const model = await ws.readFile('spec/model.ts');
	const ui: LanePlan = {
		lane: 'ui',
		context:
			`${screens}\n\n${modelBlock(model, 'the operations you build screens against')}` +
			gapsBlock(ledger, 'already recorded — do not repeat; remove a line once the API offers it'),
	};
	return [api, ui];
}
