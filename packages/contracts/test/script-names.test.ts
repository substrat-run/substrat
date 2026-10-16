/**
 * #1923: the platform's own script names are reserved, so a vertical's logs can never pass
 * for a platform worker's — the router's above all, whose lines the field-coverage tally
 * takes as provenance.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// The repo's wrangler JSONC reader: string-aware comments and trailing commas (tools/jsonc.mjs).
import { parseJsonc } from '../../../tools/jsonc.mjs';
import {
  createTenantInput,
  PLATFORM_SCRIPT_NAMES,
  platformScriptCollision,
  registerVerticalInput,
  ROUTER_SCRIPT_NAMES,
  SCOPE_STORE_CANARY,
  scopeStoreCanaryObjectName,
  scopeStoreCanaryScriptName,
  scopeStoreObjectName,
  scopeStoreScriptName,
  slug as tenantSlug,
  verticalScriptStem,
  verticalSlug,
} from '../src/index.js';

const ROOT = new URL('../../../', import.meta.url);

/**
 * The script names one wrangler config deploys: its `name`, and per named env that env's own
 * `name`, or `<name>-<env>` (wrangler's default) when it sets none. Read STRUCTURALLY, through
 * the repo's wrangler JSONC parser, so a comment or another key before an env's `name` cannot
 * make this check the inferred name while the env deploys under a different one. Anything it
 * cannot read is a throw, never a shorter list.
 */
function scriptNamesIn(text: string, label: string): string[] {
  const config = parseJsonc(text) as Record<string, unknown>;
  const name = config['name'];
  if (typeof name !== 'string' || name === '') throw new Error(`${label}: no top-level "name"`);
  const envs = config['env'];
  if (envs === undefined) return [name];
  if (envs === null || typeof envs !== 'object' || Array.isArray(envs)) throw new Error(`${label}: "env" is not an object`);
  const names = [name];
  for (const [key, env] of Object.entries(envs)) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new Error(`${label}: env "${key}" is not an object`);
    const own = (env as Record<string, unknown>)['name'];
    if (own !== undefined && (typeof own !== 'string' || own === '')) throw new Error(`${label}: env "${key}" has a non-string "name"`);
    names.push(own ?? `${name}-${key}`);
  }
  return names;
}

const scriptNamesOf = (path: URL): string[] => scriptNamesIn(readFileSync(path, 'utf8'), path.pathname);

/** Every platform worker config: each app, and the shared issuer. */
function platformConfigs(): URL[] {
  const apps = readdirSync(new URL('apps/', ROOT)).map((d) => new URL(`apps/${d}/wrangler.jsonc`, ROOT));
  return [...apps, new URL('demos/auth-server/wrangler.jsonc', ROOT)].filter((u) => existsSync(u));
}

