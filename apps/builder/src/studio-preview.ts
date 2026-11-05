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
 * Not a PR either: a per-PR preview is a GitHub Actions flow and exists only for GitHub
 * projects. That stays the separate "Create preview PR" step.
 */
import { z } from 'zod';
import { refuse } from './problem.js';

/** The one tag the studio's slot lives under — never a `pr-<n>`, which CI owns. */
export const STUDIO_PREVIEW_TAG = 'studio';

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
		body: JSON.stringify({ tag: STUDIO_PREVIEW_TAG, versionId, empty: true }),
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
export async function readStudioPreview(cp: ControlPlaneCall, project: StudioProject, now: Date): Promise<Response> {
	const listed = await cp(`/verticals/${encodeURIComponent(project.slug)}/previews`);
	// A project that was never released has no vertical yet: no slot, not an error.
	if (listed.status === 404) return json(200, { state: 'none' });
	if (!listed.ok) return listed;
	const slot = z.array(previewRow).parse(await listed.json()).find((p) => p.tag === STUDIO_PREVIEW_TAG);
	if (!slot?.url || !slot.versionId) return json(200, { state: 'none' });
	if (slot.expiresAt && Date.parse(slot.expiresAt) <= now.getTime()) return json(200, { state: 'none' });
	return json(200, { state: 'ready', url: slot.url, versionId: slot.versionId, reused: true } satisfies StudioPreview);
}
