/**
 * ContainerWorkspace against a fake sandbox: the seam's promises — path
 * confinement identical to LocalWorkspace, result-shape normalization — hold
 * without a container. (The real container is exercised by wrangler dev; this
 * pins the CLASS's behaviour, which is what the generator depends on.)
 */
import { describe, expect, it } from 'vitest';
import { ContainerWorkspace, type SandboxLike } from '../src/container.js';
import { standaloneGates } from '../src/gates.js';
import { emitProjectModel } from '../src/model.js';
import { WorkspacePathError } from '../src/workspace.js';

function fake(extra: readonly string[] = []): { sb: SandboxLike; calls: string[] } {
	const calls: string[] = [];
	const files = new Map<string, string>([['/w/p/src/a.ts', 'A'], ...extra.map((p) => [p, ''] as const)]);
	const sb: SandboxLike = {
		async exec(cmd, opts) {
			calls.push(`exec:${cmd}@${opts?.cwd ?? ''}`);
			if (cmd.startsWith('test -e')) {
				const p = cmd.match(/"([^"]+)"/)?.[1] ?? '';
				return { stdout: '', stderr: '', exitCode: files.has(p) || p === '/w/p' ? 0 : 1 };
			}
			return { stdout: 'ok', stderr: '', exitCode: 0 };
		},
		async readFile(path) {
			calls.push(`read:${path}`);
			const c = files.get(path);
			if (c === undefined) throw new Error('missing');
			return { content: c };
		},
		async writeFile(path, content) {
			calls.push(`write:${path}`);
			files.set(path, content);
		},
		async mkdir(path) {
			calls.push(`mkdir:${path}`);
		},
		async listFiles(path) {
			calls.push(`ls:${path}`);
			return { files: [{ name: 'a.ts', type: 'file' }, { name: 'sub', type: 'directory' }] };
		},
		async exposePort(port) {
			return { url: `https://p${port}.example` };
		},
	};
	return { sb, calls };
}

describe('ContainerWorkspace (§3 seam, mode C)', () => {
	it('runs host checkers from the toolchain while resolving project arguments in the source repo', async () => {
		const { sb, calls } = fake();
		const ws = new ContainerWorkspace({ sandbox: sb, root: '/source', toolchainRoot: '/platform toolchain' });
		await ws.exec('pnpm exec tsx tools/model-diff.mts --root "." --check');
		await ws.exec('node packages/boundary-lint/dist/cli.js --root .');
		await ws.exec('pnpm exec tsc --noEmit spec/model.ts');
		await ws.exec('pnpm install --frozen-lockfile');
		expect(calls).toEqual([
			'exec:\'/platform toolchain/node_modules/.bin/tsx\' \'/platform toolchain/tools/model-diff.mts\' --root "." --check@/source',
			'exec:node \'/platform toolchain/packages/boundary-lint/dist/cli.js\' --root .@/source',
			'exec:\'/platform toolchain/node_modules/.bin/tsc\' --noEmit spec/model.ts@/source',
			'exec:pnpm install --frozen-lockfile@/source',
		]);
	});
	it('runs the model gate\'s tsc from the toolchain in both branches of its shell if', async () => {
		const { sb, calls } = fake();
		const ws = new ContainerWorkspace({ sandbox: sb, root: '/w/p', toolchainRoot: '/tc' });
		const gate = standaloneGates('.').find((g) => g.name === 'model');
		await ws.exec(gate?.cmd ?? '');
		const cmd = calls.at(-1) ?? '';
		expect(cmd).not.toContain('pnpm exec tsc');
		expect(cmd.split("'/tc/node_modules/.bin/tsc'").length - 1).toBe(2);
	});
	it('finds the model emitter where exec runs it, not in a source repo that has no tools/', async () => {
		const { sb, calls } = fake(['/w/p/spec/model.ts', '/tc/tools/model-diff.mts']);
		const ws = new ContainerWorkspace({ sandbox: sb, root: '/w/p', toolchainRoot: '/tc' });
		expect(await emitProjectModel(ws, '.')).toEqual({ status: 'emitted', output: '' });
		expect(calls.at(-1)).toBe('exec:\'/tc/node_modules/.bin/tsx\' \'/tc/tools/model-diff.mts\' --root "."@/w/p');
	});

	it('confines paths exactly like LocalWorkspace — escapes throw', async () => {
		const { sb } = fake();
		const ws = new ContainerWorkspace({ sandbox: sb, root: '/w/p' });
		await expect(ws.readFile('../secrets')).rejects.toThrow(WorkspacePathError);
		await expect(ws.readFile('/etc/passwd')).rejects.toThrow(WorkspacePathError);
		await expect(ws.readFile('a/../../up')).rejects.toThrow(WorkspacePathError);
		// interior ".." that stays inside is fine
		expect(await ws.readFile('src/x/../a.ts')).toBe('A');
	});

	it('normalizes sandbox result shapes to the Workspace contract', async () => {
		const { sb } = fake();
		const ws = new ContainerWorkspace({ sandbox: sb, root: '/w/p' });
		expect(await ws.listFiles('src')).toEqual(['a.ts', 'sub/']);
		const r = await ws.exec('echo hi');
		expect(r).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
		expect((await ws.exposePort(5271)).url).toBe('https://p5271.example');
	});

	it('roots exec cwd at the project and parents writes', async () => {
		const { sb, calls } = fake();
		const ws = new ContainerWorkspace({ sandbox: sb, root: '/w/p' });
		await ws.exec('pnpm typecheck');
		expect(calls.at(-1)).toBe('exec:pnpm typecheck@/w/p');
		await ws.writeFile('deep/dir/f.ts', 'x');
		expect(calls).toContain('mkdir:/w/p/deep/dir');
		expect(calls).toContain('write:/w/p/deep/dir/f.ts');
	});
});
