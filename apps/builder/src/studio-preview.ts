/**
 * Hosted Run (#2895): the studio's preview is a PREVIEW SLOT, not a dev server.
 *
 * Run releases the project's saved revision (`POST /verticals/:slug/deploy`, the same call
 * `/api/release` makes) and binds that version to one reserved preview tag
 * (`POST /verticals/:slug/previews`). The slot is the platform's own (preview-and-snapshots.md),
 * so the app runs on the stack it ships on — router, workerd, OIDC login, migrations — and
 * nothing in the sandbox has to stay awake or be exposed. The build fetches the revision
 * through `repositoryAccess`, so a GitHub project and an Artifacts project take the same path.
 *
 * Always CLEAN-ROOM (`empty: true`): a fork would copy the tenant's live data into a page
 * anyone holding the builder entitlement can open, and that entitlement is not a data
 * permission. A tag's reuse keeps the scope it has, so every Run after the first rebinds
 * the same URL and refreshes its TTL.
 *
 * And SEEDED (`seed: true`, #3108): the project's sample world (`src/world.ts`) is seated in the
 * slot, and anyone on the team signs in by picking one of its people, as they do locally. A
 * project whose worker names no world gets a slot nobody can sign in to, and the plane's note
 * says so.
 *
 * Or, on request, PRODUCTION DATA (#3108): a fork of the installed app under its own tag
 * (`studio-data`), signed in through the app's real login. That copy is read by code the
 * studio just built, so the plane admits it only for the app's owner, judged in the app's own
 * scope. The studio therefore makes that call AS the signed-in person — a tenant token the plane
 * mints naming them — and never with the builder's own credential, which names nobody.
 *
 * Not a PR either: a per-PR preview is a GitHub Actions flow and exists only for GitHub
 * projects. That stays the separate "Create preview PR" step.
 */
import { z } from 'zod';
import { refuse } from './problem.js';

/** The one tag the studio's slot lives under — never a `pr-<n>`, which CI owns. */
export const STUDIO_PREVIEW_TAG = 'studio';

/** The production-data slot's tag: apart from the seeded one, since a tag keeps the kind it began as. */
export const STUDIO_DATA_PREVIEW_TAG = 'studio-data';

/** The control plane over the service binding: a path under its `/api`, and the request. */
export type ControlPlaneCall = (path: string, init?: RequestInit) => Promise<Response>;

export interface StudioProject {
	readonly slug: string;
	readonly revision?: string;
}

const releasedVersion = z.object({ id: z.string().min(1) });

/** The fields of a created preview the studio shows; the rest passes through untouched. */
const createdPreview = z.object({
	url: z.string().url(),
	versionId: z.string().min(1),
	reused: z.boolean(),
	auth: z.object({ status: z.string(), note: z.string() }).optional(),
});

const previewRow = z.object({
	tag: z.string().nullable(),
	versionId: z.string().nullable(),
	url: z.string().nullable(),
	expiresAt: z.string().nullable(),
});

export type StudioPreview = { state: 'ready'; url: string; versionId: string; reused: boolean; authNote?: string };

/** Whether a production-data preview would be admitted, and the studio's sentence when not. */
export type ForkAvailability = { ok: true } | { ok: false; reason: string };

const forkCheck = z.union([
	z.object({ ok: z.literal(true), sourceScopeId: z.string() }),
	z.object({ ok: z.literal(false), reason: z.string(), code: z.string().optional() }),
]);

/** The plane's reasons, in the studio's words where it has better ones. */
const FORK_REASONS: Record<string, string> = {
	'not-installed': 'not installed yet: production data comes from an installed app',
	'several-installs': 'installed several times: pick the install to copy from the dashboard',
	'not-owner': "only the app's owner can copy its production data",
};

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * Build `revision` into a version of the project's vertical — the one deploy call both
 * `/api/release` and Run make. The tenant pin is what proves the slug is this team's: deploy
 * refuses a vertical the pinned workspace does not own.
 */
export async function releaseRevision(
	cp: ControlPlaneCall,
	project: StudioProject & { revision: string },
	tenantId: string,
	version: string | undefined,
): Promise<Response> {
	return await cp(`/verticals/${encodeURIComponent(project.slug)}/deploy`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ version, revision: project.revision, tenant: tenantId }),
	});
}

/**
 * Release the project's revision and bind it to the studio's slot. A refusal from either call
 * is relayed as it came — its sentence is the plane's (a busy build queue, a failed build, a
 * bad manifest), and the studio shows it rather than a red badge with nothing under it.
 *
 * A clean-room create copies nothing, so it never answers the 202 a data copy can (#2450):
 * that one is only for a caller that asks with `async: true`, which this one does not.
 */
