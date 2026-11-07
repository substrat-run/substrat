#!/usr/bin/env tsx
/**
 * The error-code pages (#113): one page per code in the closed taxonomy, published at the
 * `type` URI that code's problem documents carry, plus an index.
 *
 * Every refusal the platform answers is an RFC 9457 problem document whose `type` is
 * `https://substrat.net/errors/<code>` (`problemTypeFor`). error-model.md §1 promised that URI
 * resolves "to the docs page describing that failure and what to do about it", and §6 Q2
 * leaned towards generating those pages from the registry. This is that generator:
 * `apps/docs/errors/<code>.md` per code, and `apps/docs/errors/index.md` with the overview.
 *
 * ## What cannot drift, and why
 *
 * The FACTS are read from `packages/contracts/src/errors.ts` itself, never restated: the code
 * list (`errorCode`), each status and title (`PROBLEM_CATALOG`), the `type` URI
 * (`problemTypeFor`), the members a code may carry (`PROBLEM_EXTENSIONS`), the members of the
 * wire body (`problem`), and whether `/openapi.json` documents the code on every operation
 * (`DOCUMENTED_ERROR_CODES`). The example body is rendered by `toProblem`, so it is the
 * serializer's own output.
 *
 * The PROSE — what a code means, when it is returned, what the caller should do — is written
 * here, keyed by code. It is held to the registry in both directions: a code with no prose, prose
 * for a code that does not exist, a wire member with no description, and a description for a
 * member that does not exist all exit 2 before anything is written. A new code is therefore red
 * until somebody has written down what a client should do about it. So is a moved
 * `PROBLEM_TYPE_BASE`, because the pages would stop being at the address the documents name.
 *
 *   pnpm lint:problem-codes            re-emit the pages
 *   pnpm lint:problem-codes --check    CI: exit 1 if a page drifted, is missing, or is stale
 *
 * Exit codes follow boundary-lint's: 0 = in sync, 1 = drift, 2 = cannot run.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './repo-path.mjs';
import {
  DOCUMENTED_ERROR_CODES,
  PROBLEM_CATALOG,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_EXTENSIONS,
  PROBLEM_REASON_MAX,
  PROBLEM_TYPE_BASE,
  PROBLEM_TYPE_BLANK,
  STORE_BODY_MAX_BYTES,
  errorCode,
  problem,
  problemForStatus,
  problemTypeFor,
  substratError,
  toProblem,
  type ErrorCode,
} from '../packages/contracts/src/errors.ts';

const ROOT = repoRoot(import.meta.url);
const SOURCE = 'packages/contracts/src/errors.ts';
const OUT_DIR = 'apps/docs/errors';
/** Where the docs site is served. The pages are only at the `type` URIs if this is their base. */
const SITE_ERRORS = 'https://substrat.net/errors';

const check = process.argv.includes('--check');

/** Exit 2: the tool cannot do its job. Always names the remedy. */
function cannot(message: string): never {
  console.error(`problem-codes: ${message}\n`);
  process.exit(2);
}

interface Guidance {
  /** One sentence. The page's lede and its index line. */
  readonly summary: string;
  readonly means: string;
  readonly when: readonly string[];
  readonly action: string;
  /** Required exactly when the code is NOT documented on every operation: where it is documented. */
  readonly openapi?: string;
}

