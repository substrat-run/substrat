#!/usr/bin/env node
/**
 * A route answers a refusal as a problem document, or this says where it does not (#113).
 *
 * Every surface's refusals are meant to be RFC 9457 problem documents served as
 * `application/problem+json`, and phase 6 of error-model.md converted them surface by surface,
 * each with its own scan of its own files (control-plane-api's `problem-source.test.ts`,
 * vertical-host's and the builder's `refusals-problem.test.ts`, …). Nothing held the repo as a
 * whole: a refusal written in a file no package scan reads, or in a package added later, merged
 * green. This is that gate, and its allowlist is the list of what is still left.
 *
 * ## What it judges
 *
 * A response built with a LITERAL status of 400 or more:
 *
 * - `c.json(…, 4xx)`, `c.text(…, 4xx)`, `c.body(…, 4xx)`, `c.html(…, 4xx)`, `c.newResponse(…, 4xx)`
 *   (a ternary with a refusal branch counts), and each of them with an inline `ResponseInit`,
 *   `c.json(…, { status: 4xx })`;
 * - `c.status(4xx)`, which sets the status for a body written separately;
 * - `new Response(…, { status: 4xx })` and `Response.json(…, { status: 4xx })`.
 *
 * Such a call keeps the rule when it serves the problem media type itself: it names
 * `PROBLEM_CONTENT_TYPE`, or the `application/problem+json` literal, in its own arguments. That
 * is what every problem helper's serializer does (vertical-host's `serveProblem`,
 * control-plane-api's `problem`, the builder's and the control-plane worker's `problem.ts`), so
 * a route that refuses through a helper is never seen here: it passes no literal status.
 *
 * ## What it does not judge, stated rather than hidden
 *
 * - **A status that is not a literal.** `c.json(body, status)` with `status` computed, or a
 *   `Response` init held in a variable, is out of its sight, the same as the problem helpers'
 *   own serializers, which take the status as a parameter. The per-package scans named above
 *   are the stricter half where they exist: they refuse a computed status outright.
 * - **A throw.** `onError` renders those (`problemResponse`, `mapError`), so a route that throws
 *   a `SubstratError` or an `HTTPException` already answers a problem.
 * - **What is not route code:** tests, fixtures, `vitest.config.*`, the test-support packages
 *   (`contract-tests`, `engine-test-kit`), browser apps (`web/`, `app/`), generated files, and
 *   `tools/`, `scripts/`, `spikes/`, `examples/`.
 *
 * ## The allowlist
 *
 * `ALLOWED` names every file that still answers a refusal outside the helpers, how many sites it
 * has, and why. Two kinds:
 *
 * - **`protocol`**: a body another specification owns, which a problem document would break:
 *   OAuth 2.0 (RFC 6749/6750) error bodies, MCP's JSON-RPC errors, the scope-store driver wire,
 *   a third-party API's stand-in, and pages written for a person in a browser.
 * - **`pending`**: not converted yet. Grouped by owner area, so a slice that converts one area
 *   deletes its group.
 *
 * The count is exact, both ways. A file with MORE sites than its entries allow is red, so an
 * allowlisted file cannot quietly grow a new refusal. A file with FEWER is red too, so the PR
 * that converts a site has to lower the count or delete the entry, and the list only shrinks.
 *
 *   pnpm lint:problem-refusals          exit 1 on an offence or a stale entry
 *   pnpm test:problem-refusals          the predicate's own fixtures
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseTypeScript } from '@babel/parser';
import { isMainModule, repoRoot } from './repo-path.mjs';

/** Where route code lives. */
const ROOTS = ['apps', 'packages', 'demos', 'connectors', 'engines'];

/** Packages whose `src/` is test support, not a surface: their responses are fakes a suite drives. */
const TEST_SUPPORT = ['packages/contract-tests/', 'packages/engine-test-kit/'];

