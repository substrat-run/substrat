import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { restoreMissing, SNAPSHOT_EVERY_MS, snapshotDue } from '../src/progress.js';

describe('a turn’s work between commits', () => {
	it('writes back what a lost container took, and leaves a newer file alone', async () => {
		const ws = new LocalWorkspace({ root: await mkdtemp(join(tmpdir(), 'builder-progress-')) });
		await ws.mkdir('proj/src', { recursive: true });
		await ws.writeFile('proj/src/kept.ts', 'newer');

		const restored = await restoreMissing(ws, 'proj', { 'src/kept.ts': 'older', 'src/module.ts': 'lost', 'app/main.ts': 'lost' });

		expect(restored).toBe(2);
		expect(await ws.readFile('proj/src/kept.ts')).toBe('newer');
		expect(await ws.readFile('proj/src/module.ts')).toBe('lost');
		expect(await ws.readFile('proj/app/main.ts')).toBe('lost');
	});

	it('snapshots at most once per interval', () => {
		expect(snapshotDue(1_000, 1_000 + SNAPSHOT_EVERY_MS - 1)).toBe(false);
		expect(snapshotDue(1_000, 1_000 + SNAPSHOT_EVERY_MS)).toBe(true);
	});
});
