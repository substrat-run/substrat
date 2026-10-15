import { DurableObject } from 'cloudflare:workers';
import { scopeStorePublicKeysFrom, verifyScopeStoreCall } from '@substrat-run/contracts/scope-store-envelope';

/**
 * The store script of the hop suite (#2207, #2287), bundled and run on workerd. It is not the
 * platform's store entry (#2289): it runs contracts' `verifyScopeStoreCall`, the function that
 * entry calls, so the signer and the verifier meet across a real hop. The object remembers the
 * first name it accepted.
 */
interface Env {
  STORE: DurableObjectNamespace;
  SCRIPT_NAME: string;
  CALLER_KEYS: string;
  PLATFORM_KEYS: string;
}

export class StoreObject extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const name = new URL(request.url).searchParams.get('name') ?? '';
    const remembered = await this.ctx.storage.get('name');
    if (typeof remembered !== 'string') {
      await this.ctx.storage.put('name', name);
      return Response.json({ result: { name } });
    }
    if (remembered !== name) return new Response('unauthorized', { status: 401 });
    return Response.json({ result: { name: remembered } });
  }
}

let calls = 0;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/calls') return Response.json({ calls });
    calls += 1;
    const body = await request.text();
    const verdict = await verifyScopeStoreCall({
      envelope: request.headers.get('x-substrat-store-envelope'),
      signature: request.headers.get('x-substrat-store-signature'),
      body,
      keys: scopeStorePublicKeysFrom({ caller: env.CALLER_KEYS, platform: env.PLATFORM_KEYS }),
      script: env.SCRIPT_NAME,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!verdict.ok) return new Response(`unauthorized: ${verdict.refusal}`, { status: 401 });
    // A test may address a different object than the signed name. Production signs and
    // addresses the same name; this is how an attack on an object that already remembers
    // one is reproduced.
    const addressed = request.headers.get('x-substrat-store-address') ?? verdict.envelope.name;
    const object = env.STORE.get(env.STORE.idFromName(addressed));
    return object.fetch('https://object/?name=' + encodeURIComponent(verdict.envelope.name));
  },
};
