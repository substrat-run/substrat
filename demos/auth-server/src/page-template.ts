/// <reference path="./liquid-browser.d.ts" />
import { Liquid, Tag, type Context, type Emitter, type TagToken, type TopLevelToken } from 'liquidjs/dist/liquid.browser.mjs';
import { LOCALES, type Locale } from './locale-wire.js';
import type { SqlExec } from './introspect.js';

/**
 * The install's page template (#3350): one HTML document, written in Liquid, that the hosted
 * sign-in screens are drawn inside — Auth0's Universal Login page templates, close enough that a
 * template written for Auth0 can be pasted in. `PAGE-TEMPLATES.md` is the contract.
 *
 * Shared by every runtime: the worker renders it on each hand-off page, the Durable Object and
 * the dev server judge it on save and render the console's preview. Nothing here reads a clock,
 * a binding or the network.
 *
 * WHY IT CANNOT LOCK ANYONE OUT. Three layers, each sufficient for a different failure:
 *
 *  1. A save renders the template for every screen in every language and refuses one that
 *     throws, or that does not draw the sign-in UI exactly once (`templateProblems`).
 *  2. At request time a render that throws for any reason (data the save could not foresee, a
 *     limit) is caught by the caller, which serves the built-in page and logs why.
 *  3. The console is never templated: only the hand-off paths are, and `?builtin=0` skips it.
 *
 * WHY IT CANNOT HANG. liquidjs is an interpreter (no `eval`, no `new Function`, which workerd
 * refuses anyway), and every render is held to one budget (`RENDER_BUDGET`): each block it
 * renders, each loop iteration and each character it writes — into the page or into a
 * `capture` — is charged to liquidjs's own memory limiter, alongside what it already charges
 * (ranges, string and array filters). Its wall-clock limit is set too, but workerd's clock only
 * moves on I/O, so there the budget is the bound that holds.
 *
 * WHY IT CANNOT INJECT. Output is escaped by default and `raw` is refused, so a hostile
 * application name (a self-registered client chooses its own) prints as text. The page also
 * carries a Content-Security-Policy (`pageCsp`) under which a template's own scripts do not run.
 */

/** The `config` row holding the template. Not a `cfg:` key: it is not an env-spec setting. */
export const PAGE_TEMPLATE_KEY = 'page_template';

/** Auth0's own limit, in bytes of UTF-8. */
export const MAX_TEMPLATE_BYTES = 102_400;

/**
 * Units of work one render may spend: blocks rendered plus characters written, plus whatever
 * liquidjs charges itself. A real page spends a few tens of thousands; the worst a template can
 * do inside it is a fraction of a second.
 */
export const RENDER_BUDGET = 300_000;

/** liquidjs's wall-clock limit, in ms. Effective on node; on workerd the budget is what holds. */
export const RENDER_TIME_MS = 1_000;

/* ---- screens ---- */

/**
 * Every hosted screen a template wraps, with Auth0's `prompt.name` and `prompt.screen.name`
 * where Auth0 has the same screen. `github-email` has no Auth0 counterpart: it is the step that
 * asks for an address when GitHub shares none.
 */
export const SCREENS = {
  login: { prompt: 'login', path: '/login' },
  signup: { prompt: 'signup', path: '/signup' },
  consent: { prompt: 'consent', path: '/consent' },
  'reset-password': { prompt: 'reset-password', path: '/reset-password' },
  'accept-invitation': { prompt: 'invitation', path: '/accept-invitation' },
  'github-email': { prompt: 'login', path: '/github-email' },
} as const;

export type ScreenName = keyof typeof SCREENS;
export const SCREEN_NAMES = Object.keys(SCREENS) as ScreenName[];

/** The paths a template may wrap — the hand-off pages, and nothing the console draws. */
export const TEMPLATED_PATHS: readonly string[] = SCREEN_NAMES.map((s) => SCREENS[s].path);

export function isScreenName(value: unknown): value is ScreenName {
  return typeof value === 'string' && Object.hasOwn(SCREENS, value);
}

/* ---- variables ---- */

/** What a template can print. `PAGE-TEMPLATES.md` lists the same fields; keep them together. */
export interface PageVariables {
  application?: { id: string; client_id: string; name: string; logo_url?: string; metadata: Record<string, string> };
  branding: { logo_url?: string; colors: { primary?: string; page_background?: string } };
  locale: Locale;
  dir: 'ltr';
  prompt: { name: string; screen: { name: ScreenName } };
  tenant: { friendly_name?: string; enabled_locales: Locale[] };
  user?: { name?: string; email?: string; picture?: string };
}

