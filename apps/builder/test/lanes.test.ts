/**
 * #682 — the build's lanes: API then UI, disjoint write guards, gates once.
 *
 * Every refusal here has a positive twin. A guard proven only by what it
 * refuses could refuse everything, and a lane that can write nothing is as
 * broken as one that can write anywhere.
 *
 * No model runs in this file. The "agent" is a script that acts through the
 * real `workspaceTools` write tool with the lane's guard — the same seam
 * `AiSdkGenerator` hands its `denyWrite` to — so the refusal a lane meets here
 * is the exact string a model would read.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import {
	workspaceTools,
	type BuildEvent,
	type GeneratorInput,
	type VerticalGenerator,
} from '@substrat-run/builder-generator';
import { EVAL_PROJECT_PREFIX, prepareProject, runEval } from '../src/evals/harness.js';
import {
	apiLaneWriteGuard,
	buildWriteGuard,
	CONTRACT_GAPS_FILE,
	foldForGuard,
	guardPath,
	historyForLane,
	interviewWriteGuard,
	isLanedPhase,
	LANES,
	MAX_CONTRACT_GAP_CHARS,
	MAX_CONTRACT_GAPS,
	parseContractGaps,
	planLanes,
	PHASES,
	reportForLane,
	screensSection,
	SKILL_MANIFEST,
	skillsForPhase,
	uiLaneWriteGuard,
	writeGuardFor,
	type BuildLane,
} from '../src/phase.js';

describe('guardPath — the guard judges the path the workspace writes', () => {
	it('resolves . and .. the way the workspace does', () => {
		expect(guardPath('./src/a.ts')).toBe('src/a.ts');
		expect(guardPath('app/../src/module.ts')).toBe('src/module.ts');
		expect(guardPath('src//x/./y.ts')).toBe('src/x/y.ts');
	});

	it('keeps a path that climbs above the root climbing, so no prefix matches it', () => {
		expect(guardPath('../app/x.tsx')).toBe('../app/x.tsx');
		expect(guardPath('app/../../app/x')).toBe('../app/x');
	});

	it('the complement guards refuse a climbing path themselves — every guard fails closed alone', () => {
		for (const p of ['../x', '../app/x.tsx', 'src/../../src/a.ts', '..']) {
			expect(buildWriteGuard(p), p).toMatch(/outside the project/);
			expect(apiLaneWriteGuard(p), p).not.toBeNull();
			expect(uiLaneWriteGuard(p), p).not.toBeNull();
		}
		// Positive twin: a .. that stays inside the project is judged where it lands.
		expect(buildWriteGuard('src/../README.md')).toBeNull();
		expect(apiLaneWriteGuard('app/../src/a.ts')).toBeNull();
	});

	it('closes the traversal hole in the guards that predate lanes too', () => {
		// `src/../spec/model.ts` starts with `src/` and lands on the model.
		expect(buildWriteGuard('src/../spec/model.ts')).not.toBeNull();
		expect(interviewWriteGuard('spec/../src/module.ts')).not.toBeNull();
		// Positive twin: a dotted path that stays inside spec/ is still spec/.
		expect(interviewWriteGuard('spec/./concept.md')).toBeNull();
	});
});

describe('the API lane — everything but app/**, under the build guard', () => {
	it('writes the API side, including the root files a scaffold needs', () => {
		for (const p of ['src/module.ts', 'test/server.test.ts', 'migrations/0001.sql', 'package.json', 'tsconfig.json']) {
			expect(apiLaneWriteGuard(p), p).toBeNull();
		}
	});

	it('refuses app/**, and says the UI lane owns it and comes next', () => {
		const refusal = apiLaneWriteGuard('app/src/main.tsx');
		expect(refusal).toMatch(/API lane cannot write app\/\*\*/);
		expect(refusal).toMatch(/UI lane runs after you/);
		expect(apiLaneWriteGuard('app')).not.toBeNull();
		expect(apiLaneWriteGuard('src/../app/x.tsx')).not.toBeNull();
	});

	it('keeps the build guard: the model and the scenario oracle stay frozen', () => {
		expect(apiLaneWriteGuard('spec/model.ts')).toBe(buildWriteGuard('spec/model.ts'));
		expect(apiLaneWriteGuard('test/scenario.test.ts')).toBe(buildWriteGuard('test/scenario.test.ts'));
	});

	it('does not mistake a sibling that starts like app for app/', () => {
		expect(apiLaneWriteGuard('apps/x.ts')).toBeNull();
		expect(apiLaneWriteGuard('application.ts')).toBeNull();
	});
});

