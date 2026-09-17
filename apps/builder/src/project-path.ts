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
/**
 * `posix.normalize`, hand-rolled, because this module is imported by the hosted
 * `BuilderAgent` — Worker code, which compiles with no node types and has no
 * `node:path` at runtime. The rule it enforces has to hold on the deployed half
 * above all, so the helper cannot be the thing that keeps it off there.
 *
 * Same answers as `posix.normalize` for the inputs this asks about: `.` and empty
 * segments drop, `..` pops the segment before it, and a `..` with nothing left to
 * pop is KEPT — which is what makes a path that climbs above the project fail the
 * prefix test below rather than silently resolving back into it.
 */
function normalise(path: string): string {
	const out: string[] = [];
	for (const seg of path.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg !== '..') {
			out.push(seg);
		} else if (out.length > 0 && out[out.length - 1] !== '..') {
			out.pop();
		} else {
			out.push('..');
		}
	}
	return out.join('/');
}

export function withinProject(path: string, dir: string): string | null {
	if (path === '' || path.startsWith('/')) return null;
	const base = normalise(dir).replace(/\/+$/, '');
	const normalised = normalise(path);
	// A sibling that merely shares the prefix (`x-2/` beside `x/`) is outside:
	// the trailing slash is what makes this a directory test, not a string one.
	if (!normalised.startsWith(`${base}/`)) return null;
	const rel = normalised.slice(base.length + 1).replace(/\/+$/, '');
	return rel === '' ? null : rel;
}
