/**
 * A delegated MCP call held by the kernel, not only by the mount (#3178), against a REAL
 * `SqliteScopeHost`. `ceiling/a-then-b` leads with `ceiling:a`, so the mount's per-tool check
 * admits it under a scope of `ceiling:a`; its second check, `ceiling:b`, is the kernel's to refuse,
 * and it can only do that when `resolveStub` minted the stub with `mcpScopeOptions`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mcpResourceOf, permissionKey, platformActorId, principalId, scopeId, tenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { delegationCeilingMod } from '@substrat-run/contract-tests';
import { mountOperations } from '../src/operations-routes.js';
import { mcpScopeOptions, type McpDelegation } from '../src/mcp.js';

const ORIGIN = 'https://desk.example';
const ISSUER = 'https://team-auth.test';
const ACTOR = 'helpdesk';
const A = permissionKey.parse('ceiling:a');
const B = permissionKey.parse('ceiling:b');

/** The fixture module's operations, as the mount reads them: each leads with `ceiling:a`. */
const operations = {
  'ceiling/a-then-b': { summary: 'Asks for A, writes a row, then asks for B', permission: 'ceiling:a', http: { method: 'POST', path: '/a-then-b' } },
  'ceiling/rows': { summary: 'Rows written', permission: 'ceiling:a', http: { method: 'GET', path: '/rows' } },
} as const;

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** A delegated bearer's shape; the resolver below is a fake, so nothing verifies it. */
const delegatedBearer = `Bearer ${b64url({ alg: 'ES256' })}.${b64url({
  iss: ISSUER,
  sub: 'alice',
  aud: mcpResourceOf(ORIGIN),
  scope: 'ceiling:a',
  act: { iss: ISSUER, sub: ACTOR },
})}.c2ln`;

const dir = mkdtempSync(join(tmpdir(), 'substrat-mcp-kernel-ceiling-'));
const host = new SqliteScopeHost({ dir });
const staff = platformActorId.parse(ulid());
const t = tenantId.parse(ulid());
const s = scopeId.parse(ulid());
const alice = principalId.parse(ulid());

/** A desk whose `resolveStub` resolved `subject`: delegated, or alice herself. */
function desk(subject: { delegation?: McpDelegation } | null) {
  const app = new Hono();
  mountOperations(app, operations, async (c) => host.getScope(alice, t, s, { ...mcpScopeOptions(c, subject) }));
  return app;
}

async function callTool(app: Hono, name: string, authorization?: string): Promise<string | null> {
  const res = await app.request(`${ORIGIN}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { isError?: boolean; content: { text: string }[] } };
  return body.result?.isError ? body.result.content[0]!.text : null;
}

const rows = async () =>
  ((await (await host.getScope(alice, t, s)).invoke('ceiling/rows')) as { rows: number }).rows;

beforeAll(async () => {
  host.registerModule(delegationCeilingMod);
  await host.admin.createTenant(staff, { id: t, slug: `mcp-ceiling-${t.toLowerCase()}`, name: 'MCP ceiling' });
  await host.admin.grantEntitlement(staff, t, 'delegation-ceiling');
  await host.admin.defineRole(staff, t, { key: 'both', permissions: [A, B], source: 'vertical' });
  await host.admin.assignRole(staff, { principalId: alice, roleKey: 'both', node: { tenantId: t, scopeId: null } });
  await host.provisionScope(staff, { tenantId: t, scopeId: s, vertical: 'ceiling-vertical' });
  await host.admin.activateScope(staff, t, s);
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

it('a delegated call passes the per-tool check and is refused by the kernel at a second key outside the scope; alice directly is not', async () => {
  const delegated = desk({ delegation: { actor: ACTOR, scope: [A] } });
  const before = await rows();
  expect(await callTool(delegated, 'ceiling_a-then-b', delegatedBearer)).toMatch(/ceiling:b/);
  // Refused after its first write, which went with it.
  expect(await rows()).toBe(before);

  expect(await callTool(desk(null), 'ceiling_a-then-b')).toBeNull();
  expect(await rows()).toBe(before + 1);
});
