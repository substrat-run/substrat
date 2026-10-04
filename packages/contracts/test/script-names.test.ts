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
  PLATFORM_SCRIPT_NAMES,
  platformScriptCollision,
  registerVerticalInput,
  ROUTER_SCRIPT_NAMES,
  verticalScriptStem,
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
