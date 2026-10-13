import { sign } from './mac.mjs';

/**
 * The worker a vertical would be: it holds a `durable_object_namespace`
 * binding whose class lives in another script (`script_name`), and it
 * addresses an object with `idFromName`.
 *
 * `REFUSE_RESERVED=1` is the vertical stub's half of #2209: `substrat.*`
 * is answered by the store, and refused here, before the binding is used.
 * The platform caller leaves the flag unset.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get('name');
    const operation = url.searchParams.get('op');
    if (!name || !operation) {
      return json({ error: { code: 'validation_failed', status: 400, body: { reason: 'name and op' } } }, 400);
    }
    if (env.REFUSE_RESERVED === '1' && operation.startsWith('substrat.')) {
      return json(
        { error: { code: 'forbidden', status: 403, body: { reason: 'reserved' } } },
        403,
      );
    }

    const by = Number(url.searchParams.get('by') ?? '1');
    const headers = { 'content-type': 'application/json', 'x-store-name': name };
    const provided = url.searchParams.get('sig');
    if (provided) headers['x-store-signature'] = provided;
    else if (env.SIGNING_KEY) {
      const signedName = url.searchParams.get('sign') ?? name;
      headers['x-store-signature'] = await sign(env.SIGNING_KEY, signedName);
    }

    const id = env.STORE.idFromName(name);
    const stub = env.STORE.get(id);
    return stub.fetch('https://store/', {
      method: 'POST',
      headers,
      body: JSON.stringify({ operation, input: { by } }),
    });
  },
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
