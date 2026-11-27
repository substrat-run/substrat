import type { Hono } from 'hono';
import { modelAttribution, modelUsageLine, scopeId, tenantId, type ModelAttribution, type ModelUsageLine } from '@substrat-run/contracts';
import { listCostOfSteps, requestHeadersFor } from '@substrat-run/model-providers';
import { signEphemeral, verifyEphemeral, type OidcEnv } from '@substrat-run/oidc-rp';
import { refuse, refuseStatus } from './problem.js';

/**
 * Workers AI for `substrat dev` (#3420): a developer's local app calls real models through the
 * control plane, on the strength of their `substrat login`, and never holds a Cloudflare
 * credential or the login itself.
 *
 *   substrat dev ─▶ POST /api/model-access              (CLI session + workspace header)
 *                ◀─ { token, expiresAt, tenant }         (15 minutes, one workspace, models only)
 *   local relay  ─▶ POST /api/model-access/<tenant>/v1/chat/completions   (Bearer <token>)
 *                ─▶ Workers AI, over this plane's own gateway keys
 *
 * The CLI keeps the session and the token in its own process and hands the app a loopback relay
 * (packages/cli/src/model-relay.ts); this file is the server half, and holds every check.
 *
 * The token is a JWT under the session key with NO `sub`. That is load-bearing: `verifySession`
 * accepts any token under that key carrying `sub` and `exp`, so a model token with a subject
 * would also be a full session. Without one it is refused there, and a session (which has no
 * `purpose`) is refused here.
 */

/** How long a model token lives. The CLI re-asks before it runs out. */
export const MODEL_ACCESS_TTL_SEC = 15 * 60;

/** The `purpose` claim that makes a JWT under the session key a model token and nothing else. */
const PURPOSE = 'model-access';

/**
 * The scope every dev call is filed under on the workspace's model usage ledger: no scope made
 * the call (a local app has none the platform knows), and a sentinel keeps dev usage apart from
 * a deployed vertical's, as the review runner's does.
 */
export const DEV_MODEL_SCOPE = scopeId.parse('01JZ0000000000000000DEV001');
/** The `version` a dev call is attributed with: the local tree, never a pushed version. */
export const DEV_MODEL_VERSION = 'substrat-dev';
const DEV_MODEL_VERTICAL = 'substrat-dev';
const DEV_MODEL_OPERATION = 'dev';

/** Above this, a request is refused rather than run: a local loop should not buy a novel. */
export const MODEL_ACCESS_MAX_OUTPUT_TOKENS = 8192;

/** The largest request body forwarded. A long conversation fits; a pasted archive does not. */
export const MODEL_ACCESS_MAX_BODY_BYTES = 1024 * 1024;

/** Who may hold a model token: a builder signed in for one workspace. */
export interface ModelAccessMember {
  readonly actor: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
}

export interface ModelAccessDeps<B> {
  /** The signed-in person narrowed to one workspace (the builder reader), or null. */
  readonly member: (env: B, request: Request) => Promise<ModelAccessMember | null>;
  /** The plane's gateway keys, or null when this deployment offers no model access. */
  readonly gateway: (env: B) => { CLOUDFLARE_AI_BASE_URL: string; CLOUDFLARE_AI_API_TOKEN: string; CLOUDFLARE_AI_GATEWAY_ID?: string } | null;
  /** The ledger write. A failure is logged; the answer has already gone back. */
  readonly record: (env: B, input: { requestId: string; line: ModelUsageLine }) => Promise<unknown>;
  /**
   * Defers the ledger write past the response. Default: the request's `waitUntil`, and where a
   * runtime has none, the write is awaited before answering.
   */
  readonly defer?: (promise: Promise<unknown>) => void;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly now?: () => Date;
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

interface ModelToken {
  readonly tenant: string;
  readonly actor: string;
}

async function readToken(env: OidcEnv, request: Request): Promise<ModelToken | null> {
  const header = request.headers.get('authorization') ?? '';
  if (!/^bearer /i.test(header)) return null;
  const payload = await verifyEphemeral(env, header.slice(7).trim());
  if (!payload || payload['purpose'] !== PURPOSE || payload['sub'] !== undefined) return null;
  const tenant = payload['tenant'];
  const actor = payload['actor'];
  return typeof tenant === 'string' && typeof actor === 'string' ? { tenant, actor } : null;
}

/** A label the caller offered, kept only when it is a short plain string. */
function label(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/.test(value) ? value : fallback;
}

/**
 * The attribution a dev call is filed with. The workspace and scope are the server's, always;
 * the vertical and operation are what the local model host sent in `cf-aig-metadata`, kept as
 * labels, since they name the caller's own code inside the caller's own workspace.
 */
export function devAttribution(tenant: string, sent: string | null): ModelAttribution {
  let offered: Record<string, unknown> = {};
  try {
    const parsed: unknown = sent ? JSON.parse(sent) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) offered = parsed as Record<string, unknown>;
  } catch {
    /* an unreadable label is no label */
  }
  return modelAttribution.parse({
    tenant: tenantId.parse(tenant),
    scope: DEV_MODEL_SCOPE,
    vertical: label(offered['vertical'], DEV_MODEL_VERTICAL),
    version: DEV_MODEL_VERSION,
    operation: label(offered['operation'], DEV_MODEL_OPERATION),
  });
}

