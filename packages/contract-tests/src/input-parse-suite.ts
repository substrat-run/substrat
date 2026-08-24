/**
 * Contract suite for the declared-input parse at the scope door (#893).
 *
 * What it pins is one sentence: **an operation's declared `input` is parsed by
 * the HOST, before the guards and the handler, on every path into a scope.**
 *
 * ## Why this is a host contract and not a house rule
 *
 * `OperationShape.input` has always described itself as *"the SAME Zod object
 * the handler parses"*. Across the fleet it mostly was not: of ~85 declared
 * inputs, 40 were parsed, and `demos/rally` declared 32 and parsed 2. The
 * declaration was true about the shape — the compiler holds `idFrom` and
 * `entityIdFrom` to it — and false about the parsing, which is the half that
 * refuses a malformed call. Every operation authored after the fix would have
 * had to remember, forever, in every vertical.
 *
 * The alternative was a lint rule, and it is strictly weaker: it can ask only
 * whether *some* `.parse` appears in a handler body, never whether it is the
 * declared schema at the boundary. It also cannot be satisfied at all where the
 * schema is declared inline (`input: z.object({…})`) — callout, handlebar and
 * todo declare 25 such inputs between them, the reference implementation among
 * them. So the host parses, from the declaration that already produces the
 * manifest, the routes and the OpenAPI document. `mountOperations` had already
 * made this argument for the page trio, in those words.
 *
 * ## Why it belongs to every adapter
 *
 * A vertical's isolation now depends on it. If one host parses and another does
 * not, the same operation refuses a malformed call on SQLite and accepts it on
 * the DO — and "parse, don't trust" becomes a fact about which substrate a
 * tenant landed on. That is exactly the class of divergence `atomicContractSuite`
 * exists to close for `ctx.atomic`.
 *
 * The suite deliberately drives operations through `stub.invoke` rather than
 * over HTTP. Parsing at the HTTP mount alone would leave every scenario test,
 * seed and schedule on an unparsed path — the demos' own suites would exercise
 * the one route the fix did not cover.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  errorCodeOf,
  moduleId,
  permissionKey,
  platformActorId,
  principalId,
  scopeId,
  tenantId,
  toProblem,
  type PrincipalId,
} from '@substrat-run/contracts';
import { ulid, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { ScopeHostFixture } from './scope-host-suite.js';
import { parseMod, parseModManifest } from './modules.js';

const PARSE_USE = permissionKey.parse('parse:use');

export function inputParseContractSuite(
  adapterName: string,
  makeFixture: () => Promise<ScopeHostFixture>,
): void {
  describe(`declared input is parsed at the door (#893): ${adapterName}`, () => {
    let fixture: ScopeHostFixture;
    let host: ScopeHost;
    let stub: ScopeStub;
    const t1 = tenantId.parse(ulid());
    const s1 = scopeId.parse(ulid());
    const alice: PrincipalId = principalId.parse(ulid());
    const staff = platformActorId.parse(ulid());

    beforeAll(async () => {
      fixture = await makeFixture();
      host = fixture.host;
      host.registerModule(parseMod);
      await host.admin.createTenant(staff, { id: t1, slug: 'parse-tenant', name: 'Parse Tenant' });
      await host.admin.grantEntitlement(staff, t1, 'parse');
      await host.admin.defineRole(staff, t1, {
        key: 'parser',
        permissions: [PARSE_USE],
        source: 'vertical',
      });
      await host.admin.assignRole(staff, {
        principalId: alice,
        roleKey: 'parser',
        node: { tenantId: t1, scopeId: null },
      });
      await host.provisionScope(staff, { tenantId: t1, scopeId: s1, vertical: 'parse-vertical' });
      await host.admin.activateScope(staff, t1, s1);
      stub = await host.getScope(alice, t1, s1);
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    const received = async (op: string, input?: unknown) =>
      (await stub.invoke<{ received: unknown }>(op, input)).received as Record<string, unknown> | null;

    it('refuses an invocation whose declared field has the wrong type', async () => {
      // The handler never runs: a `name` of the wrong type is not a domain
      // decision the module gets to make badly, it is a call that never had a
      // meaning. Refused before the transaction opens.
      await expect(stub.invoke('parse/echo', { name: 42 })).rejects.toThrow();
    });

    it('refuses an invocation missing a required declared field', async () => {
      await expect(stub.invoke('parse/echo', { tag: 'x' })).rejects.toThrow();
    });

    /**
     * #831. Refusing is half a contract; saying WHICH field was wrong is the half a
     * client — or a build agent — recovers from without a person reading a log.
     *
     * This belongs beside the refusals above rather than in `contracts` alone, because
     * the two substrates lose the answer differently. Under `adapter-sqlite` the parse
     * throws in-process and the `ZodError` arrives with `issues` intact. Under
     * `adapter-cloudflare` it is raised INSIDE the ScopeDO and crosses the hop, where a
     * throw carries only its message — so the field list used to survive nowhere but as
     * JSON inside that message, and every vertical re-parsed the string to get it back.
     *
     * A suite that ran on one adapter would have called that fixed.
     */
    it('names the field that was wrong, whichever substrate refused it', async () => {
      const err = await stub.invoke('parse/echo', { name: 42 }).then(
        () => {
          throw new Error('the invoke should have been refused');
        },
        (e: unknown) => e,
      );

      expect(errorCodeOf(err)).toBe('validation_failed');
      const body = toProblem(err);
      expect(body.status).toBe(400);
      expect(body.errors?.map((issue) => issue.path)).toContain('name');
    });

    it('strips a field the declaration does not name', async () => {
      // The undeclared key is gone before module code sees it — so a caller
      // cannot smuggle a field past a handler that reads more than it declared.
      const out = await received('parse/echo', { name: 'a', unexpected: 'smuggled' });
      expect(out).not.toHaveProperty('unexpected');
      expect(out).toMatchObject({ name: 'a' });
    });

    it("applies the declaration's own default", async () => {
      // The case a handler cannot fake by being careful: `size` arrives SET on a
      // call that never sent it, which only a parse against the declaration does.
      expect(await received('parse/echo', { name: 'a' })).toMatchObject({ size: 7 });
    });

    it('keeps an optional declared field absent rather than inventing it', async () => {
      const out = await received('parse/echo', { name: 'a' });
      expect(out).not.toHaveProperty('tag');
    });

    it('lets the platform page trio through a paged operation (#811)', async () => {
      // A strict parse against `input` alone would strip these back out and hand
      // every paged read an unpaged request.
      const out = await received('parse/paged', { q: 'find', limit: 5, cursor: 'c1', order: 'desc', sort: 'name' });
      expect(out).toMatchObject({ q: 'find', limit: 5, cursor: 'c1', order: 'desc', sort: 'name' });
    });

    it('rejects a page value outside the platform ceiling', async () => {
      await expect(stub.invoke('parse/paged', { limit: 10_000 })).rejects.toThrow();
    });

    it('hands an operation that declares no input its `undefined` unchanged', async () => {
      // `z.object({})` cannot say "no body", so the host must not invent one:
      // a handler typed for `undefined` is not one accepting `{}`.
      expect(await received('parse/bare')).toBeNull();
    });

    it('refuses a schema declared for an operation the module does not bind', () => {
      // A schema on nothing enforces nothing while reading as coverage — the
      // same reasoning `checksDeclaredElsewhere` applies to a stale exemption.
      expect(() =>
        host.registerModule({
          manifest: { ...parseModManifest, id: moduleId.parse('@test/parse-unbound') },
          operations: { 'unbound/act': (() => 'ran') as never },
          operationInputs: { 'unbound/nope': { parse: (v: unknown) => v } },
        }),
      ).toThrow(/unbound/i);
    });
  });
}
