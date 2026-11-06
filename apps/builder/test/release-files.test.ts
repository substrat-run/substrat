/**
 * A release crosses from the build container to the agent in reads that each fit one Workers
 * RPC (release-files.ts). The reader here refuses what workerd would, so a release that would
 * only fail in production fails here: a heap limit cannot be simulated in node, an RPC limit can.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SourceBuildError } from '../src/problem.js';
import { collectRelease, RELEASE_BYTES_MAX, releaseChunkPath, releaseIndexPath } from '../src/release-files.js';
import { writeRelease } from '../src/release-write.js';

const RPC_LIMIT = 32 * 1024 * 1024;
const dirs: string[] = [];
const scratch = (): string => {
	const dir = mkdtempSync(join(tmpdir(), 'release-'));
	dirs.push(dir);
	return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A sandbox read as workerd sizes it: two bytes a character once one falls outside Latin-1. */
const overRpc = async (path: string): Promise<string> => {
	const text = readFileSync(path, 'utf8');
	// eslint-disable-next-line no-control-regex
	const size = text.length * (/^[\u0000-ÿ]*$/.test(text) ? 1 : 2);
	if (size > RPC_LIMIT) throw new Error(`Serialized RPC arguments or return values are limited to 32MiB, but the size of this value was: ${size} bytes.`);
	return text;
};

describe('a release in transit', () => {
	it('arrives whole past the size one JSON read was refused at', async () => {
		const dir = scratch();
		// As one JSON file this is over 19 Mi characters with a non-Latin-1 one: 38 MiB serialised.
		const bundle = new Uint8Array(10 * 1024 * 1024).map((_, i) => i % 251);
		const script = `${'a'.repeat(6 * 1024 * 1024)}→`;
		const form = new FormData();
		form.set('manifest', '{"name":"→ åäö"}');
		form.set('script', script);
		form.set('bundle', new Blob([bundle], { type: 'application/gzip' }), 'bundle');
		await writeRelease(form, { tables: ['a'] }, dir);

		const { form: read, dataLoss } = await collectRelease(overRpc, dir);

		expect(dataLoss).toEqual({ tables: ['a'] });
		expect(read.get('manifest')).toBe('{"name":"→ åäö"}');
		expect(read.get('script') === script).toBe(true);
		const file = read.get('bundle') as File;
		expect(file.type).toBe('application/gzip');
		expect(file.name).toBe('bundle');
		expect(Buffer.compare(new Uint8Array(await file.arrayBuffer()), bundle)).toBe(0);
	});

	it('refuses a release over the transfer limit before reading any part of it', async () => {
		const dir = scratch();
		const form = new FormData();
		form.set('bundle', new Blob([new Uint8Array(1)]), 'bundle');
		await writeRelease(form, null, dir);
		const index = JSON.parse(readFileSync(releaseIndexPath(dir), 'utf8'));
		const read = async (path: string): Promise<string> => {
			if (path === releaseIndexPath(dir)) return JSON.stringify({ ...index, parts: [{ ...index.parts[0], bytes: RELEASE_BYTES_MAX + 1 }] });
			throw new Error(`read ${path}`);
		};
		await expect(collectRelease(read, dir)).rejects.toThrow(SourceBuildError);
	});

	it('refuses a part that arrives short, rather than shipping zeroes', async () => {
		const dir = scratch();
		const form = new FormData();
		form.set('bundle', new Blob([new Uint8Array(9).fill(7)]), 'bundle');
		await writeRelease(form, null, dir);
		const read = async (path: string): Promise<string> => (path === releaseChunkPath(dir, 0, 0) ? 'BwcH' : readFileSync(path, 'utf8'));
		await expect(collectRelease(read, dir)).rejects.toThrow('arrived as 3 of 9 bytes');
	});
});