interface UpstreamUsage {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly prompt_tokens_details?: { readonly cached_tokens?: unknown } | null;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

/** The usage the last server-sent event carrying one reported, from a streamed answer. */
export async function streamedUsage(body: ReadableStream<Uint8Array>): Promise<UpstreamUsage | null> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = '';
  let usage: UpstreamUsage | null = null;
  const take = (line: string) => {
    const data = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!data || data === '[DONE]') return;
    try {
      const event = JSON.parse(data) as { usage?: UpstreamUsage | null };
      if (event.usage) usage = event.usage;
    } catch {
      /* not every event is ours to read */
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      take(buffered.slice(0, newline).trim());
      buffered = buffered.slice(newline + 1);
    }
  }
  take(buffered.trim());
  return usage;
}

/** One ledger line for one dev call, priced from the rate card on our side. */
export function devUsageLine(input: {
  attribution: ModelAttribution;
  modelId: string;
  usage: UpstreamUsage | null;
  started: Date;
  finished: Date;
}): ModelUsageLine {
  const model = `cloudflare:${input.modelId}`;
  const reported = input.usage !== null && (typeof input.usage.prompt_tokens === 'number' || typeof input.usage.completion_tokens === 'number');
  const inputTokens = count(input.usage?.prompt_tokens);
  const outputTokens = count(input.usage?.completion_tokens);
  const cachedInputTokens = Math.min(count(input.usage?.prompt_tokens_details?.cached_tokens), inputTokens);
  return modelUsageLine.parse({
    attribution: input.attribution,
    model,
    provider: 'cloudflare',
    modelId: input.modelId,
    reported,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens: 0,
    listUsd: reported ? listCostOfSteps(model, [{ inputTokens, outputTokens, cachedInputTokens }]) : null,
    at: input.finished.toISOString(),
    elapsedMs: Math.max(0, input.finished.getTime() - input.started.getTime()),
  });
}

