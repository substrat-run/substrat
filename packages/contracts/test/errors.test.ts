import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildOpenApiDocument,
  errorCodeOf,
  fromWireFailure,
  toWireFailure,
  DOCUMENTED_ERROR_CODES,
  errorCode,
  isSubstratError,
  PROBLEM_CATALOG,
  PROBLEM_EXTENSIONS,
  problem,
  problemTypeFor,
  SubstratError,
  substratError,
  toProblem,
  validationIssuesFrom,
} from '../src/index.js';

describe('the taxonomy', () => {
  it('gives every code a status and a title', () => {
    for (const code of errorCode.options) {
      const entry = PROBLEM_CATALOG[code];
      expect(entry, code).toBeDefined();
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  it('derives the type URI as a slug, so the base flips in one place', () => {
    expect(problemTypeFor('permission_denied')).toBe(
      'https://substrat.net/errors/permission-denied',
    );
    expect(problemTypeFor('internal')).toBe('https://substrat.net/errors/internal');
  });

  // The join the module's own comment promises: a declared extension that the wire
  // schema does not carry would be silently dropped by `problem.parse` in `toProblem`,
  // and the throw site would look correct while the body lost the field.
  it('carries every declared extension on the wire schema', () => {
    const wireFields = new Set(Object.keys(problem.shape));
    for (const code of errorCode.options) {
      const declared = PROBLEM_EXTENSIONS[code];
      for (const field of Object.keys((declared as z.ZodObject<z.ZodRawShape>).shape)) {
        expect(wireFields, `${code}.${field} is declared but not on the wire`).toContain(field);
      }
    }
  });
});

describe('substratError', () => {
  it('stamps the status from the catalog and keeps the message human', () => {
    const err = substratError('conflict', 'work order is already exported', {
      reason: 'already_exported',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('work order is already exported');
    expect(err.status).toBe(409);
    expect(err.extensions).toEqual({ reason: 'already_exported' });
  });

  it('refuses an extension the code does not declare', () => {
    // Compile-checked too — this cast is what a JS caller would reach us with.
    expect(() => substratError('not_found', 'gone', { retryAfter: 5 } as never)).toThrow();
  });
});

describe('isSubstratError', () => {
  it('recognises its own instances', () => {
    expect(isSubstratError(substratError('not_found', 'gone'))).toBe(true);
  });

  // The production case: the adapter rebuilds a thrown error as a plain `Error` across
  // the ScopeDO RPC boundary, so the prototype is gone by the time a transport sees it.
  it('duck-types an error whose prototype was lost', () => {
    const rebuilt = Object.assign(new Error('permission denied: customer:manage'), {
      code: 'permission_denied',
    });
    expect(isSubstratError(rebuilt)).toBe(true);
  });

  it('does not claim a plain error, or a foreign code', () => {
    expect(isSubstratError(new Error('boom'))).toBe(false);
    expect(isSubstratError(Object.assign(new Error('boom'), { code: 'ENOENT' }))).toBe(false);
    expect(isSubstratError('boom')).toBe(false);
  });
});

describe('toProblem', () => {
  it('maps a typed throw, duplicating detail into the deprecated `error`', () => {
    const body = toProblem(
      substratError('permission_denied', 'permission denied: customer:manage', {
        permission: 'customer:manage',
      }),
      '/api/op/callout-create-customer',
    );
    expect(body).toMatchObject({
      type: 'https://substrat.net/errors/permission-denied',
      title: 'Permission denied',
      status: 403,
      detail: 'permission denied: customer:manage',
      error: 'permission denied: customer:manage',
      code: 'permission_denied',
      permission: 'customer:manage',
      instance: '/api/op/callout-create-customer',
    });
  });

  it('turns a Zod failure into field-level issues', () => {
    const schema = z.object({ email: z.string().email(), lines: z.array(z.object({ qty: z.number() })) });
    const parsed = schema.safeParse({ email: 'nope', lines: [{ qty: 'x' }] });
    expect(parsed.success).toBe(false);

    const body = toProblem(parsed.error);
    expect(body.status).toBe(400);
    expect(body.code).toBe('validation_failed');
    const paths = body.errors?.map((issue) => issue.path);
    expect(paths).toContain('email');
    expect(paths).toContain('lines.0.qty');
  });

  // The security posture that predates this module and survives it verbatim.
  it('discloses NOTHING from an unrecognised throw', () => {
    const body = toProblem(new Error('SELECT * FROM tenant_secrets failed: bad token abc123'));
    expect(body.status).toBe(500);
    expect(body.code).toBe('internal');
    expect(body.detail).toBeUndefined();
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('abc123');
  });

  it('is a valid problem body whatever it was handed', () => {
    for (const thrown of [new Error('x'), 'a string', null, { weird: true }]) {
      expect(() => problem.parse(toProblem(thrown))).not.toThrow();
    }
  });
});

describe('the emitted document', () => {
  const doc = buildOpenApiDocument({ title: 'Callout', version: '1.0.0' }, {
    'callout/create-customer': { summary: 'Register a customer', output: z.object({ id: z.string() }) },
  }) as Record<string, any>;

  it('defines the problem schema and each failure once, then references them', () => {
    expect(doc.components.schemas.Problem).toBeDefined();
    const responses = doc.paths['/api/op/callout/create-customer'].post.responses;

    for (const code of DOCUMENTED_ERROR_CODES) {
      const status = String(PROBLEM_CATALOG[code].status);
      const ref = responses[status]?.$ref as string | undefined;
      expect(ref, `status ${status} for ${code}`).toMatch(/^#\/components\/responses\//);

      // Every reference resolves — a dangling $ref is an invalid document, and a
      // renderer reports it as an empty response rather than as an error.
      const name = ref!.replace('#/components/responses/', '');
      const defined = doc.components.responses[name];
      expect(defined, `${ref} does not resolve`).toBeDefined();
      expect(defined.content['application/problem+json'].schema).toEqual({
        $ref: '#/components/schemas/Problem',
      });
      expect(defined.description).toContain(`\`${code}\``);
    }
  });

  // Declared in the taxonomy so #129 and #130 add no vocabulary, but nothing raises
  // them yet — and documenting a failure that cannot occur is worse than documenting none.
  it('does not document failures nothing can raise yet', () => {
    const responses = doc.paths['/api/op/callout/create-customer'].post.responses;
    expect(responses['412']).toBeUndefined();
    expect(responses['429']).toBeUndefined();
  });

  it('stays byte-identical across builds, so api-diff can gate it', () => {
    const again = buildOpenApiDocument({ title: 'Callout', version: '1.0.0' }, {
      'callout/create-customer': { summary: 'Register a customer', output: z.object({ id: z.string() }) },
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(doc));
  });
});

describe('validationIssuesFrom', () => {
  it('joins a nested path with dots and leaves a root issue empty', () => {
    const nested = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    expect(validationIssuesFrom(nested.error!)[0]?.path).toBe('a.b');

    const root = z.string().safeParse(1);
    expect(validationIssuesFrom(root.error!)[0]?.path).toBe('');
  });
});

describe('SubstratError', () => {
  it('is catchable as an Error and carries its code in the name', () => {
    try {
      throw new SubstratError('unavailable', 'no seal key configured');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe('Substrat.unavailable');
      expect((err as SubstratError).status).toBe(503);
    }
  });
});

// The mechanism phase 2 rests on: `name` is what Workers RPC preserves, so `name` is
// where the code rides. Everything here simulates the far side of that hop — a PLAIN
// Error with nothing but message and name left.
describe('errorCodeOf', () => {
  it('reads the live property in-process', () => {
    expect(errorCodeOf(substratError('conflict', 'already exported'))).toBe('conflict');
  });

  it('reads the name once the class is gone', () => {
    const crossed = new Error('already exported');
    crossed.name = 'Substrat.conflict';
    expect(errorCodeOf(crossed)).toBe('conflict');
    expect(isSubstratError(crossed)).toBe(true);
  });

  it('reads the legacy class names that already meant a code', () => {
    const denied = new Error('permission denied: customer:manage');
    denied.name = 'PermissionDenied';
    expect(errorCodeOf(denied)).toBe('permission_denied');

    const unsealed = new Error('no seal key');
    unsealed.name = 'SecretBoxUnconfiguredError';
    expect(errorCodeOf(unsealed)).toBe('unavailable');

    // A parse failure loses its `issues` across the hop; the code is all that is left,
    // and validation_failed without fields still beats internal.
    const parse = new Error('invalid input');
    parse.name = 'ZodError';
    expect(errorCodeOf(parse)).toBe('validation_failed');
  });

  // The one mapping in CODE_BY_ERROR_NAME keyed to a class we do NOT own. The tests
  // above construct the name by hand, which would keep passing if Zod ever stopped
  // producing it; this asks Zod itself.
  it('maps a real ZodError, not just one we named ourselves', () => {
    const parsed = z.object({ a: z.string() }).safeParse({ a: 1 });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.name).toBe('ZodError');
    expect(errorCodeOf(parsed.error!)).toBe('validation_failed');
  });

  it('has no opinion about a foreign error', () => {
    expect(errorCodeOf(new Error('boom'))).toBeUndefined();
    expect(errorCodeOf(Object.assign(new Error('boom'), { code: 'ENOENT' }))).toBeUndefined();
    expect(errorCodeOf(Object.assign(new Error('boom'), { name: 'Substrat.nonsense' }))).toBeUndefined();
    expect(errorCodeOf(null)).toBeUndefined();
    expect(errorCodeOf('boom')).toBeUndefined();
  });

  it('classifies a post-hop throw exactly as it classified the original', () => {
    const original = substratError('conflict', 'work order is already exported', {
      reason: 'already_exported',
    });
    const crossed = new Error(original.message);
    crossed.name = original.name;

    const before = toProblem(original);
    const after = toProblem(crossed);

    expect(after.status).toBe(before.status);
    expect(after.code).toBe(before.code);
    expect(after.detail).toBe(before.detail);
    // The documented cost: own properties do not survive, so the extension is lost.
    expect(before.reason).toBe('already_exported');
    expect(after.reason).toBeUndefined();
  });

  it('keeps `internal` generic even when a throw asked for it by name', () => {
    const crossed = new Error('connection string postgres://user:hunter2@db');
    crossed.name = 'Substrat.internal';
    const body = toProblem(crossed);
    expect(body.code).toBe('internal');
    expect(body.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });
});


/**
 * The value an error becomes when it has to cross a boundary a throw cannot survive.
 * `adapter-cloudflare` proves the boundary end; this proves the round trip.
 */
describe('the wire failure', () => {
  const roundTrip = (err: unknown): Error =>
    fromWireFailure(JSON.parse(JSON.stringify(toWireFailure(err))));

  it('keeps the code, the message and the declared extensions', () => {
    const original = substratError('conflict', 'the period is closed for edits', {
      reason: 'period_closed',
    });
    const rebuilt = roundTrip(original);

    expect(rebuilt.message).toBe('the period is closed for edits');
    expect(errorCodeOf(rebuilt)).toBe('conflict');
    // The half the `name` carrier could never deliver.
    expect(toProblem(rebuilt).reason).toBe('period_closed');
    expect(toProblem(rebuilt).status).toBe(409);
  });

  it('keeps a name that predates the taxonomy', () => {
    const denied = Object.assign(new Error('permission denied: customer:manage'), {
      name: 'PermissionDenied',
    });
    const rebuilt = roundTrip(denied);
    expect(rebuilt.name).toBe('PermissionDenied');
    expect(errorCodeOf(rebuilt)).toBe('permission_denied');
  });

  it('leaves a foreign throw foreign rather than inventing a code for it', () => {
    const rebuilt = roundTrip(new Error('something a vertical understands'));
    expect(rebuilt.message).toBe('something a vertical understands');
    expect(errorCodeOf(rebuilt)).toBeUndefined();
    expect(toProblem(rebuilt).code).toBe('internal');
  });

  it('survives a throw that was never an Error at all', () => {
    const rebuilt = roundTrip('a bare string');
    expect(rebuilt).toBeInstanceOf(Error);
    expect(rebuilt.message).toBe('a bare string');
  });

  it('is JSON — no prototypes, no getters, nothing that needs a class to read', () => {
    const wire = toWireFailure(substratError('not_found', 'gone'));
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });
});
