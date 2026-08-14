/**
 * ContainerWorkspace against a fake sandbox: the seam's promises — path
 * confinement identical to LocalWorkspace, result-shape normalization — hold
 * without a container. (The real container is exercised by wrangler dev; this
 * pins the CLASS's behaviour, which is what the generator depends on.)
 */
import { describe, expect, it } from 'vitest';
import { ContainerWorkspace, type SandboxLike } from '../src/container.js';
import { WorkspacePathError } from '../src/workspace.js';

function fake(): { sb: SandboxLike; calls: string[] } {
	const calls: string[] = [];
	const files = new Map<string, string>([['/w/p/src/a.ts', 'A']]);
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