describe('the UI lane — app/** only', () => {
	it('writes the screens and the gap ledger', () => {
		expect(uiLaneWriteGuard('app/src/main.tsx')).toBeNull();
		expect(uiLaneWriteGuard('./app/package.json')).toBeNull();
		expect(uiLaneWriteGuard(CONTRACT_GAPS_FILE)).toBeNull();
	});

	it('refuses everything else, naming the owner and the way out', () => {
		for (const p of ['src/routes.ts', 'spec/model.ts', 'test/scenario.test.ts', 'package.json', 'apps/x.ts']) {
			const refusal = uiLaneWriteGuard(p);
			expect(refusal, p).toMatch(/UI lane writes only app\/\*\*/);
			expect(refusal, p).toContain(CONTRACT_GAPS_FILE);
		}
	});

	it('cannot climb out of app/ with ..', () => {
		expect(uiLaneWriteGuard('app/../src/module.ts')).toMatch(/src\/module\.ts belongs to the API lane/);
	});
});

describe('foldForGuard — the fold APFS applies, or a wider one (#2200 r2)', () => {
	// The nine non-ASCII characters this repo's APFS folds onto ASCII letters,
	// found by sweeping every code point against files named with every one- and
	// two-letter ASCII name (and the three-letter ligature names). Each must
	// fold to what APFS opens.
	const APFS_FOLDS: [string, string][] = [
		['ß', 'ss'], ['ẞ', 'ss'], ['ſ', 's'], ['K', 'k'],
		['ﬀ', 'ff'], ['ﬁ', 'fi'], ['ﬂ', 'fl'], ['ﬅ', 'st'], ['ﬆ', 'st'], ['ﬃ', 'ffi'], ['ﬄ', 'ffl'],
	];

	it('folds every character APFS folds onto ASCII to what APFS opens', () => {
		for (const [ch, ascii] of APFS_FOLDS) expect(foldForGuard(ch), ch).toBe(ascii);
	});

	it('folds ASCII case, and leaves an already-folded path alone', () => {
		expect(foldForGuard('Spec/Model.TS')).toBe('spec/model.ts');
		expect(foldForGuard('src/module.ts')).toBe('src/module.ts');
	});

	it('folds WIDER than APFS where Unicode says to — a refusal that over-matches fails closed', () => {
		// APFS opens neither, but a refusal that catches them costs nothing.
		expect(foldForGuard('ＳＰＥＣ/model.ts')).toBe('spec/model.ts');
		expect(foldForGuard('test/scenarıo.test.ts')).toBe('test/scenario.test.ts');
	});
});

