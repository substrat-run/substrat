/**
 * The platform's store entry (#2289). Uploaded as the store script's main module.
 * The kind's class is imported through placeholders the uploader replaces, so the
 * kind never sees a call the envelope did not authorize.
 *
 * The default export addresses `SubstratStoreObject` with `idFromName` of the
 * envelope's name. The object checks the envelope and the first name it accepted
 * before it constructs the kind's class.
 */
import { DurableObject } from 'cloudflare:workers';
import * as kindModule from '__SUBSTRAT_STORE_KIND__';
import {
  base64UrlToBytes,
  parseScopeStoreEnvelope,
  scopeStoreBodyDigest,
  scopeStoreEnvelopeFresh,
  verifyScopeStoreEnvelope,
} from '@substrat-run/contracts/scope-store-envelope';

/** The first accepted object name. The kind is not given a way to write this key. */
const STORE_OBJECT_NAME_KEY = '__substrat_store_name';

interface StoreEntryEnv {
  SUBSTRAT_STORE: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
  };
  SUBSTRAT_STORE_CALLER_KEY?: string;
  SUBSTRAT_STORE_PLATFORM_KEY?: string;
  SUBSTRAT_STORE_VERTICAL?: string;
}

const Kind = kindModule['__SUBSTRAT_STORE_CLASS__'] as new (
  ctx: DurableObjectState,
  env: StoreEntryEnv,
) => { fetch(request: Request): Promise<Response> };

function unauthorized(): Response {
  return new Response('unauthorized', { status: 401 });
}

/** The vertical in `<tenant>/<vertical>/<scope>/<binding>`. A vertical may contain slashes. */
export function storeNameVertical(name: string): string | undefined {
  const parts = name.split('/');
  if (parts.length < 4 || parts.some((part) => part.length === 0)) return undefined;
  return parts.slice(1, -2).join('/');
}

async function acceptedEnvelope(
  request: Request,
  body: string,
  env: StoreEntryEnv,
): Promise<{ name: string } | undefined> {
  const header = request.headers.get('x-substrat-store-envelope');
  const signature = request.headers.get('x-substrat-store-signature');
  if (!header || !signature) return undefined;
  const bytes = base64UrlToBytes(header);
  if (!bytes) return undefined;
  const canonical = new TextDecoder().decode(bytes);
  const envelope = parseScopeStoreEnvelope(canonical);
  if (!envelope) return undefined;
  const reserved = envelope.op.startsWith('substrat.');
  if (reserved !== (envelope.aud === 'platform')) return undefined;
  if (!scopeStoreEnvelopeFresh(envelope.iat, Math.floor(Date.now() / 1000))) return undefined;
  if (envelope.digest !== (await scopeStoreBodyDigest(body))) return undefined;
  if (storeNameVertical(envelope.name) !== env.SUBSTRAT_STORE_VERTICAL) return undefined;
  const publicKey = envelope.aud === 'platform' ? env.SUBSTRAT_STORE_PLATFORM_KEY : env.SUBSTRAT_STORE_CALLER_KEY;
  if (!publicKey || !(await verifyScopeStoreEnvelope(publicKey, canonical, signature))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const operation = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'operation') : undefined;
  if (operation !== envelope.op) return undefined;
  return { name: envelope.name };
}

export class SubstratStoreObject extends DurableObject<StoreEntryEnv> {
  async fetch(request: Request): Promise<Response> {
    const body = await request.text();
    const accepted = await acceptedEnvelope(request, body, this.env);
    if (!accepted) return unauthorized();
    const remembered = await this.ctx.storage.get(STORE_OBJECT_NAME_KEY);
    if (typeof remembered !== 'string') {
      await this.ctx.storage.put(STORE_OBJECT_NAME_KEY, accepted.name);
    } else if (remembered !== accepted.name) {
      return unauthorized();
    }
    const kind = new Kind(this.ctx, this.env);
    return kind.fetch(
      new Request(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
  }
}

export default {
  async fetch(request: Request, env: StoreEntryEnv): Promise<Response> {
    const body = await request.text();
    const accepted = await acceptedEnvelope(request, body, env);
    if (!accepted) return unauthorized();
    const object = env.SUBSTRAT_STORE.get(env.SUBSTRAT_STORE.idFromName(accepted.name));
    return object.fetch(
      new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body,
      }),
    );
  },
};