describe('platform script names (#1923)', () => {
  it('reserves every name a platform wrangler config deploys under', () => {
    const deployed = platformConfigs().flatMap(scriptNamesOf);
    // The parse found the workers, rather than vacuously agreeing with an empty list.
    expect(deployed).toEqual(expect.arrayContaining(['substrat-router', 'substrat-router-test', 'substrat-control-plane']));
    for (const name of deployed) expect(PLATFORM_SCRIPT_NAMES.has(name), name).toBe(true);
  });

  it('reads every env name structurally, whatever precedes it, and refuses what it cannot read', () => {
    const config = `{
      // a comment before the name
      "name": "substrat-x", // and after it, beside a URL: "https://example.com/a//b"
      "env": {
        "test": {
          // a comment before this env's own name
          "name": "substrat-x-testing",
        },
        "staging": {
          "workers_dev": true,
          "name": "substrat-x-stage"
        },
        "preview": { "routes": [{ "pattern": "*.x.example/*" }] },
      },
    }`;
    expect(scriptNamesIn(config, 'inline')).toEqual(['substrat-x', 'substrat-x-testing', 'substrat-x-stage', 'substrat-x-preview']);
    for (const bad of [
      '{ "env": {} }',
      '{ "name": "x", "env": [] }',
      '{ "name": "x", "env": { "test": true } }',
      '{ "name": "x", "env": { "test": { "name": 7 } } }',
      '{ "name": "x", "env": { "test": { "name": "" } } }',
      '{ "name": "x" "env": {} }',
    ]) {
      expect(() => scriptNamesIn(bad, 'inline'), bad).toThrow();
    }
  });

  it("holds the router's names to the router's config exactly", () => {
    expect([...ROUTER_SCRIPT_NAMES].sort()).toEqual(scriptNamesOf(new URL('apps/router/wrangler.jsonc', ROOT)).sort());
  });

  it('finds a slug whose stable or jurisdictional script would take a platform name', () => {
    expect(platformScriptCollision('substrat/router')).toBe('substrat-router');
    expect(platformScriptCollision('substrat/router-test')).toBe('substrat-router-test');
    expect(platformScriptCollision('substrat-router')).toBe('substrat-router');
    expect(platformScriptCollision('substrat/control-plane')).toBe('substrat-control-plane');
    // The twin: ordinary slugs, and near misses, are free.
    for (const slug of ['ticket0', 'acme/router', 'substrat/routers', 'substrat/router-x', 't-0wv2mwk4j5/crm']) {
      expect(platformScriptCollision(slug), slug).toBeNull();
    }
  });

  it('flattens a slug the way a script name is minted', () => {
    expect(verticalScriptStem('Acme/Widgets')).toBe('acme-widgets');
    expect(verticalScriptStem('callout')).toBe('callout');
  });

  it('refuses a colliding slug at registration, and registers an ordinary one', () => {
    for (const slug of ['substrat/router', 'substrat/router-test', 'substrat/dashboard']) {
      const parsed = registerVerticalInput.safeParse({ slug, name: 'x', source: 'cli' });
      expect(parsed.success, slug).toBe(false);
      expect(JSON.stringify(parsed.error?.issues), slug).toContain('platform');
    }
    expect(registerVerticalInput.safeParse({ slug: 'acme/router', name: 'x', source: 'cli' }).success).toBe(true);
  });
});

