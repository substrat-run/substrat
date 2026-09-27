// Drive the Manyfold arc over HTTP — the layer the scenario test cannot reach
// (server.ts, the route table, x-site resolution, onError mapping).
//
// OIDC-only (oidc-only-demos.md): no x-principal seam any more. Each persona's bearer
// comes from the dev issuer's non-interactive door — POST /dev/token {sub} — the same
// round-trip devLogin resolves for the real login (sharedIssuer: true, #1683). Run with
// `pnpm --filter @substrat-run/demo-manyfold drive` once `pnpm dev` is up.
import { DEV_CLIENT_ID } from '@substrat-run/dev-issuer';
import { PERSONAS } from '../src/personas.js';

const BASE = `http://localhost:${process.env.PORT ?? 8876}`;
const ISSUER = process.env.OIDC_ISSUER ?? `http://localhost:${process.env.ISSUER_PORT ?? 8879}`;
// devLogin's clientId — the audience a shared-issuer bearer must carry (#1683) — is
// `OIDC_CLIENT_ID` if the server was started with it set, else the same DEV_CLIENT_ID
// default. Minting against the wrong audience is a silent 401, not a mint failure.
const AUDIENCE = process.env.OIDC_CLIENT_ID ?? DEV_CLIENT_ID;

async function mintToken(sub) {
  const res = await fetch(`${ISSUER}/dev/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sub, audience: AUDIENCE }),
  });
  if (!res.ok) throw new Error(`mint failed for ${sub}: ${res.status} ${await res.text()}`);
  const { access_token } = await res.json();
  return access_token;
}

async function op(token, site, name, input = {}) {
  const res = await fetch(`${BASE}/api/op/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-site': site },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const P = Object.fromEntries(
  await Promise.all(PERSONAS.map(async (p) => [p.name.split(' ')[0].toLowerCase(), await mintToken(p.sub)])),
);
console.log('personas:', PERSONAS.map((p) => `${p.name.split(' ')[0]} (${p.note})`).join(' · '));

const checks = [];
const expect = (label, got, want) => {
  const ok = got === want;
  checks.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label} → ${got}${ok ? '' : ` (wanted ${want})`}`);
};

// me resolves per site — /api/me carries no role string (server.ts: a person's role
// differs per site, so whoami answers in `can` booleans); viewer is the can-shape with
// read only.
const meAtLaw = await (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${P.emil}`, 'x-site': 'law' } })).json();
expect(
  'GET me (emil@law) can=viewer-only',
  JSON.stringify(meAtLaw.can),
  JSON.stringify({ read: true, author: false, review: false, publish: false, admin: false, manageSites: false }),
);

// Sofia (author@cafe) creates a post → 200
const created = await op(P.sofia, 'cafe', 'create-entry', { typeKey: 'post', body: { title: 'HTTP hello', slug: 'http-hello', body: 'Drafted over HTTP.', category: 'news' } });
expect('author create-entry (cafe)', created.status, 200);
const id = created.body.id;

// Sofia submits (200), then tries to approve (403 — author lacks review)
expect('author submit-for-review', (await op(P.sofia, 'cafe', 'submit-for-review', { entryId: id })).status, 200);
expect('author approve DENIED', (await op(P.sofia, 'cafe', 'approve', { entryId: id })).status, 403);

// Emil viewer@law cannot create (403) but can read (200)
expect('viewer@law create DENIED', (await op(P.emil, 'law', 'create-entry', { typeKey: 'page', body: { title: 'x', slug: 'x' } })).status, 403);
expect('viewer@law list-entries OK', (await op(P.emil, 'law', 'list-entries', {})).status, 200);

// Emil publisher@cafe approves + publishes → 200; delivery serves it
expect('publisher approve', (await op(P.emil, 'cafe', 'approve', { entryId: id })).status, 200);
expect('publisher publish', (await op(P.emil, 'cafe', 'publish', { entryId: id })).status, 200);
const delivered = await op(P.emil, 'cafe', 'deliver', { typeKey: 'post', slug: 'http-hello' });
expect('deliver published post', delivered.status, 200);
expect('delivered hash is sha-256', /^[0-9a-f]{64}$/.test(delivered.body.hash ?? ''), true);

// State machine can't skip: a fresh draft → publish is 409, not a silent 200 or a generic 400
const skip = await op(P.emil, 'cafe', 'create-entry', { typeKey: 'post', body: { title: 'Skip', slug: 'skip-http' } });
expect('publish-without-approve is 409', (await op(P.emil, 'cafe', 'publish', { entryId: skip.body.id })).status, 409);

// Scope isolation: padel has no delivered content. Paged (#1833): a page
// envelope, not a bare array.
const padel = await op(P.emil, 'padel', 'list-delivery', {});
expect('padel delivery empty', Array.isArray(padel.body.entries) && padel.body.entries.length === 0, true);

console.log(`\n${checks.every(Boolean) ? 'ALL PASS' : 'FAILURES'} — ${checks.filter(Boolean).length}/${checks.length}`);
process.exit(checks.every(Boolean) ? 0 : 1);
