// Scores one archived run and appends it to the ledger: node score.mjs <runDir> <strategy> <model> <sha> <exit>
// README.md says what the score means and how far to trust it.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [runDir, strategy, model, sha, exit] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const proj = join(runDir, 'project');
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => {
	const p = join(d, f);
	return f === 'node_modules' || f === 'dist' ? [] : statSync(p).isDirectory() ? walk(p) : [p];
}) : []);
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const appFiles = walk(join(proj, 'app/src')).filter((f) => /\.(ts|tsx|css|html)$/.test(f));
const app = appFiles.map(read).join('\n');
const count = (s, re) => (s.match(re) ?? []).length;

const reportPath = join(runDir, 'report.json');
const r = existsSync(reportPath) ? JSON.parse(read(reportPath)).results?.[0] : null;
const u = r?.usage ?? {};
const st = r?.stages ?? {};
const ms = Object.values(st).reduce((a, s) => a + (s.durationMs ?? 0) + (s.gateMs ?? 0), 0);
const record = {
	id: basename(runDir), at: new Date().toISOString(), strategy, model, sha, exit: Number(exit),
	passed: !!r?.passed, turns: r?.turns ?? null, repairs: r?.repairs ?? null, questions: r?.questions ?? null,
	seconds: Math.round(ms / 1000), steps: u.steps ?? null,
	// List price from the rate card, for a model that has one: a local Claude Code login has none.
	costUsd: r?.listCostUsd ?? null,
	inputTokens: u.inputTokens ?? null, cachedTokens: u.cachedInputTokens ?? null, cacheWrite: u.cacheWriteTokens ?? null, outputTokens: u.outputTokens ?? null,
	uncachedTokens: u.inputTokens != null ? u.inputTokens - (u.cachedInputTokens ?? 0) : null,
	stages: Object.fromEntries(Object.entries(st).map(([k, s]) => [k, { s: Math.round((s.durationMs + s.gateMs) / 1000), steps: s.steps, in: s.inputTokens, cached: s.cachedInputTokens, out: s.outputTokens }])),
	starterLeft: /\bacme\b/.test(app), wa: count(app, /<wa-[a-z-]+/g), sub: count(app, /<sub-[a-z-]+/g), appLines: app.split('\n').length,
	moduleLines: read(join(proj, 'src/module.ts')).split('\n').length, tests: count(read(join(proj, 'test/scenario.test.ts')), /\bit\(/g),
	invites: /engine-invites/.test(read(join(proj, 'package.json'))),
};

const pick = ['spec/concept.md', 'spec/model.ts', 'src/module.ts', 'src/routes.ts', 'src/server.ts', 'src/worker.ts', 'src/provision.ts', 'package.json'];
const files = [...pick.map((p) => join(proj, p)).filter(existsSync), ...appFiles];
if (files.length > 3) {
	const body = files.map((f) => `=== ${f.slice(proj.length + 1)} ===\n${read(f).slice(0, 40000)}`).join('\n\n');
	const prompt = `${read(join(here, 'rubric-todo.md'))}\n\nThe files:\n\n${body}`;
	writeFileSync(join(runDir, 'judge-prompt.txt'), prompt);
	// Three independent gradings and a majority: on the same code one grading flips single items.
	const grade = (n) => new Promise((resolve, reject) => {
		const child = spawn('claude', ['-p', '--model', 'sonnet', '--output-format', 'text', '--disallowedTools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task']);
		let text = '';
		child.stdout.on('data', (d) => { text += d; });
		child.on('error', reject);
		child.on('close', () => {
			writeFileSync(join(runDir, `judge${n}.txt`), text);
			try { resolve(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))); } catch (e) { reject(e); }
		});
		child.stdin.end(prompt);
	});
	try {
		const grades = await Promise.all([grade(1), grade(2), grade(3)]);
		const votes = (k) => grades.filter((g) => g.items[k]?.pass).length;
		const items = Object.keys(grades[0].items).map((k) => [k, votes(k) >= 2]);
		// Counted, not judged. A judge passed a copy with its permission checks removed, and these are yes or no in the source.
		const server = walk(join(proj, 'src')).map(read).join('\n');
		const module = read(join(proj, 'src/module.ts'));
		const checks = count(module, /ctx\.check\(/g), emits = count(module, /ctx\.emit\(/g);
		items.push(['ui_reaches_api', !/['"`]\/api\/invoke/.test(app) || /\/api\/invoke|\/invoke['"`]/.test(server)]);
		items.push(['deployable', existsSync(join(proj, 'src/worker.ts'))]);
		items.push(['engine_rules', emits > 0 && checks >= emits]);
		items.push(['real_signin', /devLogin|verticalAuth|oidcRp/.test(server) && !/x-principal/i.test(`${server}\n${app}`.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))]);
		items.push(['invite_email', /\bsendInvite\b|mountInviteRoutes/.test(server)]);
		record.quality = Math.round((100 * items.filter(([, v]) => v).length) / items.length);
		record.failed = items.filter(([, v]) => !v).map(([k]) => k);
		record.disagree = Object.keys(grades[0].items).filter((k) => votes(k) === 1 || votes(k) === 2);
		record.worst = grades[0].worst;
	} catch { record.quality = null; record.judgeError = true; }
} else { record.quality = 0; record.failed = ['no-app']; }
// A run counts only if it tested what it claimed to: it finished, was judged, and the change under test really ran.
const transcript = read(join(runDir, 'transcript.log'));
const evidence = process.env.EVIDENCE;
const invalid = [
	!r && 'no report',
	record.quality == null && 'judge failed',
	/rate.?limit|overloaded|ENOSPC|ECONNRESET|credit balance/i.test(read(join(runDir, 'stdout.log'))) && 'infrastructure error in the log',
	evidence && !new RegExp(evidence).test(transcript + read(join(runDir, 'stdout.log'))) && `change not seen: ${evidence}`,
].filter(Boolean);
record.valid = invalid.length === 0;
record.invalid = invalid;
record.hypothesis = process.env.HYPOTHESIS ?? null;
record.rubric = 6;
appendFileSync(process.env.LEDGER ?? join(dirname(dirname(runDir)), 'runs.jsonl'), `${JSON.stringify(record)}\n`);
console.log(JSON.stringify({ id: record.id, passed: record.passed, quality: record.quality, seconds: record.seconds, steps: record.steps, failed: record.failed }));
