/**
 * BOTH file-write routes are contained (#1225).
 *
 * `withinProject` had full unit coverage while the hosted route still carried the
 * prefix check it replaces — so every test passed and the deployed studio was the
 * half that stayed vulnerable. The bug was never in the helper; it was that one of
 * two call sites used it. That is what this pins.
 *
 * Read off the source rather than driven through the routes: the local server is a
 * `node:http` handler over module-level state and the hosted one is a Durable Object
 * needing a sandbox, so standing either up in a unit test would prove less than it
 * costs. A grep-shaped test is honest about being a guard against the fix drifting
 * back out of one entry point, which is the failure that actually happened.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = (name: string): string =>
	readFileSync(fileURLToPath(new URL(`../src/${name}`, import.meta.url)), 'utf8');

const ROUTES = [
	{ file: 'server.ts', what: 'the local studio server' },
	{ file: 'agent.ts', what: 'the hosted BuilderAgent' },
];

describe('the file-write routes are confined to the project', () => {
	for (const { file, what } of ROUTES) {
		it(`${what} judges the write path with withinProject`, () => {
			const text = src(file);
			expect(text).toMatch(/withinProject\(/);
			// Imported from the one module that owns the rule, so the two entry points
			// cannot drift into two different answers.
			expect(text).toMatch(/from '\.\/project-path\.js'/);
		});

		it(`${what} does not gate a write on the path's text alone`, () => {
			// The exact shape this fixed: `.builder/projects/x/../../../CLAUDE.md` starts
			// with the project prefix and names a file at the repo root, which a
			// repo-rooted workspace writes happily — its own jail only refuses paths that
			// leave the REPO.
			expect(src(file)).not.toMatch(/path\.startsWith\(`\$\{(entry|cur\.entry)\.dir\}\//);
		});
	}

	it('the hosted route writes through the project-rooted workspace, not the repo root', () => {
		// Belt and braces, and the reason the containment check is not the only defence:
		// the project-rooted workspace jails the write a second time, and it is what
		// judges a symlink that points out of the project.
		const write = src('agent.ts').slice(src('agent.ts').indexOf("case 'PUT /api/file'"));
		const body = write.slice(0, write.indexOf("case '", 10));
		expect(body).toMatch(/#projectWs\(/);
		expect(body).not.toMatch(/#rootWs\(/);
	});

	it('the hosted route keys the snapshot by the contained path', () => {
		// A slice of the RAW path keyed the snapshot under `../../…`, so what a reload
		// read back was not the file that had been written.
		const text = src('agent.ts');
		expect(text).toMatch(/snap\.files\[rel\] = content/);
		expect(text).not.toMatch(/snap\.files\[path\.slice\(/);
	});
});