/** Is `path` route code this gate reads? */
export function inScope(path) {
  if (!ROOTS.some((r) => path.startsWith(`${r}/`))) return false;
  if (!/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(path) || /\.d\.[mc]?ts$/.test(path)) return false;
  if (/(?:^|\/)(?:test|tests|__tests__|e2e|fixtures|dist|node_modules|web|app|scripts)\//.test(path)) return false;
  if (/\.(?:test|spec)\.[mc]?[jt]sx?$/.test(path) || /\.generated\./.test(path)) return false;
  if (/(?:^|\/)vitest\.[^/]*config\.[mc]?[jt]s$/.test(path)) return false;
  return !TEST_SUPPORT.some((p) => path.startsWith(p));
}

/** Hono's response builders, whose second argument is the status or a `ResponseInit`. */
const STATUS_SECOND = new Set(['json', 'text', 'body', 'html', 'newResponse']);
const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/**
 * A file that can build a response at all: the parse is skipped for the rest. A builder call may
 * carry type arguments (`c.json<Body>(…)`), so `<` is as good as `(`.
 */
const MAY_RESPOND = /Response|\.(?:json|text|body|html|newResponse|status)\s*[<(]/;

/**
 * Parse as TypeScript, with JSX only where a file can hold it: under the `jsx` plugin a `.ts`
 * file's `<T>x` assertion is a syntax error.
 */
function parse(text, path) {
  const plugins = /\.[mc]?[jt]sx$/.test(path) ? ['typescript', 'jsx'] : ['typescript'];
  try {
    return parseTypeScript(text, { sourceType: 'module', plugins, errorRecovery: true });
  } catch (err) {
    throw new Error(`${path}: cannot be parsed, so its refusals cannot be judged (${err.message})`, { cause: err });
  }
}

/** Every node under `node`, depth first. */
function* walk(node) {
  if (!node || typeof node.type !== 'string') return;
  yield node;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'comments') continue;
    if (Array.isArray(value)) for (const child of value) yield* walk(child);
    else if (value && typeof value === 'object') yield* walk(value);
  }
}

/** `404 as ContentfulStatusCode`, `(404)`, `404!` — the literal under a type-only wrapper. */
function unwrap(node) {
  let n = node;
  while (n && ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'TSTypeAssertion'].includes(n.type)) {
    n = n.expression;
  }
  return n;
}

/** A literal refusal status, or a ternary with one in a branch. */
function isRefusalStatus(node) {
  const n = unwrap(node);
  if (!n) return false;
  if (n.type === 'ConditionalExpression') return isRefusalStatus(n.consequent) || isRefusalStatus(n.alternate);
  return n.type === 'NumericLiteral' && n.value >= 400 && n.value <= 599;
}

/** The `status` property of an inline `ResponseInit`. */
function statusOfInit(init) {
  const n = unwrap(init);
  if (n?.type !== 'ObjectExpression') return undefined;
  const prop = n.properties.find(
    (p) => p.type === 'ObjectProperty' && !p.computed && (p.key.name ?? p.key.value) === 'status',
  );
  return prop?.value;
}

/** Does this call serve the problem media type itself? */
function namesProblemType(call) {
  for (const arg of call.arguments) {
    for (const n of walk(arg)) {
      if (n.type === 'Identifier' && n.name === 'PROBLEM_CONTENT_TYPE') return true;
      if (n.type === 'StringLiteral' && n.value.includes(PROBLEM_MEDIA_TYPE)) return true;
      if (n.type === 'TemplateElement' && n.value.raw.includes(PROBLEM_MEDIA_TYPE)) return true;
    }
  }
  return false;
}

/** The refusal status a response-building call sets, if it sets a literal one. */
function refusalStatusOf(n) {
  if (n.type === 'NewExpression' && n.callee.type === 'Identifier' && n.callee.name === 'Response') {
    return statusOfInit(n.arguments[1]);
  }
  if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.computed) return undefined;
  const name = n.callee.property.name;
  if (name === 'json' && n.callee.object.type === 'Identifier' && n.callee.object.name === 'Response') {
    return statusOfInit(n.arguments[1]);
  }
  if (STATUS_SECOND.has(name)) {
    // `c.json(body, { status: 404, headers })` is the same refusal as `c.json(body, 404)`.
    const second = n.arguments[1];
    return unwrap(second)?.type === 'ObjectExpression' ? statusOfInit(second) : second;
  }
  if (name === 'status' && n.arguments.length === 1) return n.arguments[0];
  return undefined;
}

/**
 * The refusals in `source` answered outside the problem helpers, as `{ line, what }`. `path`
 * decides the parser's plugins and names the file when it cannot be parsed, which throws.
 */