/** The prose, one entry per code. Written for whoever holds the response, not for the platform. */
const GUIDANCE: Readonly<Record<string, Guidance>> = {
  unauthenticated: {
    summary: 'The request carried no credential this surface accepts.',
    means:
      'The surface could not tell who is calling. There was no session cookie and no bearer token, ' +
      'or the one sent was expired, revoked, or minted for another audience. It is about identity ' +
      'only. Whether a known caller may do something is `permission_denied`.',
    when: [
      'A route behind sign-in was reached with no session and no bearer token.',
      'A bearer token failed verification: expired, signed by an issuer the surface does not trust, or minted for another audience.',
      "The control plane's `/api` was reached without the staff session it expected; `detail` names what was wrong with it.",
    ],
    action:
      'Sign in again or refresh the token, then retry once. The same credential gets the same ' +
      'answer. A browser app treats this as the cue to show sign-in, not as an error to display.',
  },
  permission_denied: {
    summary: 'A permission check refused a caller the surface knows.',
    means:
      'The caller is known, and `ctx.check` said no: no role or grant they hold carries the key the ' +
      'operation checks. `permission` names that key. When the check was made on one record rather ' +
      'than on the whole scope, `entity` names the record. A refusal that more permissions would ' +
      'not change is `forbidden`, the other `403`.',
    when: [
      'The permission check an operation makes before anything else refused.',
      'A per-entity check refused; `entity` is set.',
    ],
    action:
      "Do not retry. The same request is refused until the caller's access changes. Ask whoever " +
      'administers the scope for a role that carries `permission`, or stop offering the action to ' +
      'this user.',
  },
  forbidden: {
    summary: "A policy refused the request, whatever the caller's permissions.",
    means:
      'A rule of the platform or of the surface refused the request. The caller\'s roles did not: ' +
      'granting them more would not change the answer. `reason`, when present, names the rule. A ' +
      'refusal by a permission key is `permission_denied`, the other `403`.',
    when: [
      'A deploy or push the platform refuses.',
      'A sandbox rule: a preview scope asking for an outbound effect, a caller that could not prove what it is, a capability the caller does not hold.',
      'A platform-internal route reached by a caller it does not serve.',
    ],
    action:
      'Do not retry unchanged, and do not ask for a role. Read `detail` and `reason` for the rule, ' +
      'and change what the request asks for. If the rule should not apply to you, raise it with ' +
      'support and quote `requestId`.',
  },
  not_found: {
    summary: 'The addressed thing does not exist, or does not exist for this caller.',
    means:
      'Nothing answers at that address: no such record, route, operation or scope. On a ' +
      'multi-tenant surface this deliberately also covers two other cases. One is a thing that ' +
      'exists under another tenant. The other is an operation the install is not entitled to, where ' +
      'a `403` would confirm the feature exists. A client cannot tell these cases apart, and should ' +
      'not try to.',
    when: [
      'An id that names no record in this scope, or a record in the bin addressed by an operation that does not admit binned records.',
      'An operation the vertical does not declare, or one the install is not entitled to.',
      "A scope with no tenant record, on the control plane (`reason: scope_unrecorded`). A vertical's public edge answers a scope that is not serving with the router's own sentence instead, so a request that raced a suspension reads like one the router refused.",
    ],
    action:
      'Do not retry. Check the id and the route. If the id came from a list, the record may have ' +
      'been deleted or binned since. Treat the thing as absent.',
  },
  conflict: {
    summary: 'The request is well formed, but the current state does not allow it.',
    means:
      'The input is fine. The thing it addresses is in a state where this cannot happen now. ' +
      '`reason` names the rule that refused, and it is the member to branch on.',
    when: [
      'A lifecycle transition the declared machine does not allow from the current state (`reason: invalid_transition`).',
      'A uniqueness rule: a name, slug or hostname already taken.',
      'A tenant or scope that is not active, on the control plane (`reason: scope_not_active`).',
      'An engine invariant, such as a record that is immutable once exported.',
    ],
    action:
      'Re-read the current state, then decide. The same request conflicts again unless something ' +
      'else changes the state first. Branch on `reason`, not on `detail`: the sentence is written ' +
      'for people and may change.',
  },
  validation_failed: {
    summary: 'The input did not parse, or broke a rule about its own values.',
    means:
      'The request is wrong as sent. A parse failure carries `errors`: one entry per field, with a ' +
      'dotted `path` (`lines.0.quantity`) and a `message`, and `detail` reads "the input did not ' +
      'parse". A value that parses but contradicts itself, such as an end date before its start, ' +
      'carries no field list. Its `detail` is the sentence.',
    when: [
      "An operation input that fails its declared schema. The host parses every invocation before the operation's handler runs.",
      "A rule over the input's own values.",
      'A page cursor replayed into a walk that did not mint it (`reason: cursor_restart`).',
    ],
    action:
      'Fix the input and send it again; the same body is refused again. With `errors`, show each ' +
      'message against the field its `path` names. With `reason: cursor_restart`, read the first ' +
      'page again without the cursor.',
  },
  precondition_failed: {
    summary: 'A precondition the caller sent no longer holds.',
    means:
      'The caller made the write conditional, with `If-Match` and the version it read, and the ' +
      'record has changed since. `entity` names the record. The current version is deliberately ' +
      'not in the body: a client that retried with it blindly would overwrite the change that ' +
      'caused the refusal.',
    when: [
      "A write sent with `If-Match` whose version is no longer the record's current one.",
      'A promote whose acknowledged review is no longer the one it would apply (`reason: promote_review_stale`).',
    ],
    action:
      'Re-read the record, show or merge what changed, and send the write again with the version ' +
      'you just read. Never retry with a new version you did not read.',
    openapi:
      'Documented only on the operations that accept a precondition (`If-Match`), since no other ' +
      'operation can answer it.',
  },
  rate_limited: {
    summary: 'The caller is over a request budget.',
    means:
      'Too many requests were counted against one budget within its window. `retryAfter` is the ' +
      'number of seconds to wait, also sent as the `Retry-After` header. The `RateLimit` header ' +
      'names the budget that refused.',
    when: [
      'A request to a hosted vertical over the per-credential or per-client-address budget. The router counts it before the vertical runs.',
      "A request to a node host that mounts `vertical-host`'s `rateLimit()`.",
    ],
    action:
      'Wait for `Retry-After` seconds, then retry. A client that polls should slow its loop instead ' +
      'of retrying at the same pace.',
  },
  unavailable: {
    summary: 'A fact about the deployment, not the request, stopped the answer.',
    means:
      'The request may be fine. Something the platform needs in order to answer it is not in place, ' +
      'or is not answering right now. It is not the caller\'s fault and not a fault in the request.',
    when: [
      'A host started without configuration it needs, such as the key its secrets are sealed with.',
      "A scope store that failed, or answered with a status that has no code of its own. `storeCode` carries the store's own code.",
      "A scope that kept restarting under a module's system door (`reason: system_door_wait`).",
    ],
    action:
      'Retry later, with backoff. A write sent with an `Idempotency-Key` can be retried with the ' +
      'same key without running twice. If it persists, it needs an operator: report it and quote ' +
      '`requestId`.',
  },
  internal: {
    summary: 'The platform failed, and the reason is not sent.',
    means:
      'A throw nobody declared a code for. The body never carries `detail`. A message nobody ' +
      "reviewed may hold another tenant's data, so the sentence goes to the platform's log and " +
      'not to the caller. `requestId` is how the two are joined up again.',
    when: [
      'A throw that declared no code, on a surface that answers one as its own fault: the control plane and the builder. A vertical answers an untyped throw as the caller\'s `400` in the `about:blank` form instead.',
      'A throw that declared `internal` itself.',
    ],
    action:
      'Retry once if the request is safe to repeat: a read, or a write sent with an ' +
      '`Idempotency-Key`. Otherwise report it and quote `requestId`, which the dashboard\'s request ' +
      'view opens.',
  },
};