export async function runStudioPreview(
	cp: ControlPlaneCall,
	project: StudioProject,
	tenantId: string,
	versionLabel: string,
): Promise<Response> {
	if (!project.revision) return refuse(409, 'save source before running a preview');
	const released = await releaseRevision(cp, { ...project, revision: project.revision }, tenantId, versionLabel);
	if (!released.ok) return released;
	const versionId = releasedVersion.parse(await released.json()).id;
	// Only after the pinned deploy succeeded, so the slug is proven this team's.
	const created = await cp(`/verticals/${encodeURIComponent(project.slug)}/previews`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ tag: STUDIO_PREVIEW_TAG, versionId, empty: true, seed: true }),
	});
	if (!created.ok) return created;
	const ready = createdPreview.parse(await created.json());
	return json(200, {
		state: 'ready',
		url: ready.url,
		versionId: ready.versionId,
		reused: ready.reused,
		...(ready.auth ? { authNote: ready.auth.note } : {}),
	} satisfies StudioPreview);
}

/**
 * The studio's slot as it stands, or `{ state: 'none' }` — what the preview tab opens on. A slot
 * past its TTL is none: the sweep may already have reaped it, and its URL serves nothing.
 */
export async function readStudioPreview(
	cp: ControlPlaneCall,
	project: StudioProject,
	now: Date,
	tag: string = STUDIO_PREVIEW_TAG,
): Promise<Response> {
	const listed = await cp(`/verticals/${encodeURIComponent(project.slug)}/previews`);
	// A project that was never released has no vertical yet: no slot, not an error.
	if (listed.status === 404) return json(200, { state: 'none' });
	if (!listed.ok) return listed;
	const slot = z.array(previewRow).parse(await listed.json()).find((p) => p.tag === tag);
	if (!slot?.url || !slot.versionId) return json(200, { state: 'none' });
	if (slot.expiresAt && Date.parse(slot.expiresAt) <= now.getTime()) return json(200, { state: 'none' });
	return json(200, { state: 'ready', url: slot.url, versionId: slot.versionId, reused: true } satisfies StudioPreview);
}

/**
 * The plane as the signed-in person (#3108): a tenant token for `tenantId` naming `principal`,
 * minted by the plane over the builder's own credential, as the dashboard mints its own. Every
 * call made with it is judged as that person, never as the builder.
 */
export async function personPlane(
	cp: ControlPlaneCall,
	callWith: (token: string) => ControlPlaneCall,
	tenantId: string,
	principal: string,
): Promise<ControlPlaneCall> {
	const res = await cp('/tenant-tokens', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ tenantId, principal }),
	});
	if (!res.ok) throw new Error(`the control plane refused a credential for this person (${res.status})`);
	return callWith(z.object({ token: z.string().min(1) }).parse(await res.json()).token);
}

/** The production-data slot as it stands, and whether Run with production data would be admitted. */
export async function readStudioDataPreview(asPerson: ControlPlaneCall, project: StudioProject, now: Date): Promise<Response> {
	const slot = await readStudioPreview(asPerson, project, now, STUDIO_DATA_PREVIEW_TAG);
	if (!slot.ok) return slot;
	return json(200, { ...((await slot.json()) as object), fork: await forkAvailability(asPerson, project) });
}

async function forkAvailability(asPerson: ControlPlaneCall, project: StudioProject): Promise<ForkAvailability> {
	const res = await asPerson(`/verticals/${encodeURIComponent(project.slug)}/previews/fork-check`);
	// Never released: no vertical yet, so nothing installed to copy.
	if (res.status === 404) return { ok: false, reason: FORK_REASONS['not-installed']! };
	if (!res.ok) return { ok: false, reason: `the control plane could not say (${res.status})` };
	const check = forkCheck.parse(await res.json());
	if (check.ok) return { ok: true };
	return { ok: false, reason: (check.code && FORK_REASONS[check.code]) || check.reason };
}

/**
 * Release the project's revision and fork the installed app's data into the studio's
 * production-data slot, as the signed-in person. The release is the builder's own act, as in
 * `runStudioPreview`; the fork is the person's, so the plane judges them and relays its refusal.
 */
export async function runStudioDataPreview(
	cp: ControlPlaneCall,
	asPerson: ControlPlaneCall,
	project: StudioProject,
	tenantId: string,
	versionLabel: string,
): Promise<Response> {
	if (!project.revision) return refuse(409, 'save source before running a preview');
	const released = await releaseRevision(cp, { ...project, revision: project.revision }, tenantId, versionLabel);
	if (!released.ok) return released;
	const versionId = releasedVersion.parse(await released.json()).id;
	const created = await asPerson(`/verticals/${encodeURIComponent(project.slug)}/previews`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ tag: STUDIO_DATA_PREVIEW_TAG, versionId }),
	});
	if (!created.ok) return created;
	const ready = createdPreview.parse(await created.json());
	return json(200, {
		state: 'ready',
		url: ready.url,
		versionId: ready.versionId,
		reused: ready.reused,
		...(ready.auth ? { authNote: ready.auth.note } : {}),
	} satisfies StudioPreview);
}
