/** The build container's half of release-files.ts; node-only, so the agent never imports it. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { CHUNK_BYTES, releaseChunkPath, releaseIndexPath, type ReleasePart } from './release-files.js';

export async function writeRelease(form: FormData, dataLoss: unknown, dir: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	const parts: ReleasePart[] = [];
	for (const [i, [name, value]] of [...form.entries()].entries()) {
		const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(await value.arrayBuffer());
		const chunks = Math.ceil(bytes.length / CHUNK_BYTES);
		for (let chunk = 0; chunk < chunks; chunk++) {
			writeFileSync(releaseChunkPath(dir, i, chunk), bytes.subarray(chunk * CHUNK_BYTES, (chunk + 1) * CHUNK_BYTES).toString('base64'));
		}
		parts.push({ name, bytes: bytes.length, chunks, ...(typeof value === 'string' ? {} : { type: value.type }) });
	}
	writeFileSync(releaseIndexPath(dir), JSON.stringify({ parts, dataLoss }));
}
