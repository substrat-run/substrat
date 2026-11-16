/**
 * Where a submitted snapshot of a GitHub project is kept (#2952).
 *
 * A CLI push to a `github` project builds source the team never committed, so the platform
 * keeps that source itself: the release's `manifest.build.revision` names a commit, and the
 * commit has to live somewhere. It lives in ONE Artifacts repository per project,
 * `snapshots-<projectId>`, each build as its own branch `builds/<buildId>`. Builds of one
 * project share objects, removing the project deletes one repository, and the branches are
 * pruned to the newest `SNAPSHOTS_KEPT` after every build.
 *
 * Each build used to create a repository of its own, `snapshot-<buildId>`, which nothing
 * read and nothing deleted. `pruneLegacySnapshots` is the operator's way to delete those.
 *
 * Promotion and rollback use stored release outputs, never this source, so pruning never
 * breaks a deploy. What it does end is a pruned build's `manifest.build.revision` resolving
 * to source: past the newest `SNAPSHOTS_KEPT` builds of a project, that commit is gone.
 */
import type { SandboxLike } from '@substrat-run/builder-workspace/edge';
import { checkedExec, repositoryGit, type RepositoryAccess } from './repositories.js';

/** How many submitted-snapshot builds of one project keep their source. */
export const SNAPSHOTS_KEPT = 20;

/** The one snapshot repository of project `projectId`. Artifacts names are lower case. */
export const snapshotRepositoryName = (projectId: string): string => `snapshots-${projectId.toLowerCase()}`;

const BUILD_REF_PREFIX = 'refs/heads/builds/';
const BUILD_REF = /^refs\/heads\/builds\/([0-9A-HJKMNP-TV-Z]{26})$/;

/**
 * A branch rather than a ref outside `refs/heads/`: every Artifacts surface (`readFile`,
 * `log`) resolves a branch, so a build's source stays readable by name.
 */
export const buildRef = (buildId: string): string => `${BUILD_REF_PREFIX}${buildId}`;

/**
 * The build refs to delete so that `kept` remain: the oldest first. A build id is a ULID, so
 * its text orders builds by time. A ref that is not a build id is never touched.
 */
export function prunedBuildRefs(refs: readonly string[], kept = SNAPSHOTS_KEPT): string[] {
	const builds = refs.filter((ref) => BUILD_REF.test(ref)).sort();
	return builds.slice(0, Math.max(0, builds.length - kept));
}

interface ArtifactsCreate {
	create(name: string, opts: { setDefaultBranch: string }): Promise<unknown>;
}

/** Creates the repository unless it exists already. */
export async function ensureRepository(artifacts: ArtifactsCreate, name: string): Promise<void> {
	try {
		await artifacts.create(name, { setDefaultBranch: 'main' });
	} catch (error) {
		if ((error as { code?: string } | null)?.code !== 'ALREADY_EXISTS') throw error;
	}
}

/**
 * Pushes the checkout's HEAD as build `buildId`, then deletes the build branches past the newest
 * `kept`. Returns the commit pushed. A failed prune is reported, never thrown: the build's own
 * source is saved by then, and the next build prunes again.
 */
export async function saveBuildSnapshot(
	sb: SandboxLike,
	access: RepositoryAccess,
	root: string,
	buildId: string,
	kept = SNAPSHOTS_KEPT,
): Promise<{ revision: string; pruned: string[]; pruneError?: unknown }> {
	const revision = await checkedExec(sb, 'git rev-parse HEAD', root);
	await repositoryGit(sb, access, ['push', access.remote, `HEAD:${buildRef(buildId)}`], root);
	try {
		const listed = await repositoryGit(sb, access, ['ls-remote', '--heads', access.remote, `${BUILD_REF_PREFIX}*`], root);
		const refs = listed.split('\n').map((line) => line.split(/\s+/)[1] ?? '').filter(Boolean);
		// The build just pushed is the newest, so it is never among the pruned.
		const pruned = prunedBuildRefs(refs, kept).filter((ref) => ref !== buildRef(buildId));
		if (pruned.length) await repositoryGit(sb, access, ['push', access.remote, ...pruned.map((ref) => `:${ref}`)], root);
		return { revision, pruned };
	} catch (pruneError) {
		return { revision, pruned: [], pruneError };
	}
}

/** A repository the per-build scheme created: `snapshot-` and a lower-cased build id. */
export const LEGACY_SNAPSHOT = /^snapshot-[0-9a-hjkmnp-tv-z]{26}$/;

export interface ArtifactsListDelete {
	list(opts?: { limit?: number; cursor?: string }): Promise<{ repos: { name: string }[]; cursor?: string }>;
	delete(name: string): Promise<boolean>;
}

/** At most this many legacy repositories are deleted per call: each delete is a subrequest. */
export const LEGACY_DELETES_PER_CALL = 200;

/**
 * Finds the per-build `snapshot-<buildId>` repositories in the namespace and, only when `apply`
 * is set, deletes up to `limit` of them. Without `apply` it is a dry run that deletes nothing.
 * `more` says another call has work left; call again until it is false.
 */
export async function pruneLegacySnapshots(
	artifacts: ArtifactsListDelete,
	{ apply = false, limit = LEGACY_DELETES_PER_CALL }: { apply?: boolean; limit?: number } = {},
): Promise<{ apply: boolean; found: string[]; deleted: string[]; more: boolean }> {
	const found: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await artifacts.list({ limit: 200, ...(cursor ? { cursor } : {}) });
		for (const repo of page.repos) if (LEGACY_SNAPSHOT.test(repo.name)) found.push(repo.name);
		cursor = page.repos.length ? page.cursor : undefined;
	} while (cursor && found.length <= limit);
	const batch = found.slice(0, limit);
	const deleted: string[] = [];
	if (apply) for (const name of batch) if (await artifacts.delete(name)) deleted.push(name);
	return { apply, found: batch, deleted, more: found.length > limit || cursor !== undefined };
}
