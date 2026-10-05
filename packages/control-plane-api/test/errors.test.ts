import { describe, expect, it } from 'vitest';
import { AUTO_ADMISSION_NOTE, SCOPE_GATE_REASONS, substratError, type ErrorCode } from '@substrat-run/contracts';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { mapError } from '../src/errors.js';

/**
 * The message→status table is this package's weakest seam (errors.ts says so itself), and
 * its failure mode is silent: an unmatched refusal does not throw, it becomes a generic
 * 500 with the reason stripped off. #828 is the recorded cost of that — four hours of
 * `internal error` hiding a throw that named its own fix in full.
 *
 * So the patterns that carry a WAY OUT get pinned here, directly against `mapError`,
 * rather than only through whichever route happens to reach them.
 */
describe('mapError — a refusal that names its fix must survive as itself', () => {
  // The exact text both adapters throw (adapter-sqlite `setVerticalListed`,
  // adapter-cloudflare `host.ts` — identical strings), typed `conflict` by both and pinned
  // on that code by the contract suite. Its pattern row is gone (#113 phase 5), so a throw
  // reaches `mapError` carrying the code, as the adapters now raise it.
  const autoAdmitRefusal = substratError(
    'conflict',
    `vertical 'substrat-9yjbbn/auth-server' prod version 01KZN76M38AWJ9KHE6RWVFSC8W is auto-admitted ` +
      `(private self-serve) — a staff admit must vouch for it before listing`,
  );

  it('answers the publish-seam refusal 409, with its text intact', () => {
    const { status, body } = mapError(autoAdmitRefusal);
    // 409: the request is well-formed and conflicts with the version's admission state —
    // the same class as the registry's other admission refusals.
    expect(status).toBe(409);
    // The whole point: the operator must be able to READ what to do next. A 409 whose
    // body said `internal error` would be no better than the 500 it replaced.
    expect(body.error).toBe(autoAdmitRefusal.message);
    expect(body.error).toMatch(/auto-admitted.*staff admit/);
  });

  it('is not mistaken for the neighbouring "already admitted" refusal', () => {
    // `rejectVersion`'s `is already admitted` describes a DIFFERENT state, and both are
    // `conflict` now by their own declaration — so the sentence an operator reads is the
    // throw's, never a guess from the other's wording. Admitted is not the same as vouched for.
    const rejectRefusal = substratError('conflict', 'version 01J is already admitted — it may be bound');
    expect(mapError(autoAdmitRefusal).body.detail).toMatch(/auto-admitted.*staff admit/);
    expect(mapError(autoAdmitRefusal).body.detail).not.toMatch(/already admitted/);
    expect(mapError(rejectRefusal).body.detail).toBe(rejectRefusal.message);
  });

  it('keeps the note itself out of the matching — the text is the contract, not the constant', () => {
    // A version merely CARRYING the auto note is not a refusal; only `setVerticalListed`
    // throwing about it is. Guards against someone "simplifying" the pattern to the
    // constant, which appears in payloads the API returns on success.
    expect(mapError(new Error(AUTO_ADMISSION_NOTE)).status).toBe(500);
  });

  it('still refuses to disclose an unreviewed throw', () => {
    // The posture errors.ts commits to: unmatched means unreviewed, and this surface has
    // cross-tenant reach. Adding patterns must never erode the generic fallback.
    const leaky = new Error('SQLITE_CONSTRAINT: tenant_secrets.value must be unique');
    const { status, body } = mapError(leaky);
    expect(status).toBe(500);
    expect(body.code).toBe('internal');
    // The whole rule, in one assertion: `internal` never carries `detail`, and the
    // constant the deprecated duplicate answers with is OURS, not the throw's.
    expect(body.detail).toBeUndefined();
    expect(body.error).toBe('internal error');
    expect(JSON.stringify(body)).not.toMatch(/tenant_secrets/);
  });

  it('renders a throw that declared its code from the declaration, not from the table', () => {
    // #113 phase 4. The table is what is LEFT: a typed throw never reaches it, and
    // arrives carrying the extensions its throw site declared.
    const declared = substratError('conflict', 'version 01J is already admitted', {
      reason: 'already_admitted',
    });
    const { status, body } = mapError(declared);
    expect(status).toBe(409);
    expect(body.code).toBe('conflict');
    expect(body.reason).toBe('already_admitted');
  });

  it('reads `unknown vertical` from the code now that the pattern row is gone (#113 phase 5)', () => {
    // The first family migrated off `CODE_PATTERNS`. Both adapters throw this typed, so
    // the 404 comes from the DECLARATION — and, unlike a pattern match, it survives any
    // rewording of the sentence.
    const typed = mapError(substratError('not_found', `unknown vertical 'ghost'`));
    expect(typed.status).toBe(404);
    expect(typed.body.code).toBe('not_found');
    expect(typed.body.detail).toBe(`unknown vertical 'ghost'`);

    // The other half, and the reason the row could only go AFTER the throws were typed:
    // the same sentence untyped is now an unreviewed throw, and gets the generic 500.
    // That is the deletion being real rather than cosmetic — and it is what makes a
    // future untyped `unknown vertical` visible instead of quietly correct.
    expect(mapError(new Error(`unknown vertical 'ghost'`)).status).toBe(500);
  });

  it('reads `unknown version` from the code now that the pattern row is gone (#113 phase 5)', () => {
    // The second family off `CODE_PATTERNS`, and the sibling of the one above: same code,
    // same two adapter files, same null-check-after-a-read shape. Ten throw sites, five
    // per adapter, across admitVersion / rejectVersion / promoteVersion / bindScopeVersion
    // / versionManifest.
    const typed = mapError(substratError('not_found', `unknown version ${'01ABC'}`));
    expect(typed.status).toBe(404);
    expect(typed.body.code).toBe('not_found');
    expect(typed.body.detail).toBe(`unknown version 01ABC`);

    // versionManifest's variant refuses on the (vertical, version) PAIR and carries the
    // slug in its sentence. It is the same code — the row matched both, and so does this.
    const paired = mapError(substratError('not_found', `unknown version 01ABC for vertical 'callout'`));
    expect(paired.status).toBe(404);
    expect(paired.body.detail).toBe(`unknown version 01ABC for vertical 'callout'`);

    // The other half: untyped, the same sentence is now an unreviewed throw and gets the
    // generic 500. This is what makes the deletion real rather than cosmetic, and what
    // makes a future untyped `unknown version` visible instead of quietly correct.
    expect(mapError(new Error(`unknown version 01ABC`)).status).toBe(500);
  });

  it('reads `deploy refused:` from the code now that the pattern row is gone (#113 phase 5)', () => {
    // The third family off `CODE_PATTERNS`, and the first whose throw is not in an adapter:
    // `assertSandboxContract` (deploy.ts) raises it in this package, so the real error
    // object reaches `mapError` with no Durable Object hop to fold its `name` away.
    const sentence = `deploy refused: binding 'X' (type 'service') — nope (self-serve-deploy.md §4)`;
    const typed = mapError(substratError('forbidden', sentence));
    expect(typed.status).toBe(403);
    expect(typed.body.code).toBe('forbidden');
    expect(typed.body.detail).toBe(sentence);

    // The other half: untyped, the same sentence is an unreviewed throw and gets the generic
    // 500. This is what makes the deletion real — and `deploy.test.ts` is what proves the
    // throw itself is typed, since THIS case would pass whatever `assertSandboxContract` did.
    expect(mapError(new Error(sentence)).status).toBe(500);
  });

  it('reads BOTH `still backs` refusals from the code — the archived one never matched (#113 phase 5)', () => {
    // The fourth family off `CODE_PATTERNS`, and the one that was carrying a live defect.
    // `deleteVertical` refuses twice on each adapter, and the row read
    // `/still backs \d+ scope\(s\)/` — which the archived sentence does NOT match, because
    // `archived` sits between the digits and `scope(s)`. No other row caught it, so it fell
    // through to the generic 500: an operator who archived an app and then deleted its
    // vertical was told `internal error` instead of how to proceed.
    const live = `vertical 'fsm' still backs 1 scope(s) — delete or rebind them first`;
    const archived = `vertical 'fsm' still backs 1 archived scope(s) — reap or restore them first`;

    for (const sentence of [live, archived]) {
      const typed = mapError(substratError('conflict', sentence));
      expect(typed.status).toBe(409);
      expect(typed.body.code).toBe('conflict');
      expect(typed.body.detail).toBe(sentence);
    }

    // The old row, spelled out, so the defect cannot be re-introduced as an "equivalent"
    // regex: it matched the live sentence and missed its sibling.
    expect(/still backs \d+ scope\(s\)/.test(live)).toBe(true);
    expect(/still backs \d+ scope\(s\)/.test(archived)).toBe(false);

    // The other half: untyped, either sentence is an unreviewed throw and gets the generic
    // 500 — which is what makes the deletion real rather than cosmetic.
    expect(mapError(new Error(live)).status).toBe(500);
    expect(mapError(new Error(archived)).status).toBe(500);
  });

  it('reads `was rejected — publish a new one` from the code now that the pattern row is gone (#113 phase 5)', () => {
    // The fifth family off `CODE_PATTERNS`: `admitVersion` refusing a rejected version,
    // one site per adapter. Both throw on the coordinator, so the real error object
    // reaches `mapError` with no Durable Object hop to fold its `name` away.
    const sentence = `version 01ABC was rejected — publish a new one`;
    const typed = mapError(substratError('conflict', sentence));
    expect(typed.status).toBe(409);
    expect(typed.body.code).toBe('conflict');
    expect(typed.body.detail).toBe(sentence);

    // The other half: untyped, the same sentence is an unreviewed throw and gets the generic
    // 500 — what makes the deletion real. The contract suite is what proves the throws are
    // typed, since THIS case would pass whatever the adapters did.
    expect(mapError(new Error(sentence)).status).toBe(500);
  });

  it('reads the registry\'s own refusals from the code now that their rows are gone (#113 phases 5–6)', () => {
    // The sixth to tenth families off `CODE_PATTERNS`: `is owned by`, `is auto-admitted`,
    // `not admitted`, and — `rejectVersion` / `promoteVersion` — `is already admitted` and `belongs to`. Every
    // site is on the coordinator (`host.ts`, `adapter-sqlite`) — none is raised inside a
    // Durable Object — so the real error object reaches `mapError` and the code is read.
    const sentences = [
      `vertical 'helpdesk' is owned by 01AAA, not 01BBB`,
      `vertical 'helpdesk' is owned by the platform, not 01BBB`,
      `vertical 'crm' prod version 01ABC is auto-admitted (private self-serve) — a staff admit must vouch for it before listing`,
      `version 01ABC is pending, not admitted — it cannot be bound to a scope`,
      `version 01ABC is rejected, not admitted — it cannot be promoted`,
      `version 01ABC is already admitted — it may be bound`,
      `version 01ABC belongs to 'helpdesk'`,
    ];
    for (const sentence of sentences) {
      const typed = mapError(substratError('conflict', sentence));
      expect(typed.status).toBe(409);
      expect(typed.body.code).toBe('conflict');
      expect(typed.body.detail).toBe(sentence);

      // The other half: untyped, the same sentence is an unreviewed throw and gets the
      // generic 500 — what makes the deletion real. The contract suite is what proves the
      // throws are typed, since THIS case would pass whatever the adapters did.
      expect(mapError(new Error(sentence)).status).toBe(500);
    }
  });

  it('relays a downstream status as about:blank — our taxonomy is not theirs to wear', () => {
    // auth-server's honest 501 for an unimplemented verb (the 2026-07-25 shape). The
    // status is the vertical's; putting a code of ours on it would be a claim we cannot
    // make about someone else's refusal.
    const { status, body } = mapError(new ControlPlaneError(501, 'not implemented'));
    expect(status).toBe(501);
    expect(body.type).toBe('about:blank');
    expect(body.code).toBeUndefined();
    expect(body.error).toBe('not implemented');
  });
});

