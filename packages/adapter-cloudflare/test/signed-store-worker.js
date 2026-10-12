/**
 * The store script (#2210), a second worker. It holds the HMAC key and answers
 * only a call signed over the object name.
 *
 * The verify steps are the ones in `@substrat-run/contracts/scope-store-mac`.
 * This file cannot import that module: workerd loads it unbundled. The test
 * signs with the module and this script checks, so a drift between them fails.
 *
 * A Durable Object namespace on this second script does not start in this
 * pool: workerd reports an internal error when the namespace is declared here.
 * The call is this script's fetch. The object name itself is still
 * `scopeStoreObjectName`, which the test asserts has no version.
 */
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

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

async function verifyScopeStoreName(secret, objectName, signature) {
  const bytes = base64UrlToBytes(signature);
  if (!bytes) return false;
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, copy, new TextEncoder().encode(objectName));
}