describe('case: a guard judges the file the filesystem will open (#2200 r1)', () => {
	// The local studio's usual filesystem (APFS) is case-insensitive, so
	// `App/main.tsx` IS `app/main.tsx` and `Spec/model.ts` IS the model. A refusal
	// folds case, so it holds on either kind of filesystem; an allowance does
	// not, because on a case-sensitive one (the hosted container) `App/` is a
	// new directory outside the lane — so a wrong-cased path fails closed.
	it('the API lane refuses app/** in any case', () => {
		for (const p of ['App/main.tsx', 'APP/x.ts', 'aPp/../App/x.tsx']) expect(apiLaneWriteGuard(p), p).not.toBeNull();
		// Positive twin: a sibling that only starts like app stays the API lane's.
		expect(apiLaneWriteGuard('Apps/x.ts')).toBeNull();
		expect(apiLaneWriteGuard('Application.ts')).toBeNull();
	});

	it('the UI lane writes app/ as spelled, and tells a wrong-cased path how to spell it', () => {
		expect(uiLaneWriteGuard('app/main.tsx')).toBeNull();
		expect(uiLaneWriteGuard('App/main.tsx')).toMatch(/spell it app\//);
	});

	it('the build guard refuses the model and the scenario oracle under any Unicode fold APFS applies (#2200 r2)', () => {
		const model = ['ſpec/model.ts', 'spec/model.tſ', 'SPEC/MODEL.TS', 'ſpec/modeL.Tſ'];
		const scenario = ['test/ſcenario.test.ts', 'teﬆ/scenario.test.ts', 'teﬅ/scenario.test.ts', 'test/scenario.teﬆ.ts', 'teſt/ſcenario.teſt.tſ'];
		for (const p of model) {
			expect(buildWriteGuard(p), p).toMatch(/spec\/model/);
			expect(apiLaneWriteGuard(p), p).toMatch(/spec\/model/);
		}
		for (const p of scenario) {
			expect(buildWriteGuard(p), p).toMatch(/scenario/);
			expect(apiLaneWriteGuard(p), p).toMatch(/scenario/);
		}
		// Positive twins: a neighbour stays writable however it is spelled.
		expect(buildWriteGuard('ſpec/concept.md')).toBeNull();
		expect(buildWriteGuard('teﬆ/server.test.ts')).toBeNull();
		expect(buildWriteGuard('ſrc/module.ts')).toBeNull();
	});

	it('the API lane refuses app/** under any fold, and the UI lane still writes only app/ as spelled', () => {
		for (const p of ['ａｐｐ/x.tsx', 'ＡＰＰ/x.tsx']) {
			expect(apiLaneWriteGuard(p), p).not.toBeNull();
			expect(uiLaneWriteGuard(p), p).not.toBeNull();
		}
		expect(uiLaneWriteGuard('app/x.tsx')).toBeNull();
	});

	it('on THIS filesystem, if it folds, each refused spelling would have overwritten the oracle', async () => {
		const root = await mkdtemp(join(tmpdir(), 'builder-fold-'));
		roots.push(root);
		const ws = new LocalWorkspace({ root });
		await ws.writeFile('spec/model.ts', 'MODEL');
		await ws.writeFile('test/scenario.test.ts', 'ORACLE');
		if (!(await ws.exists('ſpec/model.ts'))) return; // this filesystem does not fold ſ
		for (const p of ['ſpec/model.ts', 'test/ſcenario.test.ts', 'teﬆ/scenario.test.ts']) {
			expect(buildWriteGuard(p), p).not.toBeNull();
		}
		await ws.writeFile('teﬆ/scenario.test.ts', 'OVERWRITTEN');
		expect(await ws.readFile('test/scenario.test.ts')).toBe('OVERWRITTEN');
		await ws.dispose();
	});

	it('the build guard refuses the model and the scenario oracle in any case, the half that predates lanes', () => {
		for (const p of ['Spec/model.ts', 'SPEC/MODEL.TS', 'spec/Model.json']) expect(buildWriteGuard(p), p).toMatch(/spec\/model/);
		for (const p of ['TEST/scenario.test.ts', 'test/Scenario.Test.ts']) expect(buildWriteGuard(p), p).toMatch(/scenario/);
		// Positive twins: the files beside them stay writable, in any case.
		expect(buildWriteGuard('Spec/models/extra.ts')).toBeNull();
		expect(buildWriteGuard('TEST/server.test.ts')).toBeNull();
		expect(buildWriteGuard('Spec/concept.md')).toBeNull();
	});

	it('on THIS filesystem, if it folds case, the write the guard refuses would land inside app/', async () => {
		const root = await mkdtemp(join(tmpdir(), 'builder-case-'));
		roots.push(root);
		const ws = new LocalWorkspace({ root });
		await ws.writeFile('app/keep.txt', 'x');
		const folds = await ws.exists('APP/keep.txt');
		if (!folds) return; // a case-sensitive filesystem: App/ is a different directory
		await ws.writeFile('App/main.tsx', 'landed');
		expect(await ws.readFile('app/main.tsx')).toBe('landed');
		expect(apiLaneWriteGuard('App/main.tsx')).not.toBeNull();
		await ws.dispose();
	});
});

describe('the lanes are disjoint and cover the tree', () => {
	const paths = [
		'app', 'app/x.tsx', 'app/src/a/b.ts', CONTRACT_GAPS_FILE, 'src/module.ts', 'test/server.test.ts',
		'migrations/0001.sql', 'package.json', 'tsconfig.json', 'README.md', 'apps/y.ts', 'app/../src/z.ts',
		'App/x.tsx', 'APP/y.ts', 'Spec/model.ts', 'ａｐｐ/x.tsx', 'ſpec/model.ts', 'teﬆ/scenario.test.ts', 'ſrc/a.ts',
	];
	/** Wrong-cased app/ paths: refused by both lanes, which is the fail-closed answer. */
	const miscased = (p: string) => foldForGuard(guardPath(p)).startsWith('app/') && !guardPath(p).startsWith('app/');

	it('no path is writable by both lanes', () => {
		for (const p of paths) {
			const both = apiLaneWriteGuard(p) === null && uiLaneWriteGuard(p) === null;
			expect(both, p).toBe(false);
		}
	});

	it('every path the build may write is writable by exactly one lane', () => {
		for (const p of paths.filter((p) => buildWriteGuard(p) === null && !miscased(p))) {
			const writers = LANES.filter((l) => writeGuardFor('iterate', l)(p) === null);
			expect(writers, p).toHaveLength(1);
		}
		for (const p of paths.filter(miscased)) {
			expect(LANES.filter((l) => writeGuardFor('iterate', l)(p) === null), p).toEqual([]);
		}
	});

	it('dispatches each lane of a build turn to its guard, through the one phase dispatch', () => {
		for (const phase of ['scaffold', 'iterate'] as const) {
			expect(writeGuardFor(phase, 'api')).toBe(apiLaneWriteGuard);
			expect(writeGuardFor(phase, 'ui')).toBe(uiLaneWriteGuard);
		}
		// A lane means nothing outside a build turn: the phase's own guard holds.
		expect(writeGuardFor('interview', 'ui')).toBe(interviewWriteGuard);
		expect(writeGuardFor('scenario', 'api')('src/module.ts')).not.toBeNull();
	});

	it('lanes only the build phases', () => {
		expect(PHASES.filter(isLanedPhase)).toEqual(['scaffold', 'iterate']);
	});
});

describe('skills per lane', () => {
	const loaded = new Map(SKILL_MANIFEST.map((e) => [e.file, e.file]));
	const UI = 'apps/builder/skills/ui.md';
	const UI_LANE = 'apps/builder/skills/ui-lane.md';

	it('the UI lane carries the app/ rules and its own skill, and nothing else, in every build phase', () => {
		expect(skillsForPhase(loaded, 'scaffold', 'ui')).toEqual([UI, UI_LANE]);
		expect(skillsForPhase(loaded, 'iterate', 'ui')).toEqual([UI, UI_LANE]);
	});

	it('the API lane carries the phase skills minus the screens', () => {
		for (const phase of ['scaffold', 'iterate'] as const) {
			expect(skillsForPhase(loaded, phase, 'api')).toEqual(
				skillsForPhase(loaded, phase).filter((f) => f !== UI),
			);
		}
	});

	it('no unlaned phase carries the lane-only skill — on every host, hosted included', () => {
		// agent.ts calls skillsForPhase with no lane; this is the set it gets.
		for (const phase of PHASES) expect(skillsForPhase(loaded, phase)).not.toContain(UI_LANE);
	});
});

describe('an unlaned build reads what it read on main (#2200 r1)', () => {
	const root = join(import.meta.dirname, '..', '..', '..');
	const skill = (f: string) => readFile(join(root, f), 'utf8');
	const loaded = new Map(SKILL_MANIFEST.map((e) => [e.file, e.file]));

	it('scaffold.md and ui.md, rejoined, are main\'s scaffold.md byte for byte', async () => {
		// sha256 of apps/builder/skills/scaffold.md at f2683d45d (main when #682
		// branched). ui.md is its closing paragraph, split out verbatim, so the
		// unlaned scaffold carries the same rules in the same order — the only
		// difference in the prompt is the separator the generator puts between
		// two skills.
		const rejoined = `${await skill('apps/builder/skills/scaffold.md')}\n${await skill('apps/builder/skills/ui.md')}`;
		expect(createHash('sha256').update(rejoined).digest('hex')).toBe(
			'308be40091f0d5071ccd96ffb1aad2be146675e626e45a1de723ab1ee31ef542',
		);
	});

	it('the unlaned scaffold set is main\'s, in main\'s order, with ui.md where scaffold.md ended', () => {
		expect(skillsForPhase(loaded, 'scaffold')).toEqual([
			'apps/builder/skills/platform.md',
			'apps/builder/skills/scaffold.md',
			'apps/builder/skills/ui.md',
			'apps/builder/skills/iterate.md',
		]);
	});

	it('no unlaned skill tells the model it is a lane', async () => {
		const files = new Set(PHASES.flatMap((p) => SKILL_MANIFEST.filter((e) => e.phases.includes(p)).map((e) => e.file)));
		for (const f of files) {
			const text = await skill(f);
			expect(text, f).not.toContain('CONTRACT-GAPS');
			expect(text, f).not.toMatch(/UI lane|API lane/);
		}
		// Positive twin: the lane-only text exists, and says it.
		expect(await skill('apps/builder/skills/ui-lane.md')).toContain('CONTRACT-GAPS');
	});
});

describe('screensSection', () => {
	it('takes the screens heading down to the next heading at its level', () => {
		const c = '# X\n\n## 7. Data\nrows\n\n## 8. The screens\n- Office: list\n### detail\nmore\n\n## 9. Scenario\nsteps';
		expect(screensSection(c)).toBe('## 8. The screens\n- Office: list\n### detail\nmore');
	});

	it('answers null when the concept names no screens', () => {
		expect(screensSection('# X\n\n## 8. The scenario the test replays\nsteps')).toBeNull();
	});

	it('matches a heading whose title IS the screens, numbered or not', () => {
		for (const h of ['## 8. The screens', '## Screens', '### the screens per persona', '## 8. Screens']) {
			expect(screensSection(`# X\n\n${h}\n- Office: list`), h).toBe(`${h}\n- Office: list`);
		}
	});

	it('does not take a heading that merely mentions a screen', () => {
		const c = '# X\n\n## 2. The thing\n### Login screen\nflows\n\n## 8. The screens\n- Office: list';
		expect(screensSection(c)).toBe('## 8. The screens\n- Office: list');
		expect(screensSection('# X\n\n## Screenshots\nnone')).toBeNull();
	});
});

describe('the gap ledger is bounded before it reaches a context', () => {
	it('keeps bullet lines only, deduped case-insensitively', () => {
		const { gaps, dropped } = parseContractGaps(
			'# gaps\nprose that is not a gap\n- job/list: day view\n- JOB/LIST: day view\n* job/get: detail\n',
		);
		expect(gaps).toEqual(['job/list: day view', 'job/get: detail']);
		expect(dropped).toBe(0);
	});

	it('caps the count and clips each line, so a runaway lane cannot grow the next context', () => {
		const flood = Array.from({ length: 500 }, (_, i) => `- op/${i}: ${'x'.repeat(5000)}`).join('\n');
		const { gaps, dropped } = parseContractGaps(flood);
		expect(gaps).toHaveLength(MAX_CONTRACT_GAPS);
		expect(dropped).toBe(500 - MAX_CONTRACT_GAPS);
		for (const g of gaps) expect(g.length).toBeLessThanOrEqual(MAX_CONTRACT_GAP_CHARS);
	});

	it('the same gap repeated a thousand times is one gap', () => {
		const { gaps, dropped } = parseContractGaps('- job/list: day view\n'.repeat(1000));
		expect(gaps).toEqual(['job/list: day view']);
		expect(dropped).toBe(0);
	});
});

describe('planLanes — what each lane is given', () => {
	const CONCEPT =
		'# Fx\n\n## 2. The thing that moves\nengine material\n\n## 8. The screens\n- Office: list of things\n\n## 9. The scenario\nreplay steps';
	const ws = (files: Record<string, string>) => ({
		exists: async (p: string) => p in files,
		readFile: async (p: string) => files[p] ?? '',
	});

	it('lanes nothing outside the build phases', async () => {
		expect(await planLanes(ws({ 'spec/concept.md': CONCEPT }), 'model')).toEqual([]);
		expect(await planLanes(ws({ 'spec/concept.md': CONCEPT }), 'scenario')).toEqual([]);
	});

	it('API first with the whole build context; UI second with the screens and the model only', async () => {
		const plans = await planLanes(ws({ 'spec/concept.md': CONCEPT, 'spec/model.ts': 'MODEL' }), 'scaffold');
		expect(plans.map((p) => p.lane)).toEqual(['api', 'ui']);
		const [api, ui] = plans;
		expect(api?.context).toContain('engine material');
		expect(api?.context).toContain('MODEL');
		// The API's side of the screens, which an unlaned build reads in ui.md.
		expect(api?.context).toMatch(/proxies or serves app\//);
		expect(ui?.context).toContain('- Office: list of things');
		expect(ui?.context).toContain('MODEL');
		expect(ui?.context).not.toContain('engine material');
		expect(ui?.context).not.toContain('replay steps');
	});

	it('runs the turn UNLANED when there are no screens to build — never an API lane alone', async () => {
		// An API lane alone refuses app/** with nobody after it; unlaned, a concept
		// whose screens the heuristic missed still gets its app built.
		const none = '# Fx\n\n## 9. The scenario\nsteps';
		const apiOnly = '# Fx\n\n## 8. The screens\nAPI-only for now.';
		for (const concept of [none, apiOnly]) {
			expect(await planLanes(ws({ 'spec/concept.md': concept, 'spec/model.ts': 'M' }), 'iterate')).toEqual([]);
		}
	});

	it('reads API-only as an opt-out only when it is the section\'s whole answer', async () => {
		const mixed = '# Fx\n\n## 8. The screens\nThe export is API-only; admins get a dashboard.\n- Admin: dashboard';
		const listed = '# Fx\n\n## 8. The screens\nAPI-only for the export.\n- Office: list of things';
		for (const concept of [mixed, listed]) {
			const plans = await planLanes(ws({ 'spec/concept.md': concept, 'spec/model.ts': 'M' }), 'iterate');
			expect(plans.map((p) => p.lane), concept).toEqual(['api', 'ui']);
		}
	});

	it('hands the recorded gaps to both lanes, bounded', async () => {
		const ledger = Array.from({ length: 50 }, (_, i) => `- op/${i}: needed`).join('\n');
		const plans = await planLanes(
			ws({ 'spec/concept.md': CONCEPT, 'spec/model.ts': 'M', [CONTRACT_GAPS_FILE]: ledger }),
			'iterate',
		);
		const [api, ui] = plans;
		expect(api?.context).toContain('- op/0: needed');
		expect(api?.context).toMatch(/new operation is a model change: say so and stop/);
		expect(api?.context).not.toContain(`op/${MAX_CONTRACT_GAPS}:`);
		expect(api?.context).toContain(`${50 - MAX_CONTRACT_GAPS} more not shown`);
		expect(ui?.context).toMatch(/already recorded — do not repeat/);
	});
});

describe('reportForLane — each lane gets the part of a red report it can fix', () => {
	const TSC =
		'── typecheck FAILED (exit 2)\n' +
		"app/src/main.tsx(3,5): error TS2322: Type 'number' is not assignable to type 'string'.\n" +
		'  The expected type comes from property title.\n' +
		"src/routes.ts(10,1): error TS2304: Cannot find name 'foo'.\n" +
		'Found 2 errors.';

	it('splits one gate section by path ownership, keeping the header and continuation lines', () => {
		const ui = reportForLane(TSC, 'ui');
		const api = reportForLane(TSC, 'api');
		expect(ui).toBe(
			'── typecheck FAILED (exit 2)\n' +
				"app/src/main.tsx(3,5): error TS2322: Type 'number' is not assignable to type 'string'.\n" +
				'  The expected type comes from property title.',
		);
		expect(api).toBe(
			'── typecheck FAILED (exit 2)\n' + "src/routes.ts(10,1): error TS2304: Cannot find name 'foo'.\nFound 2 errors.",
		);
	});

	it('reads a path spelled from the monorepo root or absolutely as the project path it is', () => {
		const report = '── test FAILED (exit 1)\n FAIL  /Users/x/repo/.builder/projects/fx/app/src/view.test.tsx > renders';
		expect(reportForLane(report, 'ui')).toContain('view.test.tsx');
		expect(reportForLane(report, 'api')).toBeUndefined();
	});

	it('gives a section that names no path to the API lane alone — as every report went before lanes', () => {
		const report = '── boundary-lint FAILED (exit 1)\n(no output)';
		expect(reportForLane(report, 'api')).toBe(report);
		expect(reportForLane(report, 'ui')).toBeUndefined();
	});

	it('routes whole sections independently, and returns nothing for a lane that owns none', () => {
		const report = `${'── test FAILED (exit 1)\n FAIL  test/scenario.test.ts > a denial'}\n\n${'── typecheck FAILED (exit 2)\napp/x.tsx(1,1): error TS1'}`;
		expect(reportForLane(report, 'api')).toBe('── test FAILED (exit 1)\n FAIL  test/scenario.test.ts > a denial');
		expect(reportForLane(report, 'ui')).toBe('── typecheck FAILED (exit 2)\napp/x.tsx(1,1): error TS1');
		expect(reportForLane('── test FAILED (exit 1)\nsrc/a.ts(1,1): e', 'ui')).toBeUndefined();
	});

	it('does not mistake src/app/ for the UI lane', () => {
		expect(reportForLane('── typecheck FAILED (exit 2)\nsrc/app/x.ts(1,1): e', 'ui')).toBeUndefined();
	});
});

describe('historyForLane — the UI lane reads its own passes, nothing else', () => {
	const durable = [
		{ role: 'user' as const, text: 'interview: which engines, which tenants' },
		{ role: 'assistant' as const, text: 'concept: workorder engine, scenario …' },
	];
	const turn = [
		{ role: 'user' as const, text: 'build it', lane: 'api' as const },
		{ role: 'assistant' as const, text: 'api: wrote migrations and routes', lane: 'api' as const },
		{ role: 'user' as const, text: 'build it', lane: 'ui' as const },
		{ role: 'assistant' as const, text: 'ui: started the list view', lane: 'ui' as const },
	];

	it('gives the UI lane only its own passes this turn — no interview, no API lane', () => {
		expect(historyForLane('ui', durable, turn)).toEqual([
			{ role: 'user', text: 'build it' },
			{ role: 'assistant', text: 'ui: started the list view' },
		]);
		expect(historyForLane('ui', durable, turn.slice(0, 2))).toEqual([]);
	});

	it('gives the API lane and an unlaned pass what a build turn always saw', () => {
		const all = [...durable, ...turn].map(({ role, text }) => ({ role, text }));
		expect(historyForLane('api', durable, turn)).toEqual(all);
		expect(historyForLane(undefined, durable, turn)).toEqual(all);
		expect(historyForLane(undefined, durable, turn, 1)).toEqual(all.slice(1));
	});

	it('hands the generator plain turns, without the lane tag', () => {
		for (const t of historyForLane(undefined, durable, turn)) expect(Object.keys(t).sort()).toEqual(['role', 'text']);
	});
});

// ── the laned build, driven end to end through the eval harness ─────────────

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

const LANED_CONCEPT = '# Fx\n\n## 1. What\nthings\n\n## 8. The screens\n- Office: list of things\n';

/** What each pass saw and what the guard answered it. */
interface PassLog {
	readonly lane: BuildLane | 'unlaned';
	readonly message: string;
	readonly context: string;
	readonly gateReport: string | undefined;
	readonly history: readonly { readonly role: string; readonly text: string }[];
	readonly answers: Record<string, string>;
}

/**
 * A mock agent for one lane: its script names the writes to attempt, and each
 * goes through `write_file` with the guard the HOST picked for this lane.
 */
function laneAgent(
	lane: BuildLane | 'unlaned',
	denyWrite: ((p: string) => string | null) | undefined,
	log: PassLog[],
	script: (turn: number) => Record<string, string>,
): VerticalGenerator {
	return {
		id: `mock-${lane}`,
		async *run(input: GeneratorInput): AsyncIterable<BuildEvent> {
			const tools = workspaceTools({ workspace: input.workspace, emit: () => {}, ...(denyWrite ? { denyWrite } : {}) });
			const turn = log.filter((l) => l.lane === lane).length + 1;
			const answers: Record<string, string> = {};
			for (const [path, content] of Object.entries(script(turn))) {
				answers[path] = String(
					await tools.write_file.execute!({ path, content }, { toolCallId: path, messages: [] }),
				);
			}
			log.push({
				lane,
				message: input.message,
				context: input.concept,
				gateReport: input.gateReport,
				history: input.history ?? [],
				answers,
			});
			yield { type: 'assistant-text', text: `${lane} pass ${turn}` };
		},
	};
}

describe('a laned build turn (eval harness, mocked agent)', () => {
	it('runs API then UI, each confined to its side, gates after both, and the gap reaches the next turn', async () => {
		const root = await mkdtemp(join(tmpdir(), 'builder-lanes-'));
		roots.push(root);
		const ws = new LocalWorkspace({ root });
		await ws.exec('git init -q && git config gc.auto 0 && git config maintenance.auto false');
		const fixture = { name: 'lanes', concept: LANED_CONCEPT, expect: { files: ['app/turn2.txt'] } };
		const dir = `${EVAL_PROJECT_PREFIX}${fixture.name}`;
		await prepareProject(ws, dir, fixture);
		const projectWs = new LocalWorkspace({ root: join(root, dir) });
		// The model and the scenario exist, so the ladder is at scaffold: a build turn.
		await projectWs.writeFile('spec/model.ts', 'export const MODEL = "declared ops";\n');
		await projectWs.writeFile('test/scenario.test.ts', '// oracle\n');

		const log: PassLog[] = [];
		const scripts: Record<BuildLane | 'unlaned', (turn: number) => Record<string, string>> = {
			api: () => ({ 'src/module.ts': 'export {}\n', 'app/sneak.tsx': 'x' }),
			ui: (turn) =>
				turn === 1
					? { 'app/main.tsx': 'ui', 'src/routes.ts': 'x', [CONTRACT_GAPS_FILE]: '- thing/list-mine: day view\n' }
					: { 'app/turn2.txt': 'done' },
			unlaned: () => ({}),
		};
		const result = await runEval({
			ws,
			projectWs,
			projectDir: dir,
			fixture,
			lanes: true,
			makeGenerator: async (phase, lane) =>
				laneAgent(lane ?? 'unlaned', writeGuardFor(phase, lane), log, scripts[lane ?? 'unlaned']),
			// Red until the UI lane's second-turn file exists: one gate run per turn
			// (plus its repair), never one between the lanes. Its output names an
			// app/ file, which only the UI lane can fix (#2200 r1).
			gates: [
				{
					name: 'typecheck',
					cmd: `echo "app/main.tsx(1,1): error TS2322: screen is red"; test -f ${dir}/app/turn2.txt`,
				},
			],
			probe: async () => ({ modules: [], roles: [] }),
			maxTurns: 2,
		});

		expect(result.laned).toBe(true);
		expect(result.passed).toBe(true);
		// Turn 1: both lanes, the gates (red), then a repair that is UNLANED. Turn 2:
		// both lanes again, and the gates go green.
		expect(log.map((l) => l.lane)).toEqual(['api', 'ui', 'unlaned', 'api', 'ui']);
		expect(result.repairs).toBe(1);

		const [api1, ui1, repair, api2, ui2] = log;
		expect(repair?.message).toContain('repair attempt 1/');
		// The red report from turn 1 opens turn 2 in the lane that can fix it: it
		// names app/main.tsx, so the UI lane — not the API lane, which cannot write it.
		expect(api1?.gateReport).toBeUndefined();
		expect(ui2?.gateReport).toContain('app/main.tsx(1,1): error TS2322');
		expect(api2?.gateReport).toBeUndefined();
		// Inside its guard, each lane's write lands…
		expect(api1?.answers['src/module.ts']).toMatch(/^wrote src\/module\.ts/);
		expect(ui1?.answers['app/main.tsx']).toMatch(/^wrote app\/main\.tsx/);
		expect(ui1?.answers[CONTRACT_GAPS_FILE]).toMatch(/^wrote /);
		// …and outside it is refused, in words that tell THAT lane what to do.
		expect(api1?.answers['app/sneak.tsx']).toMatch(/^REFUSED: the API lane cannot write app/);
		expect(ui1?.answers['src/routes.ts']).toMatch(/^REFUSED: the UI lane writes only app/);
		expect(ui1?.answers['src/routes.ts']).toContain(CONTRACT_GAPS_FILE);
		expect(await projectWs.exists('app/sneak.tsx')).toBe(false);
		expect(await projectWs.exists('src/routes.ts')).toBe(false);

		// Each lane got its own context: the UI lane the screens and the model only.
		expect(ui1?.context).toContain('- Office: list of things');
		expect(ui1?.context).toContain('declared ops');
		expect(ui1?.context).not.toContain('## 1. What');
		expect(api1?.context).toContain('## 1. What');
		// What the UI lane's prompt holds beyond its context: no history on its first
		// pass, and on turn 2 still none of turn 1 or of the API lane's prose —
		// the interview and the engine talk never reach it (#2200 r1).
		expect(ui1?.history).toEqual([]);
		expect(ui2?.history).toEqual([]);
		// Positive twin: the API lane does carry the durable history forward.
		expect(api2?.history.map((h) => h.text)).toContain('api pass 1');
		expect(api2?.history.map((h) => h.text)).toContain('ui pass 1');
		// The gap the UI lane recorded is in the API lane's context on the next turn.
		expect(api1?.context).not.toContain('thing/list-mine');
		expect(api2?.context).toContain('- thing/list-mine: day view');
		await projectWs.dispose();
	});
});
