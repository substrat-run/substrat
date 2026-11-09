// Shared todo lists: sign-in over OpenID Connect, lists you own, invites by email, shares you can
// revoke, a JSON API with OpenAPI, and an MCP endpoint that acts as the signed-in person.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 4310);
const ISSUER = (process.env.OIDC_ISSUER ?? 'http://localhost:18800').replace(/\/$/, '');
const CLIENT_ID = process.env.OIDC_CLIENT_ID ?? 'shared-lists';
const OWNER_EMAIL = (process.env.OWNER_EMAIL ?? 'alice@example.com').toLowerCase();
const DB_PATH = process.env.DB_PATH ?? 'data/app.db';
const OUTBOX = process.env.OUTBOX ?? 'outbox';
const BASE = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

mkdirSync(DB_PATH.replace(/\/[^/]*$/, '') || '.', { recursive: true });
mkdirSync(OUTBOX, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (sub TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT);
  CREATE TABLE IF NOT EXISTS members (email TEXT PRIMARY KEY, added_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, sub TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS lists (id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    email TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, accepted_sub TEXT, cancelled INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    sub TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
`);
db.prepare('INSERT OR IGNORE INTO members (email, added_at) VALUES (?, ?)').run(OWNER_EMAIL, new Date().toISOString());

const now = () => new Date().toISOString();
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const run = (sql, ...a) => db.prepare(sql).run(...a);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

// ── Tokens ─────────────────────────────────────────────────────────────────────────────
let discovery = null;
let keys = null;
async function oidc() {
  if (!discovery) discovery = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
  return discovery;
}
const b64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
async function verifyJwt(jwt, audiences) {
  const [h, p, s] = String(jwt).split('.');
  if (!s) fail(401, 'malformed token');
  const header = JSON.parse(b64url(h).toString());
  if (header.alg !== 'ES256') fail(401, 'unexpected token algorithm');
  if (!keys) keys = (await (await fetch((await oidc()).jwks_uri)).json()).keys;
  const jwk = keys.find((k) => k.kid === header.kid) ?? keys[0];
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) fail(401, 'bad token signature');
  const claims = JSON.parse(b64url(p).toString());
  if (claims.iss !== ISSUER) fail(401, 'token from another issuer');
  if (!audiences.includes(claims.aud)) fail(401, 'token for another audience');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) fail(401, 'token expired');
  if (!claims.email || claims.email_verified !== true) fail(401, 'token carries no verified email');
  return claims;
}

function remember(claims) {
  const email = String(claims.email).toLowerCase();
  run('INSERT INTO users (sub, email, name) VALUES (?, ?, ?) ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name', claims.sub, email, claims.name ?? email);
  return { sub: claims.sub, email, name: claims.name ?? email };
}

// An invitation is accepted by the person whose verified address it names, and nobody else.
function acceptInvites(me, email) {
  const pending = all('SELECT * FROM invites WHERE email = ? AND accepted_sub IS NULL AND cancelled = 0', email);
  for (const inv of pending) {
    run('UPDATE invites SET accepted_sub = ? WHERE id = ?', me.sub, inv.id);
    if (!one('SELECT 1 FROM shares WHERE list_id = ? AND sub = ? AND revoked_at IS NULL', inv.list_id, me.sub)) {
      run('INSERT INTO shares (id, list_id, sub, created_at) VALUES (?, ?, ?, ?)', randomUUID(), inv.list_id, me.sub, now());
    }
    run('INSERT OR IGNORE INTO members (email, added_at) VALUES (?, ?)', me.email, now());
  }
  return pending.length;
}

const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => c.split('=').map(decodeURIComponent)));

async function who(req) {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) {
    const me = remember(await verifyJwt(auth.slice(7), [CLIENT_ID, 'substrat-dev', `${BASE}/api/mcp`]));
    acceptInvites(me, me.email);
    return me;
  }
  const sid = cookies(req).sid;
  if (!sid) return null;
  const s = one('SELECT u.sub, u.email, u.name FROM sessions s JOIN users u ON u.sub = s.sub WHERE s.id = ?', sid);
  return s ? { sub: s.sub, email: s.email, name: s.name } : null;
}

const isMember = (me) => !!one('SELECT 1 FROM members WHERE email = ?', me.email);
function requireMe(me) {
  if (!me) fail(401, 'sign in first');
  return me;
}
function requireMember(me) {
  requireMe(me);
  if (!isMember(me)) fail(403, 'this app is by invitation only');
  return me;
}

// ── Access to one list ───────────────────────────────────────────────────────────────
function roleOn(listId, me) {
  const list = one('SELECT * FROM lists WHERE id = ?', listId);
  if (!list) return { list: null, role: null };
  if (list.owner_sub === me.sub) return { list, role: 'owner' };
  const share = one('SELECT 1 FROM shares WHERE list_id = ? AND sub = ? AND revoked_at IS NULL', listId, me.sub);
  return { list, role: share ? 'shared' : null };
}
function need(listId, me, roles) {
  const { list, role } = roleOn(listId, me);
  if (!list || !role) fail(404, 'no such list');
  if (!roles.includes(role)) fail(403, `only the list's owner may do that`);
  return list;
}
const itemList = (itemId) => one('SELECT list_id FROM items WHERE id = ?', itemId)?.list_id ?? fail(404, 'no such item');
const itemsOf = (listId) => all('SELECT id, text, done, created_at AS createdAt FROM items WHERE list_id = ? ORDER BY created_at', listId).map((i) => ({ ...i, done: !!i.done }));

// ── Operations: every door (the web UI's requests, the REST API, MCP) goes through these ──
const ops = {
  me: { method: 'GET', path: '/api/me', summary: 'Who is signed in', run: (me) => ({ ...requireMe(me), member: isMember(me) }) },
  join: {
    method: 'POST', path: '/api/join', summary: 'Accept the invitations waiting for your address',
    run: (me, _p, body) => {
      requireMe(me);
      const email = me.email;
      return { accepted: acceptInvites(me, email) };
    },
  },
  listLists: {
    method: 'GET', path: '/api/lists', summary: 'Your lists and the lists shared with you',
    run: (me) => {
      requireMember(me);
      const own = all('SELECT id, name, created_at AS createdAt FROM lists WHERE owner_sub = ? ORDER BY created_at', me.sub).map((l) => ({ ...l, role: 'owner' }));
      const shared = all(`SELECT l.id, l.name, l.created_at AS createdAt FROM lists l JOIN shares s ON s.list_id = l.id
        WHERE s.sub = ? AND s.revoked_at IS NULL ORDER BY l.created_at`, me.sub).map((l) => ({ ...l, role: 'shared' }));
      return { lists: [...own, ...shared] };
    },
  },
  createList: {
    method: 'POST', path: '/api/lists', summary: 'Create a list', body: { name: 'string' },
    run: (me, _p, body) => {
      requireMember(me);
      const name = String(body?.name ?? '').trim();
      if (!name) fail(400, 'a list needs a name');
      const id = randomUUID();
      run('INSERT INTO lists (id, owner_sub, name, created_at) VALUES (?, ?, ?, ?)', id, me.sub, name, now());
      return { id, name, role: 'owner' };
    },
  },
  deleteList: {
    method: 'DELETE', path: '/api/lists/{listId}', summary: 'Delete a list you own',
    run: (me, p) => {
      requireMember(me);
      need(p.listId, me, ['owner']);
      run('DELETE FROM lists WHERE id = ?', p.listId);
      return { deleted: p.listId };
    },
  },
  listItems: {
    method: 'GET', path: '/api/lists/{listId}/items', summary: 'The items on a list',
    run: (me, p) => {
      requireMember(me);
      const list = need(p.listId, me, ['owner', 'shared']);
      return { list: { id: list.id, name: list.name }, items: itemsOf(p.listId) };
    },
  },
  addItem: {
    method: 'POST', path: '/api/lists/{listId}/items', summary: 'Add an item to a list', body: { text: 'string' },
    run: (me, p, body) => {
      requireMember(me);
      need(p.listId, me, ['owner', 'shared']);
      const text = String(body?.text ?? '').trim();
      if (!text) fail(400, 'an item needs text');
      const id = randomUUID();
      run('INSERT INTO items (id, list_id, text, created_at) VALUES (?, ?, ?, ?)', id, p.listId, text, now());
      return { id, text, done: false };
    },
  },
  setDone: {
    method: 'POST', path: '/api/items/{itemId}/done', summary: 'Tick or untick an item', body: { done: 'boolean' },
    run: (me, p, body) => {
      requireMember(me);
      need(itemList(p.itemId), me, ['owner', 'shared']);
      run('UPDATE items SET done = ? WHERE id = ?', body?.done === false ? 0 : 1, p.itemId);
      return { id: p.itemId, done: body?.done !== false };
    },
  },
  deleteItem: {
    method: 'DELETE', path: '/api/items/{itemId}', summary: 'Delete an item from a list you own',
    run: (me, p) => {
      requireMember(me);
      need(itemList(p.itemId), me, ['owner']);
      run('DELETE FROM items WHERE id = ?', p.itemId);
      return { deleted: p.itemId };
    },
  },
  invite: {
    method: 'POST', path: '/api/lists/{listId}/invites', summary: 'Invite someone to a list by email', body: { email: 'string' },
    run: (me, p, body) => {
      requireMember(me);
      const list = need(p.listId, me, ['owner']);
      const email = String(body?.email ?? '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail(400, 'that is not an email address');
      const id = randomUUID();
      const token = randomUUID();
      run('INSERT INTO invites (id, list_id, email, token, created_at) VALUES (?, ?, ?, ?, ?)', id, list.id, email, token, now());
      const link = `${BASE}/invite/${token}`;
      writeFileSync(`${OUTBOX}/${Date.now()}-${id}.json`, JSON.stringify({
        to: email, from: 'lists@localhost', subject: `${me.name} shared "${list.name}" with you`,
        text: `${me.name} invited you to the list "${list.name}". Sign in with ${email} to open it: ${link}`, link,
      }, null, 1));
      return { id, email, listId: list.id };
    },
  },
  listInvites: {
    method: 'GET', path: '/api/lists/{listId}/invites', summary: 'Invitations on a list you own',
    run: (me, p) => {
      requireMember(me);
      need(p.listId, me, ['owner']);
      return { invites: all('SELECT id, email, created_at AS createdAt, accepted_sub IS NOT NULL AS accepted FROM invites WHERE list_id = ? AND cancelled = 0', p.listId) };
    },
  },
  cancelInvite: {
    method: 'DELETE', path: '/api/invites/{inviteId}', summary: 'Cancel an invitation',
    run: (me, p) => {
      requireMember(me);
      const inv = one('SELECT * FROM invites WHERE id = ?', p.inviteId) ?? fail(404, 'no such invitation');
      need(inv.list_id, me, ['owner']);
      run('UPDATE invites SET cancelled = 1 WHERE id = ?', inv.id);
      return { cancelled: inv.id };
    },
  },
  listShares: {
    method: 'GET', path: '/api/lists/{listId}/shares', summary: 'Who a list is shared with',
    run: (me, p) => {
      requireMember(me);
      need(p.listId, me, ['owner', 'shared']);
      return { shares: all(`SELECT s.id, u.email, u.name, s.created_at AS createdAt FROM shares s JOIN users u ON u.sub = s.sub
        WHERE s.list_id = ? AND s.revoked_at IS NULL`, p.listId) };
    },
  },
  revokeShare: {
    method: 'DELETE', path: '/api/shares/{shareId}', summary: 'Stop sharing a list with someone',
    run: (me, p) => {
      requireMember(me);
      const share = one('SELECT * FROM shares WHERE id = ?', p.shareId) ?? fail(404, 'no such share');
      need(share.list_id, me, ['owner']);
      run('UPDATE shares SET revoked_at = ? WHERE id = ?', now(), share.id);
      return { revoked: share.id };
    },
  },
};

// ── MCP (Streamable HTTP, JSON responses) ────────────────────────────────────────────
const toolName = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const pathParams = (path) => [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
function tools() {
  return Object.entries(ops).map(([k, op]) => ({
    name: toolName(k),
    description: op.summary,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries([...pathParams(op.path).map((n) => [n, { type: 'string' }]), ...Object.entries(op.body ?? {}).map(([n, t]) => [n, { type: t }])]),
      required: pathParams(op.path),
    },
  }));
}
async function mcp(me, msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'shared-lists', version: '1.0.0' } });
  if (msg.method === 'notifications/initialized') return null;
  if (msg.method === 'tools/list') return reply({ tools: tools() });
  if (msg.method === 'tools/call') {
    const key = Object.keys(ops).find((k) => toolName(k) === msg.params?.name);
    if (!key) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool' } };
    const args = msg.params?.arguments ?? {};
    try {
      const out = await ops[key].run(me, args, args);
      return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
    } catch (e) {
      return reply({ isError: true, content: [{ type: 'text', text: e.message }] });
    }
  }
  return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } };
}

