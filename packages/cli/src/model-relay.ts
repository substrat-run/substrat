/**
 * The loopback model relay `substrat dev` runs for a project that uses models (#3420).
 *
 * The app under `substrat dev` reaches Workers AI the way it would with its own gateway keys —
 * the model host's `cloudflare` row, over `CLOUDFLARE_AI_BASE_URL` and `CLOUDFLARE_AI_API_TOKEN`
 * — but both point here: a server on 127.0.0.1 and a random key that lives as long as this run.
 * The relay holds the short-lived model token the control plane issued for the selected
 * workspace, asks for a fresh one before it runs out, and forwards each call to the plane, which
 * makes the upstream call on its own keys.
 *
 * So the app's process never sees the Cloudflare credentials (the plane keeps them), nor the
 * `substrat login` session (this process keeps it), nor even the model token: what it holds
 * opens a loopback port that closes when `substrat dev` exits.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { webcrypto } from 'node:crypto';
import type { ModelAccess } from '@substrat-run/control-plane-client';

/** A token this close to its expiry is replaced before the next call rather than used. */
export const MODEL_TOKEN_REFRESH_MARGIN_MS = 60_000;

/** The one path the relay forwards: an OpenAI-compatible chat call. */
const CHAT = '/v1/chat/completions';

/** Model access as the relay holds it: the token, and the plane endpoint it is good at. */
export interface RelayAccess extends ModelAccess {
  /** `{control-plane URL}/model-access/{tenant}/v1` — built from the URL the CLI already trusts. */
  baseUrl: string;
}

export interface ModelRelayOptions {
  /** Asks the control plane for model access (`issueModelAccess`), with the CLI's own session. */
  issue: () => Promise<RelayAccess>;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ModelRelay {
  /** What the app's `CLOUDFLARE_AI_BASE_URL` is set to. */
  readonly baseUrl: string;
  /** What the app's `CLOUDFLARE_AI_API_TOKEN` is set to: valid at this relay only. */
  readonly key: string;
  /** The access the relay holds now, for the line `substrat dev` prints. */
  access(): Promise<RelayAccess>;
  close(): Promise<void>;
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** An OpenAI-shaped error body, so the app's SDK shows the sentence rather than a parse failure. */
function fail(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'substrat_dev_relay' } }));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startModelRelay(options: ModelRelayOptions): Promise<ModelRelay> {
  const upstreamFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const key = b64url(webcrypto.getRandomValues(new Uint8Array(32)));

  let held: RelayAccess | undefined;
  let pending: Promise<RelayAccess> | undefined;
  const fresh = (): Promise<RelayAccess> => {
    // One request at a time: concurrent calls share the refresh in flight.
    pending ??= options.issue().then(
      (access) => {
        held = access;
        pending = undefined;
        return access;
      },
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
  const access = async (): Promise<RelayAccess> =>
    held && Date.parse(held.expiresAt) - now() > MODEL_TOKEN_REFRESH_MARGIN_MS ? held : await fresh();

  const forward = async (body: Buffer, metadata: string | undefined, retried: boolean): Promise<Response> => {
    const current = await access();
    const response = await upstreamFetch(`${current.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${current.token}`,
        // The model host's attribution labels: the plane keeps the vertical and operation, and
        // replaces the workspace and scope with its own.
        ...(metadata ? { 'cf-aig-metadata': metadata } : {}),
      },
      body: new Uint8Array(body),
    });
    // A token refused before its time (the plane's key rotated, a clock apart): one fresh try.
    if (response.status === 401 && !retried) {
      await response.body?.cancel();
      held = undefined;
      return await forward(body, metadata, true);
    }
    return response;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.headers.authorization !== `Bearer ${key}`) return fail(res, 401, 'not this relay’s key');
      if (req.method !== 'POST' || url.pathname !== CHAT) return fail(res, 404, `substrat dev relays ${CHAT} only`);
      const body = await readBody(req);
      let upstream: Response;
      try {
        const metadata = req.headers['cf-aig-metadata'];
        upstream = await forward(body, typeof metadata === 'string' ? metadata : undefined, false);
      } catch (error) {
        return fail(res, 502, `substrat dev could not reach model access: ${error instanceof Error ? error.message : String(error)}`);
      }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      if (!upstream.body) return void res.end();
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    })().catch((error: unknown) => {
      if (!res.headersSent) fail(res, 500, String(error));
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    key,
    access,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // The app's keep-alive sockets would otherwise hold the port open past the run.
        server.closeAllConnections();
      }),
  };
}