describe('mapError — a ScopeDO refusing a projection for another tenant (#1738)', () => {
  const sentence =
    'applyProjection refused: this scope was provisioned for tenant 01AAA, and a projection for tenant 01BBB would re-point it';

  it('answers 409 from the code the DO reply carried, with its text intact', () => {
    const { status, body } = mapError(substratError('conflict', sentence));
    expect(status).toBe(409);
    expect(body.detail).toBe(sentence);
  });

  it('the flattened form a throw across the hop arrives as is no longer matched (#113)', () => {
    // The coordinator reads the refusal from `applyProjectionReply` now; only a coordinator
    // calling a DO from before that change could still see this, and it gets the generic 500.
    expect(mapError(new Error(`Substrat.conflict: ${sentence}`)).status).toBe(500);
  });
});

/**
 * #113: the last families on `CODE_PATTERNS`, pinned by status AND code — one real sentence per
 * throw-site wording, as the adapters write it. These are what a client of the control plane sees
 * today, and typing the throw sites must not move a single one.
 */
const REMAINING: readonly [sentence: string, status: number, code: string][] = [
  ['cannot provision scope under unknown tenant: 01T', 409, 'conflict'],
  ['cannot provision tenant store under unknown tenant: 01T', 404, 'not_found'],
  ['cannot provision blob store under unknown tenant: 01T', 404, 'not_found'],
  ['cannot provision scope under non-active tenant (status: suspended): 01T', 409, 'conflict'],
  ['cannot provision tenant store under non-active tenant (status: suspended): 01T', 409, 'conflict'],
  ['cannot provision blob store under non-active tenant (status: deleting): 01T', 409, 'conflict'],
  [`tenant slug 'acme' already taken by 01T (slugs are unique)`, 409, 'conflict'],
  [`scope slug 'main' already taken under tenant 01T by 01S (slugs are unique within a tenant)`, 409, 'conflict'],
  [`org slug 'ops' already taken by 01O (slugs are unique per tenant)`, 409, 'conflict'],
  ['illegal scope transition for archive: reaped → archived (allowed from: active|suspended)', 409, 'conflict'],
  ['applyProjection refused: this scope was provisioned for tenant 01A, and a projection for tenant 01B would re-point it', 409, 'conflict'],
  ['tenant not active (status: suspended): 01T', 409, 'conflict'],
  ['scope not active (status: archived): 01S', 409, 'conflict'],
  [`vertical 'todo' is already registered as git`, 409, 'conflict'],
  [`identity pool 'acme-pool' is already registered as shared for tenant 01T`, 409, 'conflict'],
  ['promotion changes the permission surface (aaa → bbb) — acknowledge it explicitly to promote', 409, 'conflict'],
  ['promotion changes migrations (aaa → bbb) — acknowledge it explicitly to promote', 409, 'conflict'],
  ['unknown tenant: 01T', 404, 'not_found'],
  ['unknown scope for tenant: (01T, 01S)', 404, 'not_found'],
  ['unknown scope 01S in tenant 01T', 404, 'not_found'],
  ['unknown scope for connection: 01S', 404, 'not_found'],
  [`unknown table 'ghost'`, 404, 'not_found'],
  ['read-only console: empty statement', 400, 'validation_failed'],
  ['scope has no tenant record: (01T, 01S)', 404, 'not_found'],
];