export interface PageVariableInput {
  screen: ScreenName;
  locale: Locale;
  /** Only a client named by a verified authorize request; null otherwise. */
  application: { clientId: string; name: string | null; icon: string | null; metadata: unknown } | null;
  theme: { logoUrl?: string; colorPrimary?: string; colorBackground?: string; languages?: readonly Locale[] };
  tenantName: string | null;
  user: { name: string | null; email: string | null; picture: string | null } | null;
}

const httpsUrl = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The variables for one page. Absent means absent: Liquid prints an undefined variable as
 * nothing, as Auth0 does, so a template written for a screen with a user still renders on one
 * without.
 */
export function pageVariables(input: PageVariableInput): PageVariables {
  const app = input.application;
  // Auth0's `application.metadata` is the client's string-valued metadata. Here a client's
  // metadata also holds this issuer's own objects (`theme`, `signIn`); only strings are shown.
  const metadata: Record<string, string> = {};
  if (app?.metadata && typeof app.metadata === 'object' && !Array.isArray(app.metadata)) {
    for (const [key, value] of Object.entries(app.metadata as Record<string, unknown>)) {
      if (typeof value === 'string') metadata[key] = value;
    }
  }
  const logo = httpsUrl(app?.icon);
  const user = input.user;
  return {
    ...(app
      ? { application: { id: app.clientId, client_id: app.clientId, name: app.name ?? app.clientId, ...(logo ? { logo_url: logo } : {}), metadata } }
      : {}),
    branding: {
      ...(input.theme.logoUrl ? { logo_url: input.theme.logoUrl } : {}),
      colors: {
        ...(input.theme.colorPrimary ? { primary: input.theme.colorPrimary } : {}),
        ...(input.theme.colorBackground ? { page_background: input.theme.colorBackground } : {}),
      },
    },
    locale: input.locale,
    dir: 'ltr',
    prompt: { name: SCREENS[input.screen].prompt, screen: { name: input.screen } },
    tenant: {
      ...(input.tenantName ? { friendly_name: input.tenantName } : {}),
      enabled_locales: [...(input.theme.languages?.length ? input.theme.languages : LOCALES)],
    },
    ...(user
      ? {
          user: {
            ...(user.name ? { name: user.name } : {}),
            ...(user.email ? { email: user.email } : {}),
            ...(httpsUrl(user.picture) ? { picture: user.picture! } : {}),
          },
        }
      : {}),
  };
}

/** The origins a page's images may come from: every https image URL its variables carry. */
export function imageOrigins(variables: PageVariables): string[] {
  const urls = [variables.branding.logo_url, variables.application?.logo_url, variables.user?.picture];
  const origins = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') origins.add(parsed.origin);
    } catch {
      /* not a URL: nothing to allow */
    }
  }
  return [...origins];
}

/* ---- what the two tags draw ---- */

export interface PageParts {
  /** What `{%- auth0:head -%}` writes. */
  head: string;
  /** What `{%- auth0:widget -%}` writes. */
  widget: string;
}

