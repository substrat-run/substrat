/**
 * Re-reading one documentation source — the connector-shaped job, as a request.
 *
 * `ticket0/ingest-kb-source` records the intent and emits; module code may not fetch,
 * so the fetch happens out here and re-enters through `ticket0/record-kb-articles` —
 * or, when it fails, through `ticket0/record-kb-ingest-failure`. Both hosts mount the
 * same route, so "Re-read" in the desk does the same thing against the dev server and
 * against a worker, which has no cron to run the read on and no boot to run it at.
 *
 * Not in the model, deliberately: the model declares operations, and reading a docs
 * site is not one. It runs as the CALLER — `kb:manage` is what authorises it, the
 * operations either end refuse anyone else, and nothing here can widen that.
 */
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ResolveStub } from '@substrat-run/vertical-host';
import { runIngest, type IngestTarget } from './kb-ingest.js';

/** A read that got as far as the source and failed there — recorded on the row before it is thrown. */
export class KbReadError extends Error {
  constructor(
    readonly sourceId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'KbReadError';
  }
}

/**
 * Read one source end to end, and leave the row telling the truth either way.
 *
 * Marks it `ingesting` through the operation (so the desk sees the read in flight),
 * fetches, records the articles — and on failure records THAT, then throws. Before
 * this a failed read left the source at `ingesting` for good: `runIngest` threw,
 * nothing wrote `failed`, and the only trace was a line on the dev server's stdout.
 *
 * A refusal from `ingest-kb-source` itself — no such source, no `kb:manage` — is not a
 * read failure and passes through untouched, so it keeps its 404 or 403.
 */
export async function readSource(
  admin: IngestTarget,
  sourceId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ added: number; updated: number; unchanged: number }> {
  const source = await admin.invoke<{ id: string; kind: 'llms-txt' | 'sitemap' | 'markdown'; url: string }>(
    'ticket0/ingest-kb-source',
    { sourceId },
  );
  try {
    return await runIngest(admin, source, fetchImpl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin.invoke('ticket0/record-kb-ingest-failure', { sourceId, error: message });
    throw new KbReadError(sourceId, message, { cause: err });
  }
}

/**
 * `POST /api/kb/sources/:sourceId/refresh` → `{ added, updated, unchanged }`.
 *
 * A read that fails answers **502** with the reason — the source's site failed, not
 * this request — and the row already says the same, so a client that re-reads the
 * list after either answer shows the truth. `fetchImpl` is for tests; nothing else
 * should pass it.
 */
export function mountKbRefresh(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
  fetchImpl: typeof fetch = fetch,
): void {
  app.post('/api/kb/sources/:sourceId/refresh', async (c) => {
    const scope = await resolveStub(c);
    const target: IngestTarget = { invoke: (op, input) => scope.invoke(op, input) as Promise<never> };
    try {
      return c.json(await readSource(target, c.req.param('sourceId'), fetchImpl));
    } catch (err) {
      if (err instanceof KbReadError) throw new HTTPException(502, { message: err.message, cause: err });
      throw err;
    }
  });
}