describe('mapError — the last pattern families keep their status and code (#113)', () => {
  // Every row is typed at its throw site now (both adapters, the contract suite asserts the code),
  // so the status comes from the declaration and the pattern table is gone.
  it.each(REMAINING)('%s → %i %s', (sentence, status, code) => {
    const mapped = mapError(substratError(code as ErrorCode, sentence));
    expect(mapped.status).toBe(status);
    expect(mapped.body.code).toBe(code);
    expect(mapped.body.detail).toBe(sentence);
  });

  it.each(REMAINING)('%s, untyped, is an unreviewed throw: the generic 500', (sentence) => {
    // What makes the deletion real: a future untyped refusal answers `internal error` in its
    // first test instead of being quietly matched by a row that guessed its code.
    const mapped = mapError(new Error(sentence));
    expect(mapped.status).toBe(500);
    expect(mapped.body.detail).toBeUndefined();
  });
});

describe('mapError — the scope gate keeps its own answer on the control plane (#113)', () => {
  // A vertical's public edge answers these as the router does; the operator's surface does not.
  it.each([
    [substratError('conflict', 'scope not active (status: suspended): 01S', { reason: SCOPE_GATE_REASONS.notActive }), 409],
    [substratError('not_found', 'scope has no tenant record: (01T, 01S)', { reason: SCOPE_GATE_REASONS.unrecorded }), 404],
  ] as const)('%s → %i, naming what it is', (refusal, status) => {
    const { status: answered, body } = mapError(refusal);
    expect(answered).toBe(status);
    expect(body.detail).toBe(refusal.message);
    expect(body.reason).toBe(refusal.extensions.reason);
  });
});

