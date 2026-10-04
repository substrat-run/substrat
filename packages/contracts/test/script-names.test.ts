/**
 * #1923: the platform's own script names are reserved, so a vertical's logs can never pass
 * for a platform worker's — the router's above all, whose lines the field-coverage tally
 * takes as provenance.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLATFORM_SCRIPT_NAMES,
  platformScriptCollision,
  registerVerticalInput,
  ROUTER_SCRIPT_NAMES,
  verticalScriptStem,
} from '../src/index.js';

const ROOT = new URL('../../../', import.meta.url);

/** The script names one wrangler config deploys: its `name`, and `<name>-<env>` per named env unless it sets its own. */
function scriptNamesOf(path: URL): string[] {
  const config = readFileSync(path, 'utf8');
  const name = /^\s*"name": "([^"]+)",?\s*$/m.exec(config)?.[1];
  if (!name) return [];
  const names = [name];
  const envs = /^\t"env": \{$/m.exec(config);
  if (envs) {
    // Each env block: `\t\t"<env>": {`, optionally followed by its own `\t\t\t"name": "…"`.
    for (const m of config.slice(envs.index).matchAll(/^\t\t"([a-z]+)": \{\n(?:\t\t\t"name": "([^"]+)")?/gm)) {
      names.push(m[2] ?? `${name}-${m[1]}`);
    }
  }
  return names;
}

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
