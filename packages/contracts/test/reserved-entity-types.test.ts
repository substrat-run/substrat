import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEntities, emitModel, manifestEntities } from '../src/model.js';
import { moduleManifest } from '../src/manifest.js';
import { deployManifest, storedDeployManifest } from '../src/deploy.js';
import { entityObjectRef, isKernelNamespace, RESERVED_NAMESPACES } from '../src/permission.js';

/**
 * #1869: a kernel namespace is refused as an entity type where a module DECLARES one, in any
 * case, so a vertical finds out when it emits or registers rather than at its first `ctx.link`.
 * The names are `RESERVED_NAMESPACES`, the same set `entityObjectRef` refuses at write time.
 */
const spellings = (ns: string) => [ns, ns[0]!.toUpperCase() + ns.slice(1), ns.toUpperCase()];
const entity = (table: string) => ({ table, fields: z.object({ id: z.string() }) });

const base = {
  id: '@test/m',
  version: '1.0.0',
  kernelContract: '^0.0.1',
  permissions: [{ key: 'thing:read', description: 'read' }],
  migrations: { journalDir: './m', compatibleFrom: '1.0.0' },
  attachmentTargets: [],
  entitlementKey: 'm',
  events: { emits: [], consumes: [] },
};

describe('kernel namespaces are not entity types (#1869)', () => {
  it('is one set, shared with the write-time refusal', () => {
    expect([...RESERVED_NAMESPACES].sort()).toEqual(
      ['capability', 'connection', 'org', 'principal', 'role', 'scope', 'system', 'tenant', 'vertical'],
    );
    for (const ns of RESERVED_NAMESPACES) {
      for (const name of spellings(ns)) {
        expect(isKernelNamespace(name)).toBe(true);
        expect(() => entityObjectRef({ entityType: name, entityId: 'x' }, 'test')).toThrow(/malformed entity ref/);
      }
    }
    // A name that merely starts with one is an ordinary entity type.
    for (const name of ['scopeItem', 'orgUnit', 'roles', 'systems', 'tenantNote']) {
      expect(isKernelNamespace(name)).toBe(false);
      expect(() => entityObjectRef({ entityType: name, entityId: 'x' }, 'test')).not.toThrow();
    }
  });

  it('defineEntities and emitModel refuse one as an entity name, in any case', () => {
    for (const ns of RESERVED_NAMESPACES) {
      for (const name of spellings(ns)) {
        const map = { [name]: entity('t_x') } as Record<string, ReturnType<typeof entity>>;
        expect(() => defineEntities(map)).toThrow(`model: '${name}' is a kernel namespace (in any case)`);
        expect(() => emitModel(map)).toThrow(`model: '${name}' is a kernel namespace (in any case)`);
      }
    }
    // The twin: an ordinary model, including a name that only starts with one, still emits.
    const ok = defineEntities({ scopeItem: entity('t_item'), box: { ...entity('t_box'), parents: ['scopeItem'] } });
    expect(Object.keys(emitModel(ok).entities)).toEqual(['box', 'scopeItem']);
  });

  it('the manifest refuses one in every position the permission graph reads', () => {
    const refused = (extra: object) => {
      const r = moduleManifest.safeParse({ ...base, ...extra });
      expect(r.success).toBe(false);
      // The refusal is the only one: everything else in the manifest parses.
      expect(r.error!.issues).toHaveLength(1);
      return r.error!.issues[0]!.message;
    };
    for (const ns of RESERVED_NAMESPACES) {
      for (const name of spellings(ns)) {
        const says = `'${name}' is a kernel namespace (in any case), not an entity type`;
        expect(refused({ entityRelations: [{ entityType: name, parentType: 'box' }] })).toContain(says);
        expect(refused({ entityRelations: [{ entityType: 'item', parentType: name }] })).toContain(says);
        expect(refused({ attachmentTargets: [{ entityType: name, readPermission: 'thing:read' }] })).toContain(says);
        expect(refused({ liveTargets: [{ entityType: name, readPermission: 'thing:read' }] })).toContain(says);
        expect(refused({ searchables: [{ entityType: name, fields: ['title'] }] })).toContain(says);
        expect(refused({ lists: [{ entityType: name, sortable: ['title'] }] })).toContain(says);
        expect(refused({ ui: { entityViews: [{ entityType: name, view: 'V' }] } })).toContain(says);
      }
    }
    // The twin: the same positions with ordinary names parse.
    const ok = moduleManifest.parse({
      ...base,
      entityRelations: [{ entityType: 'item', parentType: 'scopeItem' }],
      attachmentTargets: [{ entityType: 'item', readPermission: 'thing:read' }],
      liveTargets: [{ entityType: 'orgUnit', readPermission: 'thing:read' }],
    });
    expect(ok.entityRelations).toEqual([{ entityType: 'item', parentType: 'scopeItem' }]);
  });

  it('a push refuses one as an entityGrants shape; a stored version holding one stays readable', () => {
    const pushed = (entityType: string) => ({
      version: '1.0.0',
      entry: 'index.js',
      compatibilityDate: '2026-07-01',
      registry: { permissions: [], roles: [], entityGrants: [{ entityType, permissions: ['thing:read'] }] },
      digests: { manifest: 'm', permission: 'p', migration: 'g' },
    });
    for (const ns of RESERVED_NAMESPACES) {
      for (const name of spellings(ns)) {
        const r = deployManifest.safeParse(pushed(name));
        expect(r.success).toBe(false);
        expect(r.error!.issues.map((i) => i.message)).toEqual([
          `'${name}' is a kernel namespace (in any case), not an entity type`,
        ]);
        // History is read with the plain registry: a version stored before the refusal parses.
        expect(storedDeployManifest.parse(pushed(name)).registry?.entityGrants[0]?.entityType).toBe(name);
      }
    }
    expect(deployManifest.parse(pushed('scopeItem')).registry.entityGrants[0]?.entityType).toBe('scopeItem');
  });

  it('a hand-declared relation to an engine entity is refused at registration, where manifestEntities passes it on', () => {
    const ents = defineEntities({ item: entity('t_item') });
    const refs = manifestEntities(ents, { relations: [{ entityType: 'item', parentType: 'Scope' }] } as never);
    expect(moduleManifest.safeParse({ ...base, ...refs }).success).toBe(false);
  });
});