/** Every member of the wire body (`problem`), described once. Read from its shape, so a new one is red. */
const MEMBERS: Readonly<Record<string, string>> = {
  type: `The canonical identifier: \`${PROBLEM_TYPE_BASE}/<code>\`, the page for that code. \`${PROBLEM_TYPE_BLANK}\` when the body names no code.`,
  title: 'Short and human, and the same for every occurrence of a code. Do not parse it.',
  status: 'The HTTP status, repeated from the status line (RFC 9457 §3.1.2).',
  detail: 'What went wrong this time, as a sentence for a person. Never present on `internal`.',
  instance: 'The path of the request this answers, when the surface knows it.',
  error: 'A deprecated copy of `detail`, kept while older clients still read it. Read `detail`.',
  code: 'The taxonomy entry, one of the codes on this page. The member to `switch` on. Absent exactly when `type` is `about:blank`.',
  requestId: 'The id of the request that failed, the same as its `x-substrat-request-id` header. Quote it when reporting a failure.',
  permission: 'The permission key the check refused.',
  entity: 'The record the refusal is about, as an entity reference (`{ entityType, entityId }`).',
  reason: `A slug the refusing module owns, narrowing the code: snake_case, at most ${PROBLEM_REASON_MAX} characters. Branch on it; never show it.`,
  errors: 'One entry per field that failed to parse: `path`, dotted into the input, and `message`.',
  retryAfter: 'Seconds to wait before retrying, the same value as the `Retry-After` header.',
  storeCode: "The scope store's own error code, when the refusal came from a store. It is the store's vocabulary, not this taxonomy's.",
  storeBody: `The scope store's own error body: only a refusal's (a \`4xx\`), and only up to ${STORE_BODY_MAX_BYTES} bytes of JSON.`,
};