/**
 * #113: refusals no pattern ever matched, so they answered the generic 500 — `internal error`,
 * no detail — for a request the caller can fix. Typed at their throw sites now. The untyped
 * twin is what each answered before.
 */
const WAS_500: readonly [sentence: string, status: number, code: ErrorCode][] = [
  [`tenant 01T cannot be set to 'reaped' via setTenantStatus — reap goes through reapTenant (control-plane.md §4.8)`, 400, 'validation_failed'],
  ['tenant 01T is active, not deleting — only a deleting tenant may be reaped', 409, 'conflict'],
  ['scope 01S is active, not archived — only an archived scope may be reaped', 409, 'conflict'],
  [`scope 01S still resolves hostname 'app.example.com' — unbind it before reaping`, 409, 'conflict'],
  ['scope 01S is not a fork or preview — only previews may be deleted; archive and reap a primary', 403, 'forbidden'],
  [`hostname 'app.example.com' is already bound to another scope`, 409, 'conflict'],
  [`unknown hostname 'ghost.example.com'`, 404, 'not_found'],
  ['unknown org 01O in tenant 01T', 404, 'not_found'],
  [`identity pool 'oidc:x' is not registered`, 404, 'not_found'],
  [`identity pool 'oidc:x' is tenant-bound — enumerating tenants is only meaningful for a central pool`, 403, 'forbidden'],
  [`identity pool 'oidc:x' is not registered — a pool must declare its topology before a login can link`, 409, 'conflict'],
  [`identity pool 'oidc:x' is bound to tenant 01A and cannot link into 01B`, 409, 'conflict'],
  ['module not registered on this host: @acme/none', 404, 'not_found'],
  ['scope not migratable (status: archived): 01S', 409, 'conflict'],
  ['scope 01S is reaped — its storage is gone and cannot be read', 409, 'conflict'],
  ['identity oidc:x:u1 in tenant 01T is already bound to 01P', 409, 'conflict'],
];

describe('mapError — refusals that used to answer the generic 500 (#113)', () => {
  it.each(WAS_500)('%s → %i %s', (sentence, status, code) => {
    const mapped = mapError(substratError(code, sentence));
    expect(mapped.status).toBe(status);
    expect(mapped.body.code).toBe(code);
    expect(mapped.body.detail).toBe(sentence);
  });

  it.each(WAS_500)('%s, untyped (as it was thrown before), is the generic 500', (sentence) => {
    expect(mapError(new Error(sentence)).status).toBe(500);
  });
});