export function refusalsIn(source, path = 'source.ts') {
  const found = [];
  for (const n of walk(parse(source, path).program)) {
    const status = refusalStatusOf(n);
    if (status === undefined || !isRefusalStatus(status) || namesProblemType(n)) continue;
    found.push({ line: n.loc.start.line, what: source.slice(n.start, n.end).replace(/\s+/g, ' ').slice(0, 100) });
  }
  return found;
}

/**
 * Every file that still answers a refusal outside the problem helpers, by owner area. `sites` is
 * exact; a file may have several entries (one per kind) and is held to their sum.
 */
export const ALLOWED = [
  // ── protocol: a body another specification owns ─────────────────────────────────────────────
  {
    area: 'social relay',
    path: 'apps/social-relay/src/routes.ts',
    sites: 5,
    kind: 'protocol',
    reason: '`/:provider/token`: RFC 6749 §5.2 error bodies an OAuth client parses',
  },
  {
    area: 'dev-issuer',
    path: 'packages/dev-issuer/src/issuer.ts',
    sites: 3,
    kind: 'protocol',
    reason: '`/authorize`: a page for the person signing in — RFC 6749 §4.1.2.1 forbids redirecting a bad `redirect_uri` — and the persona picker',
  },
  {
    area: 'vertical-host',
    path: 'packages/vertical-host/src/mcp.ts',
    sites: 5,
    kind: 'protocol',
    reason: 'the MCP endpoint: JSON-RPC 2.0 error objects, the body an MCP client parses',
  },
  {
    area: 'vertical-host',
    path: 'packages/vertical-host/src/public-surface.ts',
    sites: 1,
    kind: 'protocol',
    reason: 'a refused CORS preflight: a bare 403 with no body, which no browser reads',
  },
  {
    area: 'vertical-auth',
    path: 'packages/vertical-auth/src/mcp-discovery.ts',
    sites: 1,
    kind: 'protocol',
    reason: 'a bodiless 405 with `Allow` (RFC 9110 §15.5.6) on the MCP discovery document',
  },
  {
    area: 'scope-store driver wire',
    path: 'packages/control-plane-api/store-entry/entry.ts',
    sites: 1,
    kind: 'protocol',
    reason: 'the store entry refusing a call addressed to another object: store wire (D-69), read by the router, never by an API client',
  },
  {
    area: 'scope-store driver wire',
    path: 'packages/control-plane-api/store-entry/counter.ts',
    sites: 3,
    kind: 'protocol',
    reason: "the test driver's refusal and failure answers, in the store envelope a driver must answer with",
  },
  {
    area: 'scope-store driver wire',
    path: 'apps/vertical-egress/src/worker.ts',
    sites: 1,
    kind: 'protocol',
    reason: "a store call's bad envelope, answered in the store envelope the router reads",
  },
  {
    area: 'connectors',
    path: 'connectors/fortnox/src/mock.ts',
    sites: 16,
    kind: 'protocol',
    reason: "a stand-in for Fortnox's API: it answers Fortnox's own error shape, which the connector parses",
  },
  {
    area: 'builder',
    path: 'apps/builder/src/worker.ts',
    sites: 2,
    kind: 'protocol',
    reason: 'the sign-in refusal pages: HTML for a person in a browser, not an API answer',
  },
  {
    area: 'control plane',
    path: 'apps/control-plane/src/cli-auth.ts',
    sites: 1,
    kind: 'protocol',
    reason: "the CLI login broker's browser-facing GET: a text page for a person, not an API answer",
  },
  {
    area: 'demo assets',
    path: 'demos/auth-server/src/assets.ts',
    sites: 1,
    kind: 'protocol',
    reason: 'a static file the inlined app does not have: a 404 for a browser fetching an asset',
  },
  {
    area: 'demo assets',
    path: 'demos/manyfold/src/assets.ts',
    sites: 1,
    kind: 'protocol',
    reason: 'a static file the inlined app does not have: a 404 for a browser fetching an asset',
  },

  // ── pending: not converted yet, and in no open PR ──────────────────────────────────────────
  {
    area: 'router',
    path: 'apps/router/src/worker.ts',
    sites: 4,
    kind: 'pending',
    reason: "the hostname refusals (no serving scope, no binding, no secret) answer text/plain, while a vertical answers the same 404 as a problem",
  },
  {
    area: 'vertical-host',
    path: 'packages/vertical-host/src/index.ts',
    sites: 1,
    kind: 'pending',
    reason: '`/internal/connector-attachment/:id` answers a missing attachment with a bare 404 and no body',
  },
  {
    area: 'vertical-auth',
    path: 'packages/vertical-auth/src/oidc-rp-provider.ts',
    sites: 1,
    kind: 'pending',
    reason: 'an `/api/auth/*` path the instance does not serve answers `{ error, issuer }` as application/json',
  },
  {
    area: 'scaffold template',
    path: 'packages/create-substrat/template/src/server.ts',
    sites: 1,
    kind: 'pending',
    reason: "the dev server's 401 answers `{ error }`; a vertical cannot reach vertical-host's `refuse` yet, it is not exported",
  },
  {
    area: 'scaffold template',
    path: 'packages/create-substrat/template/src/worker.ts',
    sites: 1,
    kind: 'pending',
    reason: "the worker's unknown-`/api` 404 answers `{ error }`, as the dev server's 401 does",
  },
  {
    area: 'scaffold template',
    path: 'apps/builder/evals/todo/golden/src/server.ts',
    sites: 1,
    kind: 'pending',
    reason: "the eval golden mirrors the template's dev server, so it follows the template's conversion",
  },
  {
    area: 'demo: todo',
    path: 'demos/todo/src/app.ts',
    sites: 1,
    kind: 'pending',
    reason: 'the 401 for a request with no caller answers `{ error }`',
  },
  {
    area: 'demo: handlebar',
    path: 'demos/handlebar/src/server.ts',
    sites: 1,
    kind: 'pending',
    reason: 'the 401 for a request with no caller answers `{ error }`',
  },
  {
    area: 'demo: manyfold',
    path: 'demos/manyfold/src/server.ts',
    sites: 1,
    kind: 'pending',
    reason: 'the 401 for a request with no caller answers `{ error }`',
  },
  {
    area: 'demo: manyfold',
    path: 'demos/manyfold/src/worker.ts',
    sites: 1,
    kind: 'pending',
    reason: 'the unknown-`/api` 404 answers `{ error }`',
  },
  {
    area: 'demo: meridian',
    path: 'demos/meridian/src/server.ts',
    sites: 3,
    kind: 'pending',
    reason: 'the unknown-operation and not-found 404s and the reconcile 500 answer `{ error }`',
  },
  {
    area: 'demo: meridian',
    path: 'demos/meridian/src/worker.ts',
    sites: 3,
    kind: 'pending',
    reason: 'the 501 catch-all and the unknown-operation and not-found 404s answer `{ error }`',
  },
  {
    area: 'demo: ticket0',
    path: 'demos/ticket0/src/server.ts',
    sites: 1,
    kind: 'pending',
    reason: 'the 401 for a request with no caller answers `{ error }`',
  },
  {
    area: 'demo: ticket0',
    path: 'demos/ticket0/src/worker.ts',
    sites: 4,
    kind: 'pending',
    reason: 'the relay and catch-all 404s, the ingest 500 and the 501 catch-all answer `{ error }`',
  },
  {
    area: 'demo: tock',
    path: 'demos/tock/src/server.ts',
    sites: 8,
    kind: 'pending',
    reason: 'the 401 and the upload and run refusals (400, 409, 500) answer `{ error }`',
  },
  {
    area: 'demo: auth-server',
    path: 'demos/auth-server/src/admin-api.ts',
    sites: 1,
    kind: 'pending',
    reason: "the admin API's not-found 404 answers `{ error }`",
  },
  {
    area: 'demo: auth-server',
    path: 'demos/auth-server/src/routes.ts',
    sites: 2,
    kind: 'pending',
    reason: 'the social-relay-secret 409 and the 501 catch-all answer `{ error }`',
  },
  {
    area: 'demo: auth-server',
    path: 'demos/auth-server/src/server.ts',
    sites: 1,
    kind: 'pending',
    reason: "the places 401 answers `{ error }`",
  },
];