// ── Hold the prose to the registry before anything is written ──────────────────────────────
const CODES = errorCode.options as readonly ErrorCode[];
const missingGuidance = CODES.filter((c) => !(c in GUIDANCE));
const unknownGuidance = Object.keys(GUIDANCE).filter((c) => !(CODES as readonly string[]).includes(c));
if (missingGuidance.length > 0 || unknownGuidance.length > 0) {
  cannot(
    `the prose and the taxonomy disagree.\n` +
      (missingGuidance.length ? `  No prose for: ${missingGuidance.join(', ')}\n` : '') +
      (unknownGuidance.length ? `  Prose for codes that do not exist: ${unknownGuidance.join(', ')}\n` : '') +
      `  Edit GUIDANCE in tools/problem-codes-emit.mts so it has exactly one entry per code in ${SOURCE}.`,
  );
}
const WIRE = Object.keys(problem.shape);
const missingMembers = WIRE.filter((m) => !(m in MEMBERS));
const unknownMembers = Object.keys(MEMBERS).filter((m) => !WIRE.includes(m));
if (missingMembers.length > 0 || unknownMembers.length > 0) {
  cannot(
    `the member descriptions and the wire body disagree.\n` +
      (missingMembers.length ? `  No description for: ${missingMembers.join(', ')}\n` : '') +
      (unknownMembers.length ? `  Described but not on the wire: ${unknownMembers.join(', ')}\n` : '') +
      `  Edit MEMBERS in tools/problem-codes-emit.mts so it describes exactly the members of \`problem\` in ${SOURCE}.`,
  );
}
for (const code of CODES) {
  const documented = DOCUMENTED_ERROR_CODES.includes(code);
  if (documented === (GUIDANCE[code]!.openapi !== undefined)) {
    cannot(
      `${code}: \`openapi\` is written exactly when the code is NOT in DOCUMENTED_ERROR_CODES, and here it ` +
        `${documented ? 'is documented on every operation but carries a note' : 'is not documented on every operation and says nowhere where it is'}.`,
    );
  }
}
if (PROBLEM_TYPE_BASE !== SITE_ERRORS) {
  cannot(
    `PROBLEM_TYPE_BASE is ${PROBLEM_TYPE_BASE}, but these pages are served at ${SITE_ERRORS}.\n` +
      `  The pages must live where every problem document's \`type\` points. Move OUT_DIR, or move the base back.`,
  );
}

// ── Render ─────────────────────────────────────────────────────────────────────────────────
const slugOf = (code: ErrorCode): string => problemTypeFor(code).slice(`${PROBLEM_TYPE_BASE}/`.length);
const membersOf = (code: ErrorCode): string[] => Object.keys(PROBLEM_EXTENSIONS[code].shape);
/** Members every code may carry: listed once on the index, not on every page. */
const COMMON = membersOf(CODES[0]!).filter((m) => CODES.every((c) => membersOf(c).includes(m)));

const MARKER =
  `<!-- GENERATED by tools/problem-codes-emit.mts from ${SOURCE} — do not edit by hand; ` +
  'the prose is in the emitter: edit it there and run `pnpm lint:problem-codes`. -->';

