import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { restoreWork, SNAPSHOT_EVERY_MS, snapshotDue, workIn } from '../src/progress.js';

describe('a turn’s work between commits', () => {
	it.each(['.', 'proj'])('puts a turn’s work back on a fresh checkout of %s', async (dir) => {
		const ws = new LocalWorkspace({ root: await mkdtemp(join(tmpdir(), 'builder-progress-')) });
		const at = (rel: string): string => (dir === '.' ? rel : `${dir}/${rel}`);
		await ws.writeFile(at('src/edited.ts'), 'committed');
		await ws.writeFile(at('src/deleted.ts'), 'committed');
		await ws.writeFile(at('src/same.ts'), 'committed');
		await ws.writeFile(at('logo.png'), 'committed');
		await ws.writeFile(at('node_modules/dep/index.js'), 'committed');
		await ws.writeFile('other.ts', 'outside');
		const git = await ws.exec('git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -q -m t');
		expect(git.exitCode).toBe(0);

		const restored = await restoreWork(ws, dir, {
			files: { 'src/edited.ts': 'work', 'src/same.ts': 'committed', 'app/new.ts': 'work', ...(dir === '.' ? { 'other.ts': 'outside' } : {}) },
			skipped: ['logo.png'],
		});

		expect(restored).toBe(3);
		expect(await ws.readFile(at('src/edited.ts'))).toBe('work');
		expect(await ws.readFile(at('app/new.ts'))).toBe('work');
		expect(await ws.exists(at('src/deleted.ts'))).toBe(false);
		expect(await ws.exists(at('logo.png'))).toBe(true);
		expect(await ws.exists(at('node_modules/dep/index.js'))).toBe(true);
		expect(await ws.exists('other.ts')).toBe(true);
	});

	it('finds work only in a snapshot marked as holding it', () => {
		const files = { 'a.ts': 'x' };
		expect(workIn(JSON.stringify({ work: true, files, skipped: ['b.png'] }))).toEqual({ files, skipped: ['b.png'] });
		expect(workIn(JSON.stringify({ work: false, files }))).toBeNull();
		expect(workIn(JSON.stringify({ files }))).toBeNull();
		expect(workIn('{"work":true')).toBeNull();
		expect(workIn(undefined)).toBeNull();
	});

	it('snapshots at most once per interval', () => {
		expect(snapshotDue(1_000, 1_000 + SNAPSHOT_EVERY_MS - 1)).toBe(false);
		expect(snapshotDue(1_000, 1_000 + SNAPSHOT_EVERY_MS)).toBe(true);
	});
});