const ATTR_ESCAPE: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };
const attr = (value: string) => value.replace(/[&"<>]/g, (ch) => ATTR_ESCAPE[ch]!);

/**
 * The two tags' output, from the built SPA's `index.html`: its external scripts (each given the
 * request's nonce) and stylesheets, and the element the app mounts on.
 *
 * Not the whole head. The inline script in it only matters on console URLs, which are never
 * templated, and an inline script without the nonce would be refused anyway; the title, icon
 * and theme colour are the template's to choose.
 *
 * `preview` marks the mount point with the screen to draw (the console's live preview), so the
 * app can draw a screen whose real data — a pending authorize request, a reset token — a
 * preview does not have.
 */
export function pageParts(indexHtml: string | undefined, nonce: string, preview?: { screen: ScreenName }): PageParts {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(indexHtml ?? '')?.[1] ?? '';
  const scripts = [...head.matchAll(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>/gi)].map((m) =>
    m[0].replace(/^<script\b/i, `<script nonce="${attr(nonce)}"`),
  );
  const links = [...head.matchAll(/<link\b[^>]*\brel="(?:stylesheet|modulepreload)"[^>]*>/gi)].map((m) => m[0]);
  return {
    head: [
      '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">',
      ...links,
      ...scripts,
    ].join('\n'),
    widget: `<div id="root" class="page-template-widget"${preview ? ` data-preview-screen="${attr(preview.screen)}"` : ''}></div>`,
  };
}

/**
 * The Content-Security-Policy every templated page carries.
 *
 *  - Scripts: this origin's files and the nonce our head carries. A template's own inline or
 *    remote scripts do not run.
 *  - Nothing else from another origin either — no stylesheet, font or connection — and images
 *    only from the origins `imageOrigins` names. These pages hold a password field, and a page
 *    that can reach another origin can send what is typed into it there; it is the rule
 *    `THEMING.md` holds a theme's raw CSS to, enforced by the browser for the whole page.
 *  - Inline styles are allowed: a `<style>` block can only reach the network through `url()`,
 *    which the directives above already confine.
 */
export function pageCsp(nonce: string, images: readonly string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${images.map((o) => ` ${o}`).join('')}`,
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

/** A fresh nonce: 128 random bits, base64. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/* ---- the engine ---- */

/** Auth0 spells the tags with a colon, which liquidjs does not read in a tag name. */
const AUTH0_TAG = /\{%(-?)\s*auth0:(head|widget)\s*(-?)%\}/g;

function liquidSource(template: string): string {
  return template.replace(AUTH0_TAG, (_m, left: string, which: string, right: string) => `{%${left} auth0_${which} ${right}%}`);
}

/** The tags a page template may not use, and why. Refused when the template is parsed. */
const REFUSED_TAGS: Record<string, string> = {
  include: 'a page template is a single file, so {% include %} is not available',
  render: 'a page template is a single file, so {% render %} is not available',
  layout: 'a page template is a single file, so {% layout %} is not available',
};

/** Writes into a string, charging each character to the render's budget. */
class BudgetEmitter implements Emitter {
  buffer = '';
  constructor(private readonly ctx: Context) {}
  write(html: unknown): void {
    const text = html === null || html === undefined ? '' : String(html);
    this.ctx.memoryLimit.use(text.length);
    this.buffer += text;
  }
}

/**
 * A Liquid engine for one render. Built per render because the two tags write this request's
 * parts and count how often they were drawn; that state must not outlive the request.
 */
function engineFor(parts: PageParts, drawn: { head: number; widget: number }): Liquid {
  const engine = new Liquid({
    // No file system, and no network: a lookup by name finds nothing.
    templates: {},
    relativeReference: false,
    strictFilters: true,
    outputEscape: 'escape',
    ownPropertyOnly: true,
    parseLimit: MAX_TEMPLATE_BYTES,
    memoryLimit: RENDER_BUDGET,
    renderLimit: RENDER_TIME_MS,
    cache: false,
  });
  engine.registerFilter('raw', () => {
    throw new Error('the raw filter is not available: output is always escaped');
  });
  for (const [name, reason] of Object.entries(REFUSED_TAGS)) {
    engine.registerTag(
      name,
      class extends Tag {
        constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
          super(token, remain, liquid);
          throw new Error(reason);
        }
        render(): void {}
      },
    );
  }
  const partTag = (which: 'head' | 'widget') =>
    class extends Tag {
      *render(_ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
        drawn[which] += 1;
        emitter.write(parts[which]);
      }
    };
  engine.registerTag('auth0_head', partTag('head'));
  engine.registerTag('auth0_widget', partTag('widget'));

  // Every block rendered is charged one unit per template in it, which is what bounds a loop
  // over an array liquidjs did not allocate; every block written without a caller's emitter
  // (`capture`) gets a budgeted one, which is what bounds what it can accumulate.
  type RenderTemplates = (templates: unknown[], ctx: Context, emitter?: Emitter) => Generator<unknown, string, unknown>;
  const renderer = engine.renderer as unknown as { renderTemplates: RenderTemplates };
  const original = renderer.renderTemplates;
  renderer.renderTemplates = function* (templates, ctx, emitter) {
    ctx.memoryLimit.use(Math.max(1, templates.length));
    return yield* original.call(this, templates, ctx, emitter ?? new BudgetEmitter(ctx));
  };
  return engine;
}

/**
 * Render a template. Throws on any failure, a template that does not draw each tag exactly once
 * included; the caller decides what a failure means (a refused save, or the built-in page).
 */
export function renderPageTemplate(template: string, variables: PageVariables, parts: PageParts): string {
  const drawn = { head: 0, widget: 0 };
  const engine = engineFor(parts, drawn);
  const html = engine.renderSync(engine.parse(liquidSource(template)), variables as unknown as Record<string, unknown>) as string;
  for (const which of ['head', 'widget'] as const) {
    if (drawn[which] !== 1) {
      throw new Error(`{%- auth0:${which} -%} must be drawn exactly once, and was drawn ${drawn[which]} times`);
    }
  }
  return html;
}

/* ---- judging a template on save ---- */

const SAMPLE_PARTS: PageParts = { head: '<!-- head -->', widget: '<div id="root"></div>' };
const SAMPLE_USER = { name: 'Ada Example', email: 'ada@example.com', picture: 'https://example.com/ada.png' };
const SAMPLE_APPLICATION = { clientId: 'example-client', name: 'Example app', icon: 'https://example.com/logo.png', metadata: {} };

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/**
 * Why a template may not be saved, or `[]`. The messages for size, the required tags and a
 * syntax error are Auth0's own.
 *
 * Beyond parsing, the template is rendered for every screen in both languages — with a signed-in
 * person where the screen has one, and once more on the sign-in screen with one (a re-sign-in) —
 * and a render that throws, or that does not draw each tag exactly once, is refused naming the
 * screen. Request-time data can still differ from the samples, which is what the request-time
 * fallback is for.
 */
export function templateProblems(template: unknown): string[] {
  if (typeof template !== 'string' || !template.trim()) return ['template must be a non-empty string'];
  if (byteLength(template) > MAX_TEMPLATE_BYTES) {
    return [`Payload content length greater than maximum allowed: ${MAX_TEMPLATE_BYTES}.`];
  }
  const tags = new Set([...template.matchAll(AUTH0_TAG)].map((m) => m[2]));
  if (!tags.has('head') || !tags.has('widget')) {
    return ['Payload content missing required Liquid tags (auth0:head and auth0:widget).'];
  }
  try {
    engineFor(SAMPLE_PARTS, { head: 0, widget: 0 }).parse(liquidSource(template));
  } catch (e) {
    return [`Liquid template syntax error: ${messageOf(e)}`];
  }
  const cases: { screen: ScreenName; locale: Locale; signedIn: boolean }[] = [];
  for (const screen of SCREEN_NAMES) {
    for (const locale of LOCALES) cases.push({ screen, locale, signedIn: screen === 'consent' });
  }
  cases.push({ screen: 'login', locale: LOCALES[0], signedIn: true });
  const problems: string[] = [];
  for (const c of cases) {
    try {
      renderPageTemplate(template, sampleVariables(c.screen, c.locale, c.signedIn), SAMPLE_PARTS);
    } catch (e) {
      const problem = `on the ${c.screen} screen (${c.locale}${c.signedIn ? ', signed in' : ''}): ${messageOf(e)}`;
      problems.push(problem);
      if (problems.length >= 3) break;
    }
  }
  return problems;
}

/** The variables a save is judged with, and the console's preview draws with. */
export function sampleVariables(screen: ScreenName, locale: Locale, signedIn: boolean, theme: PageVariableInput['theme'] = {}): PageVariables {
  return pageVariables({
    screen,
    locale,
    application: SAMPLE_APPLICATION,
    theme,
    tenantName: 'Example',
    user: signedIn ? SAMPLE_USER : null,
  });
}

function messageOf(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  // liquidjs's own words for the budget name a resource the author never asked for.
  return message.replace(
    /memory alloc limit exceeded/,
    `the template does more work than a page may (${RENDER_BUDGET.toLocaleString('en')} steps: blocks rendered plus characters written)`,
  );
}

/** A render failure, readable: what a refused save says and what the request-time log records. */
export const renderFailure = messageOf;

/* ---- storage ---- */

export function readPageTemplate(sql: SqlExec): string | null {
  const row = sql.exec('SELECT value FROM config WHERE key = ?', PAGE_TEMPLATE_KEY).toArray()[0] as { value: string } | undefined;
  return row?.value ?? null;
}

/** Store a template already judged by `templateProblems`. Says whether one existed before. */
export function putPageTemplate(sql: SqlExec, template: string): 'created' | 'updated' {
  const existed = readPageTemplate(sql) !== null;
  sql.exec('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', PAGE_TEMPLATE_KEY, template);
  return existed ? 'updated' : 'created';
}

/** Remove the template. Says whether there was one. */
export function deletePageTemplate(sql: SqlExec): boolean {
  const existed = readPageTemplate(sql) !== null;
  sql.exec('DELETE FROM config WHERE key = ?', PAGE_TEMPLATE_KEY);
  return existed;
}

/** A short, non-reversible label for a template in a log line: its size and digest prefix. */
export async function templateFingerprint(template: string): Promise<{ bytes: number; sha256: string }> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(template)));
  return { bytes: byteLength(template), sha256: [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('') };
}

/* ---- the response ---- */

/** A templated page: its HTML and the headers it goes out with. */
export interface TemplatedPage {
  html: string;
  headers: Record<string, string>;
}

/**
 * A templated page, or the reason it could not be drawn — in which case the caller serves the
 * built-in page. `no-store`, because the page may carry the signed-in person's name and address.
 */
export function templatedPage(
  template: string,
  variables: PageVariables,
  images: readonly string[],
  indexHtml: string | undefined,
  preview?: { screen: ScreenName },
): TemplatedPage | { error: string } {
  const nonce = newNonce();
  try {
    return {
      html: renderPageTemplate(template, variables, pageParts(indexHtml, nonce, preview)),
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': pageCsp(nonce, images),
        'cache-control': 'no-store',
      },
    };
  } catch (e) {
    return { error: renderFailure(e) };
  }
}
