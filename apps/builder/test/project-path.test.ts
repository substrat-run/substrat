/**
 * The file-write route's containment test (#1225): a path is inside the project
 * by where it POINTS, not by how its text starts.
 */
import { describe, expect, it } from 'vitest';
import { withinProject } from '../src/project-path.js';

const DIR = '.builder/projects/x';

describe('withinProject', () => {
	it('returns the project-relative path for a file in the project', () => {
		expect(withinProject(`${DIR}/src/module.ts`, DIR)).toBe('src/module.ts');
		expect(withinProject(`${DIR}/package.json`, DIR)).toBe('package.json');
	});

	it('refuses a `..` that climbs out after the project prefix', () => {
		expect(withinProject(`${DIR}/../../../CLAUDE.md`, DIR)).toBeNull();
		expect(withinProject(`${DIR}/src/../../y/file.ts`, DIR)).toBeNull();
		expect(withinProject(`${DIR}/..`, DIR)).toBeNull();
	});

	it('keeps a `..` that stays inside the project, normalised', () => {
		expect(withinProject(`${DIR}/src/../spec/model.ts`, DIR)).toBe('spec/model.ts');
		expect(withinProject(`${DIR}/./src//a.ts`, DIR)).toBe('src/a.ts');
	});

	it('refuses absolute paths, even ones naming the project', () => {
		expect(withinProject('/etc/passwd', DIR)).toBeNull();
		expect(withinProject(`/${DIR}/src/a.ts`, DIR)).toBeNull();
	});

	it('refuses a sibling that only shares the prefix', () => {
		expect(withinProject('.builder/projects/x-2/src/a.ts', DIR)).toBeNull();
		expect(withinProject('.builder/projects/xy', DIR)).toBeNull();
	});

	it('refuses the project directory itself and the empty path', () => {
		expect(withinProject(DIR, DIR)).toBeNull();
		expect(withinProject(`${DIR}/`, DIR)).toBeNull();
		expect(withinProject('', DIR)).toBeNull();
	});

	it('judges a path that climbs out and back in by where it ends up', () => {
		// Normalises to a path inside the project — allowed, because it IS inside.
		expect(withinProject(`${DIR}/../x/a.ts`, DIR)).toBe('a.ts');
		// A leading `..` never normalises back under a relative project dir.
		expect(withinProject(`../${DIR}/a.ts`, DIR)).toBeNull();
	});

	it('tolerates a trailing slash on the project dir', () => {
		expect(withinProject(`${DIR}/a.ts`, `${DIR}/`)).toBe('a.ts');
	});
});