/**
 * Judge `files` ([{ path, text }]) against `allowed`. Returns the offences, as lines to print,
 * and the allowlisted totals by kind.
 */
export function judge(files, allowed = ALLOWED) {
  const offences = [];
  const budget = new Map();
  const totals = { protocol: 0, pending: 0 };
  for (const e of allowed) {
    const fault = entryFault(e);
    if (fault) {
      offences.push(`ALLOWED entry ${JSON.stringify(e.path ?? null)}: ${fault}`);
      continue;
    }
    budget.set(e.path, (budget.get(e.path) ?? 0) + e.sites);
    totals[e.kind] += e.sites;
  }
  const seen = new Set();
  for (const { path, text } of files) {
    if (!inScope(path)) continue;
    if (budget.has(path)) seen.add(path);
    let found = [];
    // A file that builds no response has no refusal, and an entry for it is held to zero.
    if (MAY_RESPOND.test(text)) {
      try {
        found = refusalsIn(text, path);
      } catch (err) {
        offences.push(
          `${err.message}\n    Babel's TypeScript parser refuses some valid TypeScript, such as an arrow function with ` +
            'a return type in a ternary branch: parenthesize that expression.',
        );
        continue;
      }
    }
    const allowedHere = budget.get(path) ?? 0;
    if (found.length > allowedHere) {
      offences.push(
        allowedHere === 0
          ? found.map((f) => `${path}:${f.line}  ${f.what}`).join('\n')
          : `${path}: ${found.length} refusal(s) outside the problem helpers, ALLOWED says ${allowedHere}:\n` +
              found.map((f) => `    ${path}:${f.line}  ${f.what}`).join('\n'),
      );
    } else if (found.length < allowedHere) {
      offences.push(
        `${path}: ALLOWED says ${allowedHere} site(s), the file has ${found.length} — lower \`sites\`, or delete the entry once none is left`,
      );
    }
  }
  for (const path of budget.keys()) {
    if (!seen.has(path)) offences.push(`${path}: an ALLOWED entry for a file that is gone or out of scope — delete it`);
  }
  return { offences, totals };
}

