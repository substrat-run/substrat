import { Hono } from 'hono';
import type { PlatformActorId } from '@substrat-run/contracts';
import { refuse, refuseStatus } from './problem.js';
import { listReviews, readReview, receiveReview, ReviewCollisionError, ReviewValidationError } from './review-store.js';

const INTAKE_BODY_MAX = 2 * 32 * 1024 * 1024 + 1024 * 1024;
const MAX_LIVE_REVIEWS_PER_ACTOR = 20;
const intakeActors = new Set<PlatformActorId>();

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

/** The phase-0 review API. Authentication is supplied by the worker's human staff reader. */
export function createReviewApi(deps: {
  bucket: () => R2Bucket | undefined;
  authenticate: (request: Request) => Promise<PlatformActorId | null>;
}): Hono {
  const app = new Hono();
  const gate = async (request: Request): Promise<{ bucket: R2Bucket; actor: PlatformActorId } | Response> => {
    const actor = await deps.authenticate(request);
    if (!actor) return refuse('unauthenticated', 'a staff sign-in is required');
    const bucket = deps.bucket();
    if (!bucket) return refuseStatus(501, 'review source storage is not configured');
    return { bucket, actor };
  };
  app.post('/reviews', async (c) => {
    const access = await gate(c.req.raw);
    if (access instanceof Response) return access;
    if (intakeActors.has(access.actor)) return refuseStatus(429, 'a review upload is already in progress for this person');
    intakeActors.add(access.actor);
    try {
      const live = await listReviews(access.bucket, access.actor);
      if (live.entries.length >= MAX_LIVE_REVIEWS_PER_ACTOR) {
        return refuseStatus(429, 'review intake limit reached: 20 live reviews per person');
      }
      return await receive(c.req.raw, access);
    } finally {
      intakeActors.delete(access.actor);
    }
  });
  const receive = async (request: Request, access: { bucket: R2Bucket; actor: PlatformActorId }): Promise<Response> => {
    let form: FormData;
    try {
      form = await boundedForm(request);
    } catch (error) {
      return refuse('validation_failed', error instanceof Error ? error.message : 'invalid upload');
    }
    if ([...form.keys()].some((key) => !['source', 'sourceSha256', 'base', 'baseSha256'].includes(key)) ||
        ['source', 'sourceSha256'].some((key) => form.getAll(key).length !== 1) ||
        ['base', 'baseSha256'].some((key) => form.getAll(key).length > 1)) {
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
    try {
      const record = await receiveReview(access.bucket, access.actor, {
        source, sourceSha256,
        ...(base instanceof File ? { base } : {}),
        ...(typeof baseSha256 === 'string' ? { baseSha256 } : {}),
      });
      return Response.json(record, { status: 201 });
    } catch (error) {
      if (error instanceof ReviewValidationError) return refuse('validation_failed', error.message);
      if (error instanceof ReviewCollisionError) return refuseStatus(409, error.message);
      throw error;
    }
  };
  app.get('/reviews', async (c) => {
    const access = await gate(c.req.raw);
    if (access instanceof Response) return access;
    return c.json(await listReviews(access.bucket, access.actor, c.req.query('cursor')));
  });
  app.get('/reviews/:id', async (c) => {
    const access = await gate(c.req.raw);
    if (access instanceof Response) return access;
    const record = await readReview(access.bucket, access.actor, c.req.param('id'));
    return record ? c.json(record) : refuse('not_found', 'not found');
  });
  return app;
}