describe('scope-store script names (RFC scope-stores §10.7, L20)', () => {
  const DRIVERS = ['graph', 'g2', 'graphx'];
  const VERTICALS = [
    'crm',
    'acme-crm',
    'acme/crm',
    'acme/crm-x',
    'acme-crm/x',
    'acme-crm-x',
    'a/b-c',
    'a-b/c',
    'a-b-c',
    't-0wv2mwk4j5/crm',
  ];

  it('gives distinct (driver, vertical) pairs distinct names, and the same pair the same name', () => {
    const seen = new Map<string, string>();
    for (const driver of DRIVERS) {
      for (const vertical of VERTICALS) {
        const name = scopeStoreScriptName(vertical, driver);
        const pair = `${driver} ${vertical}`;
        expect(seen.get(name), `${pair} and ${seen.get(name)} share ${name}`).toBeUndefined();
        seen.set(name, pair);
        expect(scopeStoreScriptName(vertical, driver)).toBe(name);
        expect(name.startsWith('substrat-store-')).toBe(true);
      }
    }
    expect(scopeStoreScriptName('acme/crm', 'graph')).toBe('substrat-store-graph-acme_crm');
    expect(scopeStoreScriptName('crm', 'graph')).toBe('substrat-store-graph-crm');
  });

  it('relies on `_` and `-` never occurring where the encoding uses them as separators', () => {
    for (const value of ['acme_crm', 'acme/crm_x', 'acme_x/crm']) expect(verticalSlug.safeParse(value).success, value).toBe(false);
    for (const value of ['acme_x', 'a_b']) expect(tenantSlug.safeParse(value).success, value).toBe(false);
    // The twin: the shapes the encoding is built for parse.
    for (const value of ['acme/crm', 'acme-crm', 'crm']) expect(verticalSlug.safeParse(value).success, value).toBe(true);
  });

  it("names the platform's canary script and object outside every vertical's (D-63, #2300)", () => {
    expect(scopeStoreCanaryScriptName('graph')).toBe('substrat-store-graph--canary');
    // A vertical's store script is `substrat-store-<driver>-<encoded slug>`. The canary's encoded slug
    // would be `-canary`: no slug decodes to it, and the builder refuses it outright.
    expect(verticalSlug.safeParse(SCOPE_STORE_CANARY).success).toBe(false);
    expect(() => scopeStoreScriptName(SCOPE_STORE_CANARY, 'graph')).toThrow(/vertical slug/);
    for (const driver of DRIVERS) {
      for (const vertical of VERTICALS) expect(scopeStoreScriptName(vertical, driver)).not.toBe(scopeStoreCanaryScriptName(driver));
    }

    // The router builds an object name from a directory tenant id, the vertical's slug, the scope
    // id and a declared binding: `<tenant>/<slug>/<scope>/<binding>`, where only the slug may hold a
    // `/`. Every way to read the canary's name back as such a tuple needs a slug no grammar admits.
    const tenant = '01JZ0000000000000000000000';
    const scope = '01JZ0000000000000000000001';
    const name = scopeStoreCanaryObjectName(tenant, scope, 'GRAPH');
    expect(name).toBe(`${tenant}/-canary/${scope}/GRAPH`);
    const parts = name.split('/');
    // The slug is everything between the first and the last two segments.
    const asSlug = parts.slice(1, -2).join('/');
    expect(asSlug).toBe(SCOPE_STORE_CANARY);
    expect(verticalSlug.safeParse(asSlug).success).toBe(false);
    // The twin: a router name reads back to the slug it was built from.
    const routed = scopeStoreObjectName(tenant, 'acme/crm', scope, 'GRAPH').split('/');
    expect(verticalSlug.safeParse(routed.slice(1, -2).join('/')).success).toBe(true);
  });

  it('refuses a driver id or a vertical outside its grammar instead of flattening it', () => {
    for (const driver of ['graph-x', 'graph_x', 'Graph', '']) {
      expect(() => scopeStoreScriptName('acme/crm', driver), driver).toThrow(/driver id/);
    }
    for (const vertical of ['Acme/crm', 'acme_crm', 'a/b/c', '/crm', 'acme/', '']) {
      expect(() => scopeStoreScriptName(vertical, 'graph'), vertical).toThrow(/vertical slug/);
    }
  });

  it('reserves the store name space against every vertical script name', () => {
    for (const slug of ['substrat-store', 'substrat/store', 'substrat-store-graph-acme', 'substrat/store-graph-acme-crm', 'substrat-store/x']) {
      expect(platformScriptCollision(slug), slug).toBe(verticalScriptStem(slug));
      const parsed = registerVerticalInput.safeParse({ slug, name: 'x', source: 'cli' });
      expect(parsed.success, slug).toBe(false);
    }
    // The twin: names that only start alike are free.
    for (const slug of ['substrat/storefront', 'substrat-stores', 'acme/store-graph', 'store/substrat', 'substrat/stor']) {
      expect(platformScriptCollision(slug), slug).toBeNull();
      expect(registerVerticalInput.safeParse({ slug, name: 'x', source: 'cli' }).success, slug).toBe(true);
    }
  });

  it('refuses a tenant slug inside the store name space, and creates one beside it', () => {
    const input = (slug: string) => ({ id: '01JTENANT0000000000000000A', slug, name: 'x' });
    for (const slug of ['substrat-store', 'substrat-store-x']) {
      expect(createTenantInput.safeParse(input(slug)).success, slug).toBe(false);
    }
    for (const slug of ['substrat', 'substrat-storefront', 'acme']) {
      expect(createTenantInput.safeParse(input(slug)).success, slug).toBe(true);
    }
  });

  it('leaves every existing vertical script name as it was', () => {
    // Representative slug shapes in the fleet: bare, tenant-pinned, hyphenated, digits, the
    // generated tenant prefix. The stem a vertical deploys under is unchanged by L20.
    const expected: Record<string, string> = {
      ticket0: 'ticket0',
      todo: 'todo',
      'acme/crm': 'acme-crm',
      'acme-co/field-service': 'acme-co-field-service',
      't-0wv2mwk4j5/crm': 't-0wv2mwk4j5-crm',
      'substrat/docs-bot': 'substrat-docs-bot',
      '9lives/app2': '9lives-app2',
    };
    for (const [slug, stem] of Object.entries(expected)) {
      expect(verticalScriptStem(slug), slug).toBe(stem);
      expect(platformScriptCollision(slug), slug).toBeNull();
    }
  });
});