/** What is wrong with one ALLOWED entry, or `undefined`. */
function entryFault(e) {
  if (e.kind !== 'protocol' && e.kind !== 'pending') return `kind must be 'protocol' or 'pending', not ${JSON.stringify(e.kind)}`;
  for (const field of ['path', 'area', 'reason']) {
    if (typeof e[field] !== 'string' || e[field].trim() === '') return `\`${field}\` must be a non-empty string`;
  }
  if (!Number.isInteger(e.sites) || e.sites < 1) return '`sites` must be a whole number of at least 1 — delete an entry with none left';
  return undefined;
}

/** The tracked and untracked (not ignored) files under the roots. */
function sourceFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...ROOTS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((p) => p && inScope(p))
    .map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
}

if (isMainModule(import.meta.url)) {
  const root = repoRoot(import.meta.url);
  const files = sourceFiles(root);
  if (files.length === 0) {
    console.error('problem-refusals: no route source found under the roots — a gate that read nothing.');
    process.exit(2);
  }
  const { offences, totals } = judge(files);
  if (offences.length > 0) {
    console.error(`problem-refusals: refusals answered outside the problem helpers (#113):\n`);
    for (const o of offences) console.error(`  ${o}`);
    console.error(
      '\n  A route refuses through a problem helper, so the caller gets `application/problem+json` with a\n' +
        '  `code` from the closed taxonomy (substrat.net/errors): vertical-host\'s `problemResponse` or a\n' +
        '  thrown `substratError(code, …)`, control-plane-api\'s `refuse` / `refuseStatus`, or the\n' +
        "  `problem.ts` helpers of apps/control-plane and apps/builder. A body another specification\n" +
        '  owns (OAuth, JSON-RPC, a page for a person) goes in ALLOWED in tools/problem-refusals.mjs\n' +
        '  with its reason; a site you converted lowers its entry\'s `sites`.',
    );
    process.exit(1);
  }
  console.log(
    `problem-refusals: ${files.length} source file(s) read; every refusal outside the problem helpers is allowlisted ` +
      `(${totals.pending} pending conversion, ${totals.protocol} owned by another protocol)`,
  );
}
