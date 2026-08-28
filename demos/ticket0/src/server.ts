/**
 * The boot harness — node-only imports live HERE and never in module code.
 *
 * It serves three things:
 *
 *   1. `/api/*` — the staff and portal surface, behind an ordinary OIDC login.
 *   2. `/widget/*` — the PUBLIC widget surface: unauthenticated, CORS'd, running as
 *      each desk's own widget service. Mounted from `harness/widget-surface.ts`, which
 *      `src/worker.ts` mounts too — it is the piece `vertical-host` does not have yet,
 *      so this vertical's two hosts share one copy rather than keeping one each.
 *   3. Two fake customer websites on their own ports, so the widget's calls are
 *      genuinely cross-origin rather than same-origin against their own API.
 *
 * It also runs the two connector-shaped jobs: fetching the knowledge base, and
 * answering customer messages with a model. Both live out here because module code has
 * no network, and both re-enter through ordinary operations.
 */
import { serve } from '@hono/node-server';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { platformActorId } from '@substrat-run/contracts';
import { devLogin } from '@substrat-run/dev-issuer';
import type { ScopeHost } from '@substrat-run/kernel';
import { API_DOCUMENT } from './api.js';
import {
  answerConversation,
  errorText,
  modelFromEnv,
  recordAssistantFailure,
} from '../harness/assistant.js';
import { mountAssistantStatus } from '../harness/assistant-status.js';
import { mountKbRefresh, readSource } from '../harness/kb-refresh.js';
import { buildHost, linkDevPersonas, seed, type Desk, type World } from './seed.js';
import { DEV_PROVIDER } from './personas.js';
import { mountApi } from './routes.js';
import { startDemoSites } from '../harness/demo-site.js';
import { mountWidgetSurface } from '../harness/widget-surface.js';

/**
 * Local secrets, if there are any.
 *
 * `demos/ticket0/.env` is gitignored and optional — without it the assistant falls
 * back to quoting the docs, which is why this is a `try` rather than a requirement.
 * Node's own loader, so no dependency and no parser of ours to get wrong.
 */
try {
  process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
} catch {
  /* no .env — the offline model handles it */
}

const DATA = process.env.DATA_DIR ?? '.data';
const CAST = join(DATA, 'cast.json');
const WIDGET_JS = new URL('../widget/widget.js', import.meta.url);

async function boot() {
  mkdirSync(DATA, { recursive: true });
  const host = buildHost(DATA);

  let world: World;
  if (existsSync(CAST)) {
    world = JSON.parse(readFileSync(CAST, 'utf8')) as World;
  } else {
    world = await seed(host);
    writeFileSync(CAST, JSON.stringify(world, null, 2));
  }

  // Re-branded on the way in: everything loaded from JSON crossed a serialization
  // boundary, so `world.staff` is a plain string until parsed.
  const staff = platformActorId.parse(world.staff);
  await linkDevPersonas(host, { ...world, staff });

  const port = Number(process.env.PORT ?? 8874);
  const apiOrigin = process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;
  const desks: Desk[] = [world.substrat, world.kestrel];
  const model = modelFromEnv(process.env);

  const app = new Hono();
  const login = devLogin({ directory: host.admin, actor: staff, provider: DEV_PROVIDER });

  // ── The staff and portal surface ─────────────────────────────────────────
  app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

  app.get('/api/me', async (c) => {
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ principal: caller.principal, display: caller.display });
  });

  app.get('/openapi.json', (c) => c.json(API_DOCUMENT));

  const staffStub = async (c: Context) => {
    const caller = await login.caller(c.req.raw.headers);
    if (!caller) throw new HTTPException(401, { message: 'unauthorized' });
    return host.getScope(caller.principal, caller.tenantId, caller.scopeId);
  };
  mountApi(app, staffStub);
  // "Re-read" and "Add a source" in the desk — the same route the worker mounts.
  mountKbRefresh(app, staffStub);
  // Settings → Assistant: the model this process would answer with, beside the failed
  // turns. One model for both desks here, since one process serves both.
  mountAssistantStatus(app, staffStub, () => model);

  // ── The public widget surface ────────────────────────────────────────────
  const widgetJs = readFileSync(WIDGET_JS, 'utf8');
  app.get('/widget.js', (c) =>
    c.body(widgetJs, 200, {
      'content-type': 'application/javascript; charset=utf-8',
      // The script itself is public — it is meant to be loaded by any page. What is
      // NOT public is the API behind it, which checks the embedding allowlist.
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=60',
    }),
  );

  const deskByOrigin = (origin: string): Desk | undefined =>
    desks.find((d) => d.origin === origin || d.devOrigins.includes(origin));

  mountWidgetSurface(app, {
    /**
     * One node, many desks — so here the EMBEDDING ORIGIN picks the desk. That is a
     * dev-server fact: a hosted install has one desk per hostname and the router
     * asserts it, which is what `src/worker.ts` resolves from instead.
     */
    resolveDesk: async (_c, origin) => {
      const desk = deskByOrigin(origin);
      if (!desk) return null;
      // Every widget call runs as this desk's widget service, which holds exactly one
      // key. The visitor has no principal and needs none.
      const stub = await host.getScope(desk.widget.principal, desk.tenant, desk.scope);
      const invoke = <T,>(op: string, input: unknown) => stub.invoke(op, input) as Promise<T>;
      /**
       * The union is deliberate: the seeded origins are a ROUTING fact (which desk
       * owns which host — in production the router's job), while the desk's own list
       * is the authorization fact, read live through the desk's own widget service.
       * Letting a removed origin past CORS means the operation gets to refuse it with
       * a sentence somebody can read, rather than the browser swallowing it.
       */
      const declared = await invoke<{ origins: string[] }>('ticket0/widget-origins', {});
      return {
        invoke,
        allowedOrigins: [...new Set([desk.origin, ...desk.devOrigins, ...declared.origins])],
      };
    },
    onCustomerMessage: (_c, { origin, conversationId, messageId, body }) => {
      const desk = deskByOrigin(origin);
      if (!desk) return;
      // Not awaited: the model is somebody else's latency, and the widget polls. Safe
      // to float HERE and nowhere else — node keeps the process alive; the worker has
      // to hand the same promise to `executionCtx.waitUntil`.
      void answerFor(host, desk, { conversationId, messageId, body });
    },
  });

  // ── Go ────────────────────────────────────────────────────────────────────
  serve({ fetch: app.fetch, port });
  process.stdout.write(`\nticket0 api on :${port} — auth: OIDC · ${login.issuer}\n`);
  process.stdout.write(`assistant model: ${model.label}\n`);
  if (model.label.startsWith('offline/')) {
    process.stdout.write(
      '  (set CF_ACCOUNT_ID and CF_AI_TOKEN for Cloudflare Workers AI;\n' +
        '   without them the assistant quotes the docs rather than generating)\n',
    );
  }
  /**
   * One stand-in site, and it is Substrat's.
   *
   * It exists so the widget can be seen working without starting a second project —
   * same desk, same `llms-full.txt` knowledge base, same assistant that answers. The
   * scenery is invented; nothing behind it is.
   *
   * Kestrel has no page. Watching an assistant decline to answer is a negative worth
   * asserting in a test and worth seeing in the inbox as a draft awaiting a human, and
   * it was not worth a second marketing site to stare at.
   */
  process.stdout.write('demo customer site:\n');
  startDemoSites(
    [
      {
        port: 5279,
        brand: 'Substrat',
        tagline: 'The hard parts, hosted.',
        accent: '#4f46e5',
        note:
          'A stand-in for a customer\u2019s marketing site \u2014 the only real thing on this ' +
          'page is the chat bubble. Ask it about migrations, permissions, scopes or ' +
          'deploying: it answers out of the real Substrat documentation and cites the ' +
          'section it drew from.',
      },
    ],
    apiOrigin,
  );
  process.stdout.write(
    '  \u2026and the same desk rides the REAL docs site:\n' +
      '    TICKET0_WIDGET=1 pnpm --filter @substrat-run/docs dev   \u2192 http://localhost:5173\n',
  );

  // ── The connector-shaped jobs ─────────────────────────────────────────────
  // Runs on every boot: a desk whose source failed last time would otherwise never
  // try again, and the ingest is idempotent on content hash, so a re-read of an
  // unchanged corpus writes nothing.
  if (process.env.TICKET0_SKIP_INGEST !== '1') {
    process.stdout.write('\ningesting knowledge bases…\n');
    for (const desk of desks) void ingestFor(host, desk);
  }
}