// ── OpenAPI ──────────────────────────────────────────────────────────────────────────
function openapi() {
  const paths = {};
  for (const [k, op] of Object.entries(ops)) {
    const p = (paths[op.path] ??= {});
    p[op.method.toLowerCase()] = {
      operationId: k,
      summary: op.summary,
      parameters: pathParams(op.path).map((n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } })),
      ...(op.body ? { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(Object.entries(op.body).map(([n, t]) => [n, { type: t }])) } } } } } : {}),
      responses: { 200: { description: 'OK' }, 401: { description: 'Not signed in' }, 403: { description: 'Not allowed' }, 404: { description: 'Not found' } },
      security: [{ oidc: [] }, { cookie: [] }],
    };
  }
  return {
    openapi: '3.0.3', info: { title: 'Shared lists', version: '1.0.0' }, paths,
    components: { securitySchemes: { oidc: { type: 'openIdConnect', openIdConnectUrl: `${ISSUER}/.well-known/openid-configuration` }, cookie: { type: 'apiKey', in: 'cookie', name: 'sid' } } },
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────
const pending = new Map();
const routes = Object.entries(ops).map(([k, op]) => ({
  key: k, op, re: new RegExp(`^${op.path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)')}$`),
}));
async function readBody(req) {
  let s = '';
  for await (const c of req) s += c;
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    fail(400, 'the body is not JSON');
  }
}
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const b64 = (buf) => Buffer.from(buf).toString('base64url');

