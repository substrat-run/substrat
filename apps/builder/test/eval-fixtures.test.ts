/**
 * The fixtures ON DISK, checked without a model. `evals.test.ts` pins the
 * referee; this file pins the corpus it referees — because everything below is
 * otherwise only discovered when a sweep runs, and a sweep costs tokens and an
 * API key. A malformed `expect.json` or a pin naming an operation the concept
 * never froze reads as a generator failure when it is a fixture failure (#723).
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertFixtureStart, parseExpectations, type EvalFixture } from '../src/evals/harness.js';

const EVALS_DIR = join(import.meta.dirname, '..', 'evals');

/** Mirrors `loadFixtures` in evals-cli.ts: a directory is a fixture iff it has expect.json. */
async function fixtureDirs(): Promise<string[]> {
	const entries = await readdir(EVALS_DIR, { withFileTypes: true });
	return entries
		.filter((e) => e.isDirectory() && existsSync(join(EVALS_DIR, e.name, 'expect.json')))
		.map((e) => e.name)
		.sort();
}

async function load(name: string): Promise<EvalFixture> {
	const dir = join(EVALS_DIR, name);
	const has = (f: string) => existsSync(join(dir, f));
	const read = (f: string) => readFile(join(dir, f), 'utf8');
	return {
		name,
		...(has('concept.md') ? { concept: await read('concept.md') } : {}),
		...(has('prompt.md') ? { prompt: await read('prompt.md') } : {}),
		...(has('answers.md') ? { answers: await read('answers.md') } : {}),
		expect: parseExpectations(JSON.parse(await read('expect.json')) as unknown, `evals/${name}/expect.json`),
	};
}

describe('the fixtures under apps/builder/evals/', () => {
	it('all parse and all declare exactly one starting point', async () => {
		const names = await fixtureDirs();
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			// parseExpectations throws on an unknown field or a malformed pin, and
			// assertFixtureStart throws on both-or-neither starting points.
			const fixture = await load(name);
			expect(() => assertFixtureStart(fixture), name).not.toThrow();
		}
	});

	it('pins nothing a frozen concept did not freeze', async () => {
		// A concept fixture hands the model exactly one document. An operation or
		// role pinned in expect.json but absent from that document grades the
		// generator on a name it was never given — which is unwinnable, and reads
		// as a build failure rather than as the fixture bug it is.
		//
		// Matched as the WHOLE backticked token, not as a substring: a concept
		// freezes a key by writing it as inline code, and prose is full of near
		// misses. A pinned `account` role passes a substring check against the
		// word "accounting", and `crew` survives in the narrative long after its
		// role declaration is deleted — so the loose check would go on passing
		// for a key the fixture no longer freezes.
		for (const name of await fixtureDirs()) {
			const fixture = await load(name);
			if (fixture.concept === undefined) continue;
			for (const op of fixture.expect.operations ?? []) {
				expect(fixture.concept, `${name}: operation ${op}`).toContain(`\`${op}\``);
			}
			for (const role of Object.keys(fixture.expect.roles ?? {})) {
				expect(fixture.concept, `${name}: role ${role}`).toContain(`\`${role}\``);
			}
		}
	});

	it('keeps the superseded paving fixture frozen beside its successor', async () => {
		// #723: paveworks2 closes four gaps paveworks could not be built through.
		// Both stay in the default sweep, and the older concept stays untouched —
		// editing it would invalidate every historical result against it.
		const names = await fixtureDirs();
		expect(names).toContain('paveworks');
		expect(names).toContain('paveworks2');
		const old = await load('paveworks');
		const next = await load('paveworks2');
		expect(old.concept).not.toContain('paveworks2');
		expect(next.concept).toContain('Supersedes the `paveworks` fixture');
		// The successor's mutation surface is its own, so a run report never has
		// to guess which paving fixture an operation name came from. An engine
		// operation the vertical only mounts (`invoicing/export`) is pinned under
		// the engine's name, which is unambiguous already — what must never appear
		// is the older fixture's namespace.
		for (const op of next.expect.operations ?? []) {
			expect(op.startsWith('paveworks/'), op).toBe(false);
			if (op.startsWith('paveworks')) expect(op.startsWith('paveworks2/'), op).toBe(true);
		}
	});
});
