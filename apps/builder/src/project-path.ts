/**
 * Is a repo-relative path inside a project directory? (#1225)
 *
 * The studio's file-write route takes a path from the browser and must keep it
 * inside the current project. A text prefix check cannot answer that:
 * `.builder/projects/x/../../../CLAUDE.md` starts with `.builder/projects/x/`
 * and still names a file at the repo root, which the root workspace happily
 * writes because it only refuses paths that leave the REPO. So the path is
 * normalised first and the question is asked of where it actually points.
 *
 * Returns the path RELATIVE TO THE PROJECT, so the caller can hand it to the
 * project-rooted workspace — whose own jail then also judges symlinks — or
 * `null` when the path is absolute, is the project directory itself, or
 * resolves anywhere outside it.
 */
import { posix } from 'node:path';

export function withinProject(path: string, dir: string): string | null {
	if (path === '' || posix.isAbsolute(path)) return null;
	const base = posix.normalize(dir).replace(/\/+$/, '');
	const normalised = posix.normalize(path);
	// A sibling that merely shares the prefix (`x-2/` beside `x/`) is outside:
	// the trailing slash is what makes this a directory test, not a string one.
	if (!normalised.startsWith(`${base}/`)) return null;
	const rel = normalised.slice(base.length + 1).replace(/\/+$/, '');
	return rel === '' ? null : rel;
}
