/**
 * How a built release crosses from the build container to the agent.
 *
 * A sandbox read is one Workers RPC, and workerd refuses a reply over 32 MiB serialised. A
 * string holding one character outside Latin-1 serialises at two bytes a character, so one
 * JSON file of the whole release was refused at 16 Mi characters, and a vertical past that
 * failed every build. Each part is written as base64 chunks instead: ASCII, so it cannot
 * double, and at most 8 Mi characters, so no read nears the limit whatever the bundle holds.
 * The agent decodes one chunk at a time into the part's own bytes, and what it holds at the
 * end is the release, not the release beside its JSON and its parsed copy.
 */
import { SourceBuildError } from './problem.js';

export const RELEASE_DIR = '/build/release';
/** Bytes of a part per chunk: 8 Mi characters of base64, and a multiple of 3 so none is padded. */
export const CHUNK_BYTES = 6 * 1024 * 1024;
/** The release as bytes, summed over its parts. */
export const RELEASE_BYTES_MAX = 24 * 1024 * 1024;

export interface ReleasePart {
	name: string;
	bytes: number;
	chunks: number;
	/** A file's media type; absent on a text field. */
	type?: string;
}

export interface ReleaseIndex {
	parts: ReleasePart[];
	dataLoss: unknown;
}

export const releaseIndexPath = (dir: string): string => `${dir}/index.json`;
export const releaseChunkPath = (dir: string, part: number, chunk: number): string => `${dir}/${part}.${chunk}.b64`;

/** The release in `dir`, read through `read`, which answers a file's text. */
export async function collectRelease(read: (path: string) => Promise<string>, dir = RELEASE_DIR): Promise<{ form: FormData; dataLoss: unknown }> {
	const index = JSON.parse(await read(releaseIndexPath(dir))) as ReleaseIndex;
	if (index.parts.reduce((sum, part) => sum + part.bytes, 0) > RELEASE_BYTES_MAX) throw new SourceBuildError('release output exceeds the build transfer limit');
	const form = new FormData();
	for (const [i, part] of index.parts.entries()) {
		const bytes = new Uint8Array(part.bytes);
		let offset = 0;
		for (let chunk = 0; chunk < part.chunks; chunk++) {
			const binary = atob(await read(releaseChunkPath(dir, i, chunk)));
			for (let c = 0; c < binary.length; c++) bytes[offset + c] = binary.charCodeAt(c);
			offset += binary.length;
		}
		if (offset !== part.bytes) throw new Error(`release part ${part.name} arrived as ${offset} of ${part.bytes} bytes`);
		if (part.type === undefined) form.set(part.name, new TextDecoder().decode(bytes));
		else form.set(part.name, new Blob([bytes], { type: part.type }), part.name);
	}
	return { form, dataLoss: index.dataLoss };
}
