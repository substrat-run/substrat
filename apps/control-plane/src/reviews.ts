import { Hono } from 'hono';
import type { PlatformActorId, TenantId } from '@substrat-run/contracts';
import { refuse, refuseStatus } from './problem.js';
import { listReviews, readReview, receiveReview, ReviewCollisionError, ReviewValidationError, type ReviewReader, type ReviewRecord } from './review-store.js';

const INTAKE_BODY_MAX = 2 * 32 * 1024 * 1024 + 1024 * 1024;
const MAX_LIVE_REVIEWS_PER_ACTOR = 20;
/**
 * A builder's reviews are read by a model the platform pays for and meters to the tenant. Two
 * bounds, shared by all of a workspace's members: reviews still being read (`received`) at once,
 * so a workspace is never queued behind itself, and reviews kept in the 30-day retention, which
 * caps what one workspace can spend in that window. Both stay under one listing page (100), so
 * the count is read off the first page. Staff keep their own per-person limit above.
 */
export const MAX_REVIEWS_IN_PROGRESS_PER_TENANT = 5;
export const MAX_KEPT_REVIEWS_PER_TENANT = 50;
/**
 * What makes the runner available to a builder's tenant (hosted-review-runner.md Q2): a key only
 * staff grant (`PLATFORM_ENTITLEMENT_KEYS`, so no vertical can declare it and no tenant grant
 * itself it, #2388). Without it a builder still reads its tenant's reviews; it starts none.
 */
export const REVIEW_ENTITLEMENT = 'review';
/** One upload at a time per staff person, and per builder tenant. */
const intakeInFlight = new Set<string>();

/** The staff person, or the builder acting for one tenant, a review request is made by. */
type ReviewPrincipal =
  | { kind: 'staff'; actor: PlatformActorId }
  | { kind: 'builder'; actor: PlatformActorId; tenantId: TenantId; tenantSlug: string };

const readerFor = (p: ReviewPrincipal): ReviewReader => (p.kind === 'staff' ? p.actor : { tenantId: p.tenantId });

/** A builder reads its tenant's reviews without the actor ids of the members who started them. */
const viewFor = (p: ReviewPrincipal, record: ReviewRecord): Omit<ReviewRecord, 'actor'> | ReviewRecord => {
  if (p.kind === 'staff') return record;
  const { actor: _actor, ...view } = record;
  return view;
};

async function boundedForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data;')) throw new Error('multipart review upload is required');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > INTAKE_BODY_MAX) throw new Error('review upload exceeds the request size limit');
  if (!request.body) throw new Error('review upload has no body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > INTAKE_BODY_MAX) throw new Error('review upload exceeds the request size limit');
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new Response(new Blob(chunks), { headers: { 'content-type': contentType } }).formData();
}

/**
 * The review API: intake, then the reader half (phase 1). Staff are read first, by the worker's
 * human staff reader; a builder only when that declines, and only for a vertical its tenant owns.
 */
