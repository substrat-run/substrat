import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { platformActorId, principalId, scopeId, tenantId, type PrincipalId, type ScopeId, type TenantId } from '@substrat-run/contracts';
import { ulid } from '@substrat-run/kernel';
import { SqliteScopeHost } from '@substrat-run/adapter-sqlite';
import { MODULES, provisionManyfold, type ManyfoldInstance } from './provision.js';

export function buildDemoHost(dir: string): SqliteScopeHost {
  const host = new SqliteScopeHost({ dir });
  for (const m of MODULES) host.registerModule(m);
  return host;
}

/**
 * The demo world: Nordlys Studio (one tenant), three client sites (scopes), and the
 * cast the scenario needs — including the per-site role differences that are the
 * whole point (Emil is Publisher on cafe, Author on padel, Viewer on law).
 */
export interface ManyfoldWorld extends ManyfoldInstance {
  t1: TenantId;
  cafe: ScopeId;
  padel: ScopeId;
  law: ScopeId;
  maja: PrincipalId; // admin (owner), tenant-wide
  emil: PrincipalId; // publisher@cafe · author@padel · viewer@law
  sofia: PrincipalId; // author@cafe
  /** A seeded snippet on cafe left in DRAFT — the unresolved-reference beat. */
  cafeDraftSnippet?: string;
}

export async function seedDemo(host: SqliteScopeHost, dir: string): Promise<ManyfoldWorld> {
  const castPath = join(dir, 'cast.json');
  const fresh = !existsSync(castPath);
  const raw: Record<string, string> = fresh
    ? {
        t1: ulid(), cafe: ulid(), padel: ulid(), law: ulid(),
        maja: ulid(), emil: ulid(), sofia: ulid(), cafeDraftSnippet: '',
      }
    : (JSON.parse(readFileSync(castPath, 'utf8')) as Record<string, string>);

  const world: ManyfoldWorld = {
    tenantId: tenantId.parse(raw.t1),
    owner: principalId.parse(raw.maja),
    sites: [],
    t1: tenantId.parse(raw.t1),
    cafe: scopeId.parse(raw.cafe),
    padel: scopeId.parse(raw.padel),
    law: scopeId.parse(raw.law),
    maja: principalId.parse(raw.maja),
    emil: principalId.parse(raw.emil),
    sofia: principalId.parse(raw.sofia),
    cafeDraftSnippet: raw.cafeDraftSnippet || undefined,
  };
  world.sites = [
    { scopeId: world.cafe, slug: 'cafe', name: 'Café Nordlys' },
    { scopeId: world.padel, slug: 'padel', name: 'Padel Nordic' },
    { scopeId: world.law, slug: 'law', name: 'Lindqvist & Ruiz' },
  ];

  const staff = platformActorId.parse(ulid());

  await provisionManyfold(host, {
    tenantId: world.t1,
    owner: world.maja,
    slug: 'nordlys',
    name: 'Nordlys Studio',
    sites: world.sites,
  });

  // Per-site role assignments — the same login, different authority per scope (K-22).
  const assign = (principal: PrincipalId, roleKey: string, scope: ScopeId) =>
    host.admin.assignRole(staff, { principalId: principal, roleKey, node: { tenantId: world.t1, scopeId: scope } });
  await assign(world.emil, 'publisher', world.cafe);
  await assign(world.emil, 'author', world.padel);
  await assign(world.emil, 'viewer', world.law);
  await assign(world.sofia, 'author', world.cafe);

  if (fresh) {
    // A little starting content on cafe so the dev server / app has something to show.
    const maja = await host.getScope(world.maja, world.t1, world.cafe);
    await maja.invoke('manyfold/create-entry', {
      typeKey: 'author',
      body: { name: 'Sofia Ruiz', bio: 'Barista and writer at Café Nordlys.' },
    });
    const cta = await maja.invoke<{ id: string }>('manyfold/create-entry', {
      typeKey: 'snippet',
      body: { name: 'Newsletter CTA', kind: 'cta', body: 'Sign up for the roast of the month.' },
    });
    // A DRAFT snippet, deliberately left unpublished — the delivery unresolved-reference beat.
    const draft = await maja.invoke<{ id: string }>('manyfold/create-entry', {
      typeKey: 'snippet',
      body: { name: 'Summer banner', kind: 'banner', body: 'Iced coffee season is here.' },
    });
    world.cafeDraftSnippet = draft.id;
    await maja.invoke('manyfold/create-entry', {
      typeKey: 'page',
      body: { title: 'About', slug: 'about', body: 'A neighbourhood café in the north light.', blocks: [cta.id] },
    });

    writeFileSync(castPath, JSON.stringify(world, null, 2));
  }

  return world;
}
