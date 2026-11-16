import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxLike } from '@substrat-run/builder-workspace/edge';
import { buildRef, ensureRepository, pruneLegacySnapshots, prunedBuildRefs, saveBuildSnapshot, snapshotRepositoryName, type ArtifactsListDelete } from '../src/build-snapshots.js';
import { ulid } from '../src/build-log.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sandbox: SandboxLike = {
	async exec(command, options) {
		try { return { stdout: execFileSync('/bin/sh', ['-c', command], { cwd: options?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '', exitCode: 0 }; }
		catch (error) { const e = error as { stdout?: string; stderr?: string; status?: number }; return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), exitCode: e.status ?? 1 }; }
	},
	async readFile(path) { return readFileSync(path, 'utf8'); },
	async writeFile(path, content) { writeFileSync(path, content); },
	async mkdir(path) { mkdirSync(path, { recursive: true }); },
	async listFiles() { return []; },
	async exposePort() { return { url: '' }; },
};

const id = (n: number) => `01J${String(n).padStart(23, '0')}`;

describe('build snapshots (#2952)', () => {
	it('keeps every build of a project in one repository and prunes past the newest kept', async () => {
		const root = mkdtempSync(join(tmpdir(), 'build-snapshots-'));
		roots.push(root);
		const remote = join(root, 'snapshots.git');
		execFileSync('git', ['init', '--bare', '--initial-branch=main', '-q', remote]);
		const work = join(root, 'work');
		execFileSync('git', ['init', '-q', '--initial-branch=main', work]);
		const access = { remote, authorization: 'Bearer fixture-token' };
		writeFileSync(join(work, 'base.ts'), 'the GitHub base');
		execFileSync('git', ['-C', work, 'add', '-A']);
		execFileSync('git', ['-C', work, '-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-qm', 'base']);
		const base = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
		const builds = [id(1), id(2), id(3), id(4)];
		const revisions: string[] = [];
		const pruned: string[][] = [];
		for (const build of builds) {
			// As in production, each snapshot is a sibling commit on the GitHub base, not a chain.
			execFileSync('git', ['-C', work, 'reset', '-q', '--hard', base]);
			writeFileSync(join(work, 'app.ts'), build);
			execFileSync('git', ['-C', work, 'add', '-A']);
			execFileSync('git', ['-C', work, '-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-qm', build]);
			const saved = await saveBuildSnapshot(sandbox, access, work, build, 2);
			expect(saved.pruneError).toBeUndefined();
			revisions.push(saved.revision);
			pruned.push(saved.pruned);
		}
		expect(pruned).toEqual([[], [], [buildRef(id(1))], [buildRef(id(2))]]);
		const refs = execFileSync('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8' }).trim().split('\n');
		expect(refs).toEqual([`${buildRef(id(3))} ${revisions[2]}`, `${buildRef(id(4))} ${revisions[3]}`]);
		// A pruned snapshot is reachable from no ref that is left.
		for (const gone of revisions.slice(0, 2)) {
			expect(execFileSync('git', ['--git-dir', remote, 'for-each-ref', '--contains', gone!], { encoding: 'utf8' }).trim()).toBe('');
		}
	});

	it('saves the build even when pruning fails, and reports the failure', async () => {
		const root = mkdtempSync(join(tmpdir(), 'build-snapshots-'));
		roots.push(root);
		const remote = join(root, 'snapshots.git');
		execFileSync('git', ['init', '--bare', '--initial-branch=main', '-q', remote]);
		const work = join(root, 'work');
		execFileSync('git', ['init', '-q', '--initial-branch=main', work]);
		writeFileSync(join(work, 'app.ts'), 'x');
		execFileSync('git', ['-C', work, 'add', '-A']);
		execFileSync('git', ['-C', work, '-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-qm', 'x']);
		const listingFails: SandboxLike = { ...sandbox, async exec(command, options) {
			return command.includes("'ls-remote'") ? { stdout: '', stderr: 'down', exitCode: 1 } : sandbox.exec(command, options);
		} };
		const saved = await saveBuildSnapshot(listingFails, { remote, authorization: 'Bearer fixture-token' }, work, id(1));
		expect(saved.pruneError).toBeInstanceOf(Error);
		expect(saved.pruned).toEqual([]);
		expect(execFileSync('git', ['--git-dir', remote, 'rev-parse', buildRef(id(1))], { encoding: 'utf8' }).trim()).toBe(saved.revision);
	});

	it('orders by build id, never prunes what is not a build ref, and names one repository per project', () => {
		const refs = [buildRef(id(3)), 'refs/heads/main', buildRef(id(1)), 'refs/heads/builds/not-a-build', buildRef(id(2))];
		expect(prunedBuildRefs(refs, 1)).toEqual([buildRef(id(1)), buildRef(id(2))]);
		expect(prunedBuildRefs(refs, 5)).toEqual([]);
		const project = ulid();
		expect(snapshotRepositoryName(project)).toBe(`snapshots-${project.toLowerCase()}`);
	});

	it('creates the repository once and passes any other create failure on', async () => {
		const exists = Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
		await expect(ensureRepository({ create: async () => { throw exists; } }, 'snapshots-x')).resolves.toBeUndefined();
		const other = Object.assign(new Error('bad'), { code: 'INVALID_REPO_NAME' });
		await expect(ensureRepository({ create: async () => { throw other; } }, 'snapshots-x')).rejects.toBe(other);
	});

	it('finds only per-build snapshot repositories, deletes nothing on a dry run, and deletes in bounded batches', async () => {
		const legacy = [ulid(), ulid(), ulid()].map((b) => `snapshot-${b.toLowerCase()}`);
		const names = new Set([...legacy, `project-${ulid().toLowerCase()}`, `snapshots-${ulid().toLowerCase()}`, 'snapshot-short']);
		const artifacts: ArtifactsListDelete = {
			async list(opts) {
				// Two repositories a page, to walk the cursor.
				const all = [...names].sort();
				const start = Number(opts?.cursor ?? 0);
				const next = start + 2;
				return { repos: all.slice(start, next).map((name) => ({ name })), ...(next < all.length ? { cursor: String(next) } : {}) };
			},
			async delete(name) { return names.delete(name); },
		};
		const dry = await pruneLegacySnapshots(artifacts);
		expect(dry).toEqual({ apply: false, found: [...legacy].sort(), deleted: [], more: false });
		expect(names.size).toBe(6);
		const first = await pruneLegacySnapshots(artifacts, { apply: true, limit: 2 });
		expect(first.deleted).toHaveLength(2);
		expect(first.more).toBe(true);
		const second = await pruneLegacySnapshots(artifacts, { apply: true, limit: 2 });
		expect(second).toMatchObject({ deleted: [legacy.sort()[2]], more: false });
		expect([...names].some((n) => n.startsWith('snapshot-') && n !== 'snapshot-short')).toBe(false);
		expect(names.size).toBe(3);
	});
});
