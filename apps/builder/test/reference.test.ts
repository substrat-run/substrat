import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalWorkspace } from '@substrat-run/builder-workspace';
import { describe, expect, it } from 'vitest';
import { openReferences } from '../src/reference.js';

describe('the template reference', () => {
	it('carries the project files a scaffold computes, beside what the directory holds', async () => {
		const root = await mkdtemp(join(tmpdir(), 'builder-reference-'));
		await writeFile(join(root, 'AGENTS.md'), 'rules\n');
		const { template, todo } = openReferences((_dir, id) => new LocalWorkspace({ root, id }));

		const manifest = JSON.parse(await template!.readFile('package.json')) as { dependencies: Record<string, string> };
		expect(manifest.dependencies['@substrat-run/kernel']).toMatch(/^\^\d+\.\d+\.\d+$/);
		expect(await template!.readFile('./tsconfig.json')).toContain('NodeNext');
		expect(await template!.readFile('AGENTS.md')).toBe('rules\n');
		expect(await template!.listFiles('.')).toEqual(expect.arrayContaining(['AGENTS.md', 'package.json', 'tsconfig.json', 'vitest.config.ts']));
		// copy_reference reads a listing that throws as "this is a file".
		await expect(template!.listFiles('package.json')).rejects.toThrow();
		await expect(todo!.readFile('package.json')).rejects.toThrow();
	});
});