createServer(async (req, res) => {
  const t0 = Date.now();
  const url = new URL(req.url, BASE);
  let me = null;
  res.on('finish', () => console.log(JSON.stringify({ at: now(), method: req.method, path: url.pathname, status: res.statusCode, who: me?.email ?? null, ms: Date.now() - t0 })));
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(readFileSync(new URL('./index.html', import.meta.url)));
    }
    if (req.method === 'GET' && url.pathname === '/login') {
      const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      const state = b64(crypto.getRandomValues(new Uint8Array(16)));
      const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
      pending.set(state, { verifier, nonce, back: url.searchParams.get('next') ?? '/' });
      const a = new URL((await oidc()).authorization_endpoint);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: `${BASE}/callback`, scope: 'openid email profile', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' })) a.searchParams.set(k, v);
      res.writeHead(302, { location: a.toString() });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/callback') {
      const p = pending.get(url.searchParams.get('state') ?? '');
      if (!p) fail(400, 'unknown sign-in attempt');
      pending.delete(url.searchParams.get('state'));
      const tr = await fetch((await oidc()).token_endpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', redirect_uri: `${BASE}/callback`, client_id: CLIENT_ID, code_verifier: p.verifier }),
      });
      if (!tr.ok) fail(401, 'the provider refused the sign-in');
      const claims = await verifyJwt((await tr.json()).id_token, [CLIENT_ID]);
      if (claims.nonce !== p.nonce) fail(401, 'sign-in replayed');
      me = remember(claims);
      acceptInvites(me, me.email);
      const sid = randomUUID();
      run('INSERT INTO sessions (id, sub, created_at) VALUES (?, ?, ?)', sid, me.sub, now());
      res.writeHead(302, { location: p.back, 'set-cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/` });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/logout') {
      const sid = cookies(req).sid;
      if (sid) run('DELETE FROM sessions WHERE id = ?', sid);
      return send(res, 200, { signedOut: true }, { 'set-cookie': 'sid=; Max-Age=0; Path=/' });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/invite/')) {
      me = await who(req);
      if (!me) {
        res.writeHead(302, { location: `/login?next=${encodeURIComponent(url.pathname)}` });
        return res.end();
      }
      const inv = one('SELECT * FROM invites WHERE token = ? AND cancelled = 0', url.pathname.slice(8));
      if (!inv) fail(404, 'no such invitation');
      if (inv.email !== me.email) fail(403, 'this invitation is for another address');
      acceptInvites(me, me.email);
      res.writeHead(302, { location: `/#list=${inv.list_id}` });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/openapi.json') return send(res, 200, openapi());
    if (req.method === 'GET' && url.pathname === '/api/docs') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>Shared lists API</title><h1>Shared lists API</h1><p>OpenAPI: <a href="/openapi.json">/openapi.json</a></p><ul>${routes.map((r) => `<li><code>${r.op.method} ${r.op.path}</code> — ${r.op.summary}</li>`).join('')}</ul>`);
    }
    if (url.pathname === '/api/mcp') {
      me = await who(req);
      if (!me) return send(res, 401, { error: 'sign in first' }, { 'www-authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"` });
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const msg = await readBody(req);
      const out = Array.isArray(msg) ? (await Promise.all(msg.map((m) => mcp(me, m)))).filter(Boolean) : await mcp(me, msg);
      if (!out) {
        res.writeHead(202);
        return res.end();
      }
      return send(res, 200, out);
    }
    if (url.pathname === '/.well-known/oauth-protected-resource') return send(res, 200, { resource: `${BASE}/api/mcp`, authorization_servers: [ISSUER] });
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (!m || req.method !== r.op.method) continue;
      me = await who(req);
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, await r.op.run(me, { ...m.groups }, body));
    }
    fail(404, 'not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: e.message });
  }
}).listen(PORT, () => console.error(`shared lists on ${BASE}, issuer ${ISSUER}`));