const frontmatter = (fields: Record<string, string>): string =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n${MARKER}\n`;

const statusOf = (code: ErrorCode): number => PROBLEM_CATALOG[code].status;

function codePage(code: ErrorCode): string {
  const g = GUIDANCE[code]!;
  const { status, title } = PROBLEM_CATALOG[code];
  const own = membersOf(code).filter((m) => !COMMON.includes(m));
  const carries = own.length
    ? own.map((m) => `- \`${m}\`: ${MEMBERS[m]}`).join('\n')
    : '- Nothing beyond the members every problem carries.';
  const sharing = CODES.filter((c) => c !== code && statusOf(c) === status);
  return [
    frontmatter({ title: code, description: `The \`${code}\` problem code, ${status} ${title}: ${g.summary}` }),
    `# \`${code}\``,
    '',
    g.summary,
    '',
    '| Status | Title | `type` |',
    '|---|---|---|',
    `| \`${status}\` | ${title} | \`${problemTypeFor(code)}\` |`,
    '',
    sharing.length
      ? `\`${status}\` is also the status of ${sharing.map((c) => `[\`${c}\`](/errors/${slugOf(c)})`).join(', ')}, so switch on \`code\`, not on the status.\n`
      : null,
    '## What it means',
    '',
    g.means,
    '',
    '## When it is returned',
    '',
    g.when.map((w) => `- ${w}`).join('\n'),
    '',
    '## What it carries',
    '',
    carries,
    '',
    `Like every problem, it may also carry ${COMMON.map((m) => `\`${m}\``).join(' and ')}, and the [members every problem has](/errors/#the-body).`,
    '',
    '## What to do',
    '',
    g.action,
    '',
    '## In `/openapi.json`',
    '',
    g.openapi ?? "Documented on every operation's failure responses.",
    '',
    '[Every error code](/errors/)',
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** The example on the index: the serializer's own output, not a hand-written copy of it. */
const EXAMPLE = toProblem(
  substratError('permission_denied', 'permission denied: customer:manage', { permission: 'customer:manage' }),
  '/api/op/customer/update',
);
const BLANK_EXAMPLE = problemForStatus(400, 'the shop is closed on Sundays', '/api/op/shop/checkout');

function indexPage(): string {
  const rows = CODES.map((code) => {
    const { status, title } = PROBLEM_CATALOG[code];
    return `| [\`${code}\`](/errors/${slugOf(code)}) | \`${status}\` | ${title} | ${GUIDANCE[code]!.summary} |`;
  });
  const body = WIRE.map((m) => {
    const carriers = CODES.filter((c) => membersOf(c).includes(m));
    const on =
      carriers.length === 0
        ? ''
        : carriers.length === CODES.length
          ? ' (any code)'
          : ` (${carriers.map((c) => `[\`${c}\`](/errors/${slugOf(c)})`).join(', ')})`;
    return `- \`${m}\`${on}: ${MEMBERS[m]}`;
  });
  return [
    frontmatter({
      title: 'Error codes',
      description:
        'Every Substrat surface answers a refusal as an RFC 9457 problem document with a code from one closed list. What each code means, when it is returned, and what to do.',
    }),
    '# Error codes',
    '',
    `Every Substrat surface answers a refusal as an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem document, served as \`${PROBLEM_CONTENT_TYPE}\`. The \`code\` it carries comes from one closed list, the same on every surface: a module never invents a code, it narrows one with a \`reason\` of its own. Each code has a page here, and the page's address is the \`type\` the document carries, so a refusal links to its own explanation.`,
    '',
    '```json',
    JSON.stringify(EXAMPLE, null, 2),
    '```',
    '',
    '## The codes',
    '',
    '| `code` | Status | Title | Means |',
    '|---|---|---|---|',
    ...rows,
    '',
    'Switch on `code`, never on the status or the sentence. Two codes share `403`, and `detail` is written for people.',
    '',
    '## The body',
    '',
    'The members a problem may carry. A member with codes beside it appears only on those codes; the rest may appear on any problem.',
    '',
    body.join('\n'),
    '',
    '## A body with no `code`',
    '',
    `When a surface has a status and nothing else, the body is RFC 9457's \`${PROBLEM_TYPE_BLANK}\` form. That happens when it relays a refusal raised somewhere else, or answers a throw nobody typed. The \`title\` is the status phrase and \`code\` is absent:`,
    '',
    '```json',
    JSON.stringify(BLANK_EXAMPLE, null, 2),
    '```',
    '',
    'The absence is the answer, not an omission. A client switching on `code` falls through to its default branch instead of matching a code that would be a guess. Handle it by the status, and show `detail`.',
    '',
    '## Where this comes from',
    '',
    `The codes, statuses, titles and members on these pages are read from \`@substrat-run/contracts\` (\`errors.ts\`), the same registry every surface renders its problems from, and CI fails if a page falls behind it. [What a good API looks like](/concepts/api-design#_5-failures-are-data) explains why failures are part of the surface.`,
    '',
  ].join('\n');
}

const emitted = new Map<string, string>([['index.md', indexPage()]]);
for (const code of CODES) emitted.set(`${slugOf(code)}.md`, codePage(code));

// ── Write, or compare ──────────────────────────────────────────────────────────────────────
const dir = join(ROOT, OUT_DIR);
const present = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
const stale = present.filter((f) => !emitted.has(f));
const drifted = [...emitted].filter(([file, text]) => {
  const path = join(dir, file);
  return !existsSync(path) || readFileSync(path, 'utf8') !== text;
});

if (check) {
  if (drifted.length === 0 && stale.length === 0) {
    console.log(`problem-codes: ${emitted.size} page(s) in ${OUT_DIR} are in sync with ${SOURCE}.`);
    process.exit(0);
  }
  console.error(
    `problem-codes: ${OUT_DIR} has drifted from ${SOURCE}.\n` +
      drifted.map(([f]) => `  ${OUT_DIR}/${f}: differs from what the registry renders, or is missing\n`).join('') +
      stale.map((f) => `  ${OUT_DIR}/${f}: names no code in the taxonomy\n`).join('') +
      `\n  Edit the registry or the prose in tools/problem-codes-emit.mts, then run:\n\n` +
      `      pnpm lint:problem-codes\n\n` +
      `  and commit the re-emitted pages.\n`,
  );
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
for (const [file, text] of drifted) writeFileSync(join(dir, file), text);
for (const file of stale) rmSync(join(dir, file));
console.log(
  drifted.length === 0 && stale.length === 0
    ? `problem-codes: ${OUT_DIR} already in sync.`
    : `problem-codes: wrote ${drifted.length} and removed ${stale.length} page(s) in ${OUT_DIR}.`,
);
