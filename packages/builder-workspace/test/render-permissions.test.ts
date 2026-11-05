/**
 * The studio renders PERMISSIONS.md after a turn so the human sees a diff to review,
 * instead of the later `--check` reporting drift. The surface depends on the
 * operations' declared checks, which live in `spec/model.ts` — so a turn that
 * changes only the model must render too. The emitter is intercepted at the
 * Workspace seam (counted, never executed), so the test stays offline and fast.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalWorkspace } from '../src/local.js';
import { ensureVerticalRepo, runTurn } from '../src/turn.js';
import type { ExecOptions, ExecResult } from '../src/workspace.js';

const PROJECT = '.builder/projects/x';

class EmitterSpyWorkspace extends LocalWorkspace {
	renders = 0;
	override async exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
		if (cmd.includes('permission-diff')) {
			this.renders += 1;
			return { stdout: '', stderr: '', exitCode: 0 };
		}
		return super.exec(cmd, opts);
	}
}

describe('rendering PERMISSIONS.md after a turn', () => {
	it('renders when only spec/model.ts changed, and not when nothing it depends on did', async () => {
		const root = await mkdtemp(join(tmpdir(), 'builder-render-'));
		const ws = new EmitterSpyWorkspace({ root });
		await ws.exec('git init -q');
		await ws.writeFile('tools/permission-diff.mts', '// stub\n');
		await ws.writeFile('README.md', 'seed\n');
		await ws.exec('git add -A');
		await ws.exec('git -c user.name=t -c user.email=t@t commit -q -m seed');
		await ensureVerticalRepo(ws, PROJECT);
		await ws.writeFile(
			`${PROJECT}/package.json`,
			JSON.stringify({ name: 'x', private: true, substrat: { permissions: 'src/provision.ts' } }),
		);
		await ws.writeFile(`${PROJECT}/PERMISSIONS.md`, 'rendered\n');
		await ws.writeFile(`${PROJECT}/spec/model.ts`, 'export const model = 0;\n');
		await ws.mkdir(`${PROJECT}/node_modules`, { recursive: true });
		await runTurn(ws, { verticalDir: PROJECT, message: 't1', gates: [] });
		ws.renders = 0;

		await ws.writeFile(`${PROJECT}/notes.md`, 'unrelated\n');
		await runTurn(ws, { verticalDir: PROJECT, message: 't2', gates: [] });
		expect(ws.renders).toBe(0);

		await ws.writeFile(`${PROJECT}/spec/model.ts`, 'export const model = 1;\n');
		await runTurn(ws, { verticalDir: PROJECT, message: 't3', gates: [] });
		expect(ws.renders).toBe(1);
		await ws.dispose();
	});
});