export function createReviewApi(deps: {
  bucket: () => R2Bucket | undefined;
  authenticate: (request: Request) => Promise<PlatformActorId | null>;
  /** A builder's session narrowed to one tenant, or null. Absent: staff only. */
  authenticateBuilder?: (request: Request) => Promise<{ actor: PlatformActorId; tenantId: TenantId; tenantSlug: string } | null>;
  /** The registry's owner of a vertical id; undefined when none is registered. Required with `authenticateBuilder`. */
  ownerOf?: (actor: PlatformActorId, slug: string) => Promise<TenantId | null | undefined>;
  /** Whether a tenant holds an unexpired `review` entitlement. Required with `authenticateBuilder`. */
  entitled?: (tenantId: TenantId) => Promise<boolean>;
  /** Starts the reader half for a stored review. The upload never waits for the review itself. */
  startReview?: (id: string) => Promise<void>;
}): Hono {
  const app = new Hono();
  type Access = { bucket: R2Bucket; principal: ReviewPrincipal };
  const authenticate = async (request: Request): Promise<ReviewPrincipal | null> => {
    const actor = await deps.authenticate(request);
    if (actor) return { kind: 'staff', actor };
    const builder = deps.ownerOf ? await deps.authenticateBuilder?.(request) : null;
    return builder ? { kind: 'builder', ...builder } : null;
  };
  const gate = async (request: Request): Promise<Access | Response> => {
    const principal = await authenticate(request);
    if (!principal) return refuse('unauthenticated', 'a staff or builder sign-in is required');
    const bucket = deps.bucket();
    if (!bucket) return refuseStatus(501, 'review source storage is not configured');
    return { bucket, principal };
  };
  app.post('/reviews', async (c) => {
    const access = await gate(c.req.raw);
    if (access instanceof Response) return access;
    const p = access.principal;
    if (p.kind === 'builder' && !(await deps.entitled?.(p.tenantId))) {
      return refuse('forbidden', `code reviews are not enabled for this workspace: staff grant the \`${REVIEW_ENTITLEMENT}\` entitlement`);
    }
    const intakeKey = p.kind === 'staff' ? `actor:${p.actor}` : `tenant:${p.tenantId}`;
    if (intakeInFlight.has(intakeKey)) {
      return refuseStatus(429, `a review upload is already in progress for this ${p.kind === 'staff' ? 'person' : 'workspace'}`);
    }
    intakeInFlight.add(intakeKey);
    try {
      const live = await listReviews(access.bucket, readerFor(p));
      if (p.kind === 'staff' && live.entries.length >= MAX_LIVE_REVIEWS_PER_ACTOR) {
        return refuseStatus(429, 'review intake limit reached: 20 live reviews per person');
      }
      if (p.kind === 'builder') {
        if (live.entries.filter((r) => r.state === 'received').length >= MAX_REVIEWS_IN_PROGRESS_PER_TENANT) {
          return refuseStatus(429, `review intake limit reached: ${MAX_REVIEWS_IN_PROGRESS_PER_TENANT} reviews in progress per workspace; start another when one finishes`);
        }
        if (live.entries.length >= MAX_KEPT_REVIEWS_PER_TENANT) {
          return refuseStatus(429, `review intake limit reached: ${MAX_KEPT_REVIEWS_PER_TENANT} reviews per workspace in 30 days`);
        }
      }
      return await receive(c.req.raw, access);
    } finally {
      intakeInFlight.delete(intakeKey);
    }
  });
  const receive = async (request: Request, access: Access): Promise<Response> => {
    let form: FormData;
    try {
      form = await boundedForm(request);
    } catch (error) {
      return refuse('validation_failed', error instanceof Error ? error.message : 'invalid upload');
    }
    if ([...form.keys()].some((key) => !['source', 'sourceSha256', 'base', 'baseSha256', 'slug'].includes(key)) ||
        ['source', 'sourceSha256'].some((key) => form.getAll(key).length !== 1) ||
        ['base', 'baseSha256', 'slug'].some((key) => form.getAll(key).length > 1)) {
      return refuse('validation_failed', 'review upload has duplicate or unknown parts');
    }
    const source = form.get('source');
    const base = form.get('base');
    const sourceSha256 = form.get('sourceSha256');
    const baseSha256 = form.get('baseSha256');
    if (!(source instanceof File) || typeof sourceSha256 !== 'string' ||
        (base !== null && !(base instanceof File)) ||
        (baseSha256 !== null && typeof baseSha256 !== 'string')) {
      return refuse('validation_failed', 'source archive and SHA-256 are required');
    }
    const p = access.principal;
    let tenant: { tenantId: TenantId; vertical: string } | undefined;
    if (p.kind === 'builder') {
      // A staff review names no vertical (a `slug` sent anyway is not recorded); a builder's must.
      const raw = form.get('slug');
      if (typeof raw !== 'string' || raw.trim() === '') return refuse('validation_failed', 'name the vertical the review is for (slug)');
      // The bare slug is formed into the tenant's namespace the way every builder route forms it.
      const vertical = raw.startsWith(`${p.tenantSlug}/`) ? raw : `${p.tenantSlug}/${raw}`;
      if ((await deps.ownerOf!(p.actor, vertical)) !== p.tenantId) {
        return refuse('forbidden', 'the vertical is not one this workspace owns');
      }
      tenant = { tenantId: p.tenantId, vertical };
    }
    try {
      const record = await receiveReview(access.bucket, p.actor, {
        source, sourceSha256,
        ...(base instanceof File ? { base } : {}),
        ...(typeof baseSha256 === 'string' ? { baseSha256 } : {}),
        ...(tenant ? { tenant } : {}),
      });
      if (deps.startReview) {
        // Stored is stored: a job that fails to start leaves the review `received`, which the
        // record says, and the upload still answers 201.
        await deps.startReview(record.id).catch((error: unknown) => {
          console.error('review.job.unstarted', { reviewId: record.id, message: error instanceof Error ? error.message : String(error) });
        });
      }
      return Response.json(viewFor(p, record), { status: 201 });
    } catch (error) {
      if (error instanceof ReviewValidationError) return refuse('validation_failed', error.message);
      if (error instanceof ReviewCollisionError) return refuseStatus(409, error.message);
      throw error;
    }
  };
  app.get('/reviews', async (c) => {
    const access = await gate(c.req.raw);
    if (access instanceof Response) return access;
    const page = await listReviews(access.bucket, readerFor(access.principal), c.req.query('cursor'));
    return c.json({ ...page, entries: page.entries.map((record) => viewFor(access.principal, record)) });
  });
  app.get('/reviews/:id', async (c) => {
    const access = await gate(c.req.raw);
    if (access instanceof Response) return access;
    const record = await readReview(access.bucket, readerFor(access.principal), c.req.param('id'));
    return record ? c.json(viewFor(access.principal, record)) : refuse('not_found', 'not found');
  });
  return app;
}
