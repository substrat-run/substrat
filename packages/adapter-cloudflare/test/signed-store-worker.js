/**
 * A FIXTURE store script (#2210), run as a second worker. It is not the store entry module
 * of RFC scope-stores §10.3 (step 7), and it checks only the name-only MAC that the §10.3
 * envelope replaces. What it shows: a call signed over the object name under the store's key
 * is answered, and any other call is refused before anything is recorded.
 *
 * It verifies with the module contracts ships (`dist/scope-store-mac.js`, a zero-import
 * subpath), so there is no second copy to drift. Records live in a module-level Map: a Durable
 * Object namespace declared on this second script does not start in this pool, so nothing here
 * shows object storage.
 */
import { verifyScopeStoreName } from '../../contracts/dist/scope-store-mac.js';

const seen = new Map();

export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get('name') ?? '';
    const mac = request.headers.get('x-substrat-store-mac') ?? '';
    const ok = await verifyScopeStoreName(env.SUBSTRAT_STORE_HMAC_KEY, name, mac);
    if (!ok) return new Response('unauthorized', { status: 401 });
    const prior = seen.get(name);
    if (prior === undefined) seen.set(name, name);
    return Response.json({ result: { name: prior ?? name } });
  },
};