export function mountModelAccessRoutes<B extends OidcEnv>(app: Hono<{ Bindings: B }>, deps: ModelAccessDeps<B>): void {
  const now = deps.now ?? (() => new Date());
  const upstreamFetch = deps.fetch ?? ((request: Request) => fetch(request));
  const log = deps.log ?? ((event, detail) => console.log(JSON.stringify({ event, ...detail })));

  // The token. Membership is checked here, by the same reader `substrat push` is judged with: a
  // person signed in for this workspace. No service token reaches it, and nothing is issued for
  // a workspace the person does not belong to.
  app.post('/api/model-access', async (c) => {
    if (!deps.gateway(c.env)) return refuseStatus(501, 'this control plane offers no model access');
    const member = await deps.member(c.env, c.req.raw);
    if (!member) {
      return refuse('unauthenticated', 'sign in with `substrat login` and select a workspace you belong to');
    }
    const issued = now();
    const token = await signEphemeral(c.env, { purpose: PURPOSE, tenant: member.tenantId, actor: member.actor }, MODEL_ACCESS_TTL_SEC);
    c.header('cache-control', 'no-store');
    // No URL: the caller calls `{its control-plane URL}/model-access/{tenant.id}/v1`. One built
    // from this request's host would name whatever host a proxy in front of the plane put there.
    return c.json({
      token,
      expiresAt: new Date(issued.getTime() + MODEL_ACCESS_TTL_SEC * 1000).toISOString(),
      tenant: { id: member.tenantId, slug: member.tenantSlug },
    });
  });

  // The call. The workspace is in the path and in the token, and both must agree.
  app.post('/api/model-access/:tenant/v1/chat/completions', async (c) => {
    const gateway = deps.gateway(c.env);
    if (!gateway) return refuseStatus(501, 'this control plane offers no model access');
    const token = await readToken(c.env, c.req.raw);
    if (!token) return refuse('unauthenticated', 'model access token missing, invalid or expired');
    if (token.tenant !== c.req.param('tenant')) {
      return refuse('forbidden', 'this model access token is for another workspace');
    }

    const text = await c.req.text();
    if (new TextEncoder().encode(text).byteLength > MODEL_ACCESS_MAX_BODY_BYTES) {
      return refuseStatus(413, `request body over ${MODEL_ACCESS_MAX_BODY_BYTES} bytes`);
    }
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      return refuse('validation_failed', 'the body is not a JSON object');
    }
    const modelId = body['model'];
    // Workers AI's own catalogue only: a partner-served `vendor/model` id is another vendor's
    // infrastructure, which is not what this door offers.
    if (typeof modelId !== 'string' || !modelId.startsWith('@cf/')) {
      return refuse('validation_failed', 'model must be a Workers AI model id (`@cf/…`)');
    }
    for (const key of ['max_tokens', 'max_completion_tokens']) {
      const v = body[key];
      if (v !== undefined && (typeof v !== 'number' || v > MODEL_ACCESS_MAX_OUTPUT_TOKENS)) {
        return refuse('validation_failed', `${key} must be a number of at most ${MODEL_ACCESS_MAX_OUTPUT_TOKENS}`);
      }
    }
    const stream = body['stream'] === true;
    // A streamed answer reports its usage only when asked, and an unpriced line escapes the ledger.
    if (stream) body['stream_options'] = { ...(body['stream_options'] as object | undefined), include_usage: true };

    const attribution = devAttribution(token.tenant, c.req.header('cf-aig-metadata') ?? null);
    const started = now();
    const upstream = await upstreamFetch(
      new Request(`${gateway.CLOUDFLARE_AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${gateway.CLOUDFLARE_AI_API_TOKEN}`,
          // The attribution as metadata, payload logging off, and the platform's gateway: the
          // headers a hosted call over the same keys carries.
          ...requestHeadersFor('cloudflare', { attribution, env: gateway }),
        },
        body: JSON.stringify(body),
      }),
    );

    const headers = new Headers({ 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
    // A refusal upstream goes back as the provider wrote it, status and all, so the caller's SDK
    // reads it (and retries a 429 or 5xx) as it would any OpenAI-compatible error. Nothing ran.
    if (!upstream.ok || !upstream.body) return new Response(upstream.body, { status: upstream.status, headers });

    const settle = async (usage: Promise<UpstreamUsage | null>) => {
      try {
        const line = devUsageLine({ attribution, modelId, usage: await usage, started, finished: now() });
        await deps.record(c.env, { requestId: crypto.randomUUID(), line });
      } catch (error) {
        log('model-access.usage.unrecorded', { tenant: token.tenant, model: modelId, error: String(error) });
      }
    };
    const [toCaller, toLedger] = upstream.body.tee();
    const usage = stream
      ? streamedUsage(toLedger)
      : new Response(toLedger).json().then((j) => ((j as { usage?: UpstreamUsage }).usage ?? null), () => null);
    const pending = settle(usage);
    let deferred = false;
    if (deps.defer) {
      deps.defer(pending);
      deferred = true;
    } else {
      try {
        c.executionCtx.waitUntil(pending);
        deferred = true;
      } catch {
        /* no execution context here */
      }
    }
    if (!deferred) await pending;
    return new Response(toCaller, { status: upstream.status, headers });
  });
}
