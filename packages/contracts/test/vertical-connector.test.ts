/**
 * Vertical-defined connectors (docs/architecture/vertical-connectors.md): the declaration a push
 * carries, the call into a vertical's worker, and the push-boundary grant check.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_CALL_STATE_MAX_BYTES,
  CONNECTOR_CALL_STATE_MAX_KEYS,
  connectionProvider,
  connectorCallRequest,
  connectorCallTarget,
  connectorCallState,
  connectorsOfManifestJson,
  pushedConnectorProblems,
  pushedPermissionRegistry,
  verticalConnectorDeclaration,
  verticalConnectorDeclarations,
  verticalConnectorStateKey,
  type PermissionKey,
} from '../src/index.js';

const DECL = {
  provider: 'acme.docbox',
  label: 'docbox',
  description: 'A document box.',
  fields: [
    { key: 'user', label: 'User', secret: false },
    { key: 'password', label: 'Password', secret: true },
  ],
  grants: ['documents:land'],
  events: ['documents.files-requested'],
  sweeps: true,
  binds: false,
  dispatches: true,
};

const TENANT = '01HZZZZZZZZZZZZZZZZZZZZZZA';
const SCOPE = '01HZZZZZZZZZZZZZZZZZZZZZZB';
const CONNECTION = {
  id: '01HZZZZZZZZZZZZZZZZZZZZZZC',
  tenantId: TENANT,
  vertical: 'acme-crm',
  provider: 'acme.docbox',
  externalAccountRef: null,
  expiresAt: null,
  secret: { user: 'u', password: 'p' },
};

describe('vertical-defined connectors', () => {
  it.each([
    ['scrive', true],
    ['acme.docbox', true],
    ['acme.docbox.v2', false],
    ['.docbox', false],
    ['acme.', false],
    ['Acme.docbox', false],
  ])('provider %s parses: %s', (provider, ok) => {
    expect(connectionProvider.safeParse(provider).success).toBe(ok);
  });

  it('refuses a first-party slug as a declared provider', () => {
    expect(verticalConnectorDeclaration.safeParse({ ...DECL, provider: 'scrive' }).success).toBe(false);
  });

  it.each([
    ['a field key twice', { fields: [DECL.fields[0], DECL.fields[0]] }, /field keys must be unique/],
    ['events with no dispatch', { dispatches: false }, /events are routed but dispatches is false/],
    ['dispatch with no events', { events: [] }, /no event is routed/],
  ])('refuses a declaration with %s', (_, patch, message) => {
    expect(() => verticalConnectorDeclaration.parse({ ...DECL, ...patch })).toThrow(message);
  });

  it('refuses one provider declared twice in the list', () => {
    expect(verticalConnectorDeclarations.parse([DECL])).toHaveLength(1);
    expect(() => verticalConnectorDeclarations.parse([DECL, DECL])).toThrow(/declared more than once/);
  });

  it('parses each role, and refuses a connection for another provider', () => {
    const binding = { scopeId: SCOPE, operation: 'docs/land', permission: 'documents:land', options: {}, declared: {}, boundAt: '2026-10-01T00:00:00.000Z' };
    const requests = [
      { role: 'probe-candidate', provider: 'acme.docbox', secret: { user: 'u' } },
      { role: 'probe', provider: 'acme.docbox', connection: CONNECTION, state: [] },
      { role: 'bind', provider: 'acme.docbox', connection: CONNECTION, scopeId: SCOPE, options: { folder: '/in' } },
      { role: 'sweep', provider: 'acme.docbox', connection: CONNECTION, binding, state: [{ key: 'cursor', value: 3 }] },
    ];
    for (const r of requests) expect(connectorCallRequest.parse(r).role).toBe(r.role);
    expect(() =>
      connectorCallRequest.parse({ role: 'probe', provider: 'acme.other', connection: CONNECTION, state: [] }),
    ).toThrow(/the connection is for acme.docbox, not acme.other/);
  });

  it('parses a call target with or without a scope, and refuses a host outside the outbound grammar', () => {
    const target = { deploymentRef: 'acme-crm--v3', slug: 'acme-crm', tenantId: TENANT, scopeId: SCOPE, hosts: ['api.docbox.example'] };
    expect(connectorCallTarget.parse(target).scopeId).toBe(SCOPE);
    expect(connectorCallTarget.parse({ ...target, scopeId: null }).scopeId).toBeNull();
    expect(connectorCallTarget.safeParse({ ...target, hosts: ['*'] }).success).toBe(false);
    expect(connectorCallTarget.safeParse({ ...target, extra: 1 }).success).toBe(false);
  });

  it('caps state by key count, repeats and serialised size', () => {
    const many = Array.from({ length: CONNECTOR_CALL_STATE_MAX_KEYS + 1 }, (_, i) => ({ key: `k${i}`, value: null }));
    expect(() => connectorCallState.parse(many)).toThrow(/at most 2000 keys/);
    expect(() => connectorCallState.parse([{ key: 'a', value: 1 }, { key: 'a', value: 2 }])).toThrow(/names a key twice/);
    expect(() => connectorCallState.parse([{ key: 'big', value: 'x'.repeat(CONNECTOR_CALL_STATE_MAX_BYTES) }])).toThrow(/bytes serialised/);
  });

  it('keys connection-level and scoped state apart', () => {
    expect(verticalConnectorStateKey(null, 'cursor')).toBe('vc:state:-:cursor');
    expect(verticalConnectorStateKey(SCOPE, 'cursor')).toBe(`vc:state:${SCOPE}:cursor`);
  });

  it('reads a stored manifest in three answers', () => {
    expect(connectorsOfManifestJson(null)).toEqual({ kind: 'none' });
    expect(connectorsOfManifestJson(JSON.stringify({ version: '1' }))).toEqual({ kind: 'none' });
    expect(connectorsOfManifestJson(JSON.stringify({ connectors: [DECL] }))).toMatchObject({ kind: 'connectors', rows: [{ provider: 'acme.docbox' }] });
    expect(connectorsOfManifestJson('{')).toMatchObject({ kind: 'unreadable' });
    expect(connectorsOfManifestJson(JSON.stringify({ connectors: [{ provider: 'scrive' }] }))).toMatchObject({ kind: 'unreadable' });
  });

  it('refuses a standing grant the registry does not declare or reserves to a system principal', () => {
    const key = (k: string) => k as PermissionKey;
    const registry = {
      permissions: [
        { key: key('documents:land'), description: 'land', declaredBy: [] },
        { key: key('assistant:run'), description: 'run', declaredBy: [], holder: 'system' as const },
      ],
    };
    const connectors = [{ provider: 'acme.docbox', grants: [key('documents:land'), key('assistant:run'), key('ghost:key')] }];
    const problems = pushedConnectorProblems({ connectors, registry: { ...registry, connectors } });
    expect(problems).toHaveLength(2);
    expect(problems).toEqual([
      expect.stringMatching(/acme\.docbox → ghost:key: a standing grant the registry does not declare/),
      expect.stringMatching(/acme\.docbox → assistant:run: reserved to a system principal/),
    ]);
    const fine = [{ provider: 'acme.docbox', grants: [key('documents:land')] }];
    expect(pushedConnectorProblems({ connectors: fine, registry: { ...registry, connectors: fine } })).toEqual([]);
  });

  it.each([
    ['a connector the registry leaves out', [{ provider: 'acme.docbox', grants: [] }], undefined, /acme\.docbox: absent from registry\.connectors/],
    ['a registry row no connector declares', undefined, [{ provider: 'acme.docbox', grants: [] }], /registry\.connectors acme\.docbox: no connector declares it/],
    ['grants that differ', [{ provider: 'acme.docbox', grants: [] }], [{ provider: 'acme.docbox', grants: ['documents:land'] }], /acme\.docbox: its grants disagree/],
  ])('refuses connectors and registry.connectors that disagree: %s', (_, connectors, registered, message) => {
    const registry = { permissions: [{ key: 'documents:land' as PermissionKey, description: 'land', declaredBy: [] }], connectors: registered as never };
    expect(pushedConnectorProblems({ connectors: connectors as never, registry })).toEqual([expect.stringMatching(message)]);
  });

  it('holds registry.connectors to declared, unreserved keys, one row per provider', () => {
    const base = {
      permissions: [
        { key: 'documents:land', description: 'land', declaredBy: ['@acme/a'] },
        { key: 'assistant:run', description: 'run', declaredBy: ['@acme/a'], holder: 'system' },
      ],
      roles: [],
    };
    const row = { provider: 'acme.docbox', grants: ['documents:land'] };
    expect(pushedPermissionRegistry.safeParse({ ...base, connectors: [row] }).success).toBe(true);
    expect(pushedPermissionRegistry.safeParse({ ...base, connectors: [{ ...row, grants: ['ghost:key'] }] }).success).toBe(false);
    expect(pushedPermissionRegistry.safeParse({ ...base, connectors: [{ ...row, grants: ['assistant:run'] }] }).success).toBe(false);
    expect(pushedPermissionRegistry.safeParse({ ...base, connectors: [row, row] }).success).toBe(false);
    expect(pushedPermissionRegistry.safeParse({ ...base, connectors: [{ ...row, provider: 'scrive' }] }).success).toBe(false);
  });
});
