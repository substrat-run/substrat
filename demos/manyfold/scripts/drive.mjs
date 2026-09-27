// Drive the Manyfold arc over HTTP — the layer the scenario test cannot reach
// (server.ts, the route table, x-principal/x-site resolution, onError mapping).
const BASE = `http://localhost:${process.env.PORT ?? 8876}`;

async function op(principal, site, name, input = {}) {
  const res = await fetch(`${BASE}/api/op/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-principal': principal, 'x-site': site },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const personas = await (await fetch(`${BASE}/api/personas`)).json();
const P = Object.fromEntries(personas.map((p) => [p.name.split(' ')[0].toLowerCase(), p.id]));
console.log('personas:', personas.map((p) => `${p.name.split(' ')[0]} ${JSON.stringify(p.roles)}`).join(' · '));

const checks = [];
const expect = (label, got, want) => {
  const ok = got === want;
  checks.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${label} → ${got}${ok ? '' : ` (wanted ${want})`}`);
};

// me resolves per site
expect('GET me (emil@law) role=viewer', (await (await fetch(`${BASE}/api/me`, { headers: { 'x-principal': P.emil, 'x-site': 'law' } })).json()).role, 'viewer');

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
