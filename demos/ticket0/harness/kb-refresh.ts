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
import type { Context, Hono } from 'hono';
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
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
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
 * The header a refresh hook presents.
 *
 * Its own header rather than `Authorization: Bearer`, and that is deliberate: the same
 * route also serves a signed-in person pressing Re-read, whose bearer token is an OIDC
 * one. Two credentials that mean entirely different things must not arrive in the same
 * envelope and be told apart by sniffing a prefix — the header IS the statement about
 * which door this request is knocking on.
 */
export const KB_REFRESH_TOKEN_HEADER = 'x-kb-refresh-token';

/** Resolve the desk's `ingest` service, or null before this desk has been reconciled. */
export type ResolveHookTarget = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any, any, any>,
) => Promise<IngestTarget | null>;

/**
 * `POST /api/kb/sources/:sourceId/refresh` → `{ added, updated, unchanged }`.
 *
 * TWO doors, one route, and which one a request took is decided by whether it carries
 * `KB_REFRESH_TOKEN_HEADER` — never by falling back from one to the other. A request
 * with a token that is wrong is refused as a hook; it does not then get to try being a
 * person, which would turn a bad token into a 401 asking for a login.
 *
 *   - **No token** — the Re-read button. Runs as the caller, who holds `kb:refresh`
 *     because they are a desk-admin, and 401s if nobody.
 *   - **A token** — a docs pipeline. Runs as the desk's `ingest` service, which holds
 *     `kb:refresh` and nothing else, and only after `redeem-kb-refresh-token` has said
 *     this token belongs to THIS source and has not read too recently.
 *
 * A read that fails answers **502** with the reason — the source's site failed, not
 * this request — and the row already says the same, so a client that re-reads the
 * list after either answer shows the truth. A refusal from the redeem step keeps its
 * own status (403 for a bad token, 429 for one firing too fast), because those are
 * facts about the REQUEST rather than about the docs site.
 *
 * `fetchImpl` is for tests; nothing else should pass it.
 */
export function mountKbRefresh(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  resolveHookTarget?: ResolveHookTarget,
): void {
  app.post('/api/kb/sources/:sourceId/refresh', async (c) => {
    const sourceId = c.req.param('sourceId');
    const token = c.req.header(KB_REFRESH_TOKEN_HEADER);

    let target: IngestTarget;
    if (token === undefined) {
      const scope = await resolveStub(c);
      target = { invoke: (op, input) => scope.invoke(op, input) as Promise<never> };
    } else {
      // Null means this desk has not been reconciled onto a version that mints the
      // ingest principal (#1172). Refused with a reason rather than served by borrowing
      // a principal that holds more than a hook is allowed to.
      const hook = resolveHookTarget ? await resolveHookTarget(c) : null;
      if (!hook) {
        // The remedy has to be one that MINTS the principal, and pressing Re-read is
        // not: that path runs as the caller's own stub and provisions nothing. Only
        // reconciliation fills a missing service (`mintServices`, #1172), and what
        // triggers it is the scope's serving version changing — a push. Locally, the
        // cast file is the state to clear.
        throw new HTTPException(503, {
          message:
            'this desk has no refresh-hook service yet — push a new version so the platform reconciles the scope and mints it (locally: delete .data/ and restart to re-seed)',
        });
      }
      // Outside the try below on purpose: a refused hook is not a failed READ, and
      // recording it on the source row would blame the docs site for a bad token.
      await hook.invoke('ticket0/redeem-kb-refresh-token', { sourceId, token });
      target = hook;
    }

    try {
      return c.json(await readSource(target, sourceId, fetchImpl));
    } catch (err) {
      if (err instanceof KbReadError) throw new HTTPException(502, { message: err.message, cause: err });
      throw err;
    }
  });
}