/** Fetch and record one desk's documentation, out of band. */
async function ingestFor(host: ScopeHost, desk: Desk): Promise<void> {
  const admin = await host.getScope(desk.admin.principal, desk.tenant, desk.scope);
  const sources = (await admin.invoke('ticket0/list-kb-sources', {})) as {
    entries: { id: string; kind: 'llms-txt' | 'sitemap' | 'markdown'; url: string; label: string }[];
  };
  for (const source of sources.entries) {
    try {
      const result = await readSource(admin, source.id);
      process.stdout.write(
        `  ${source.label}: +${result.added} new, ${result.updated} changed, ${result.unchanged} unchanged\n`,
      );
    } catch (err) {
      // Already recorded on the source as `failed` with this reason, so the desk shows
      // it on the row; this line is the boot log's copy.
      process.stdout.write(
        `  ${source.label}: FAILED — ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/** Answer one customer message as the desk's assistant, out of band. */
async function answerFor(
  host: ScopeHost,
  desk: Desk,
  m: { conversationId: string; messageId: string; body: string },
): Promise<void> {
  try {
    const assistant = await host.getScope(desk.assistant.principal, desk.tenant, desk.scope);
    const outcome = await answerConversation(
      { invoke: (op, input) => assistant.invoke(op, input) as Promise<never> },
      { conversationId: m.conversationId, messageId: m.messageId, question: m.body },
      modelFromEnv(process.env),
    );
    process.stdout.write(
      `assistant · ${desk.origin} · ${outcome.outcome}` +
        ` · ${outcome.citations} citation(s)` +
        (outcome.detail ? ` · ${outcome.detail}` : '') +
        '\n',
    );
  } catch (err) {
    process.stdout.write(`assistant · ${desk.origin} · errored — ${errorText(err)}\n`);
    // The same last resort the worker has: the widget records the failure on the
    // conversation, so the desk shows it and not only this console. Here it is
    // mostly a rehearsal — the dev server's stdout is right in front of you — but
    // the two hosts should fail the same way, or only one of them is tested.
    try {
      const widget = await host.getScope(desk.widget.principal, desk.tenant, desk.scope);
      await recordAssistantFailure(
        { invoke: (op, input) => widget.invoke(op, input) as Promise<never> },
        {
          conversationId: m.conversationId,
          messageId: m.messageId,
          model: modelFromEnv(process.env).label,
          error: err,
        },
      );
    } catch (recordErr) {
      process.stdout.write(
        `assistant · ${desk.origin} · could not record the failure either — ${errorText(recordErr)}\n`,
      );
    }
  }
}

void boot();
