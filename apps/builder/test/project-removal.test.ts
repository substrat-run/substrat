import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ownedProjectDir, projectStorageKeys, withoutProject } from '../src/project-removal.js';

const p = (id: string, updatedAt: string) => ({ id, updatedAt });

describe('withoutProject', () => {
	const reg = { currentId: 'b', projects: [p('a', '2026-01-02'), p('b', '2026-01-01'), p('c', '2026-01-03')] };

	it('removing the current project makes the most recently touched one current', () => {
		const out = withoutProject(reg, 'b');
		expect(out?.removed.id).toBe('b');
		expect(out?.registry).toEqual({ currentId: 'c', projects: [p('a', '2026-01-02'), p('c', '2026-01-03')] });
	});

	it('removing another project keeps the current one', () => {
		expect(withoutProject(reg, 'c')?.registry.currentId).toBe('b');
	});

	it('removing the last project leaves none current, and an unknown id is null', () => {
		expect(withoutProject({ currentId: 'a', projects: [p('a', '2026-01-01')] }, 'a')?.registry).toEqual({ currentId: null, projects: [] });
		expect(withoutProject(reg, 'zzz')).toBeNull();
	});
});

describe('ownedProjectDir', () => {
	it('owns a directory the server created, and nothing an adopted --vertical or a climb names', () => {
		expect(ownedProjectDir('.builder/projects/untitled-2')).toBe(true);
		for (const dir of ['demos/todo', '.builder/projects', '.builder/projects/', '.builder/projects/..', '.builder/projects/a/b', '../.builder/projects/a']) {
			expect(ownedProjectDir(dir), dir).toBe(false);
		}
	});
});

it('projectStorageKeys names every per-project key the hosted agent writes', () => {
	// A key added to agent.ts and missed here would outlive the project it belongs to.
	const source = readFileSync(fileURLToPath(new URL('../src/agent.ts', import.meta.url)), 'utf8');
	const keyed = /storage\.(?:get|put)(?:<[^>]+>)?\(`([a-z-]+):\$\{(?:entry\.)?id\}`/g;
	// `snapshotKey(entry)` builds its key in a helper rather than at the call.
	const written = new Set([...source.matchAll(keyed), ...source.matchAll(/`(snapshot):\$\{entry\.id\}`/g)].map((m) => m[1]));
	expect(written.size).toBeGreaterThan(0);
	const named = projectStorageKeys('ID').map((k) => k.split(':')[0]);
	expect([...written].sort()).toEqual([...named].sort());
});
