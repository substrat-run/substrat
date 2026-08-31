import { describe, it, expect } from 'vitest';
import { PROBLEM_CATALOG, problemTypeFor } from '@substrat-run/contracts';
import { failureMessage, readProblem } from '../src/problem.js';

/**
 * The CLI reads what the control plane writes (#971 / #113). Every body below is one a
 * command can actually receive: a problem document from a current control plane, the
 * deprecated `{ error }` duplicate from an older one, and the two shapes that are not
 * JSON at all.
 */

/** A problem document exactly as `toProblem` renders one — built from the catalog, not typed by hand. */
const problemBody = (code: keyof typeof PROBLEM_CATALOG, detail: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: problemTypeFor(code),
    title: PROBLEM_CATALOG[code].title,
    status: PROBLEM_CATALOG[code].status,
    detail,
    code,
    ...extra,
  });

describe('readProblem', () => {
  it('reads a problem document’s detail and code', () => {
    const body = problemBody('conflict', "version '1.4.0' is already registered", { reason: 'already_registered' });
    expect(readProblem(body)).toMatchObject({
      detail: "version '1.4.0' is already registered",
      code: 'conflict',
      title: 'Conflict',
    });
  });

  it('carries a validation failure’s field errors', () => {
    const body = problemBody('validation_failed', 'invalid request', {
      errors: [{ path: 'ttlHours', message: 'expected number' }],
    });
    expect(readProblem(body).errors).toEqual([{ path: 'ttlHours', message: 'expected number' }]);
  });

  it('falls back to the title when a problem carries no detail', () => {
    const body = JSON.stringify({
      type: problemTypeFor('not_found'),
      title: 'Not found',
      status: 404,
      code: 'not_found',
    });
    expect(readProblem(body)).toMatchObject({ detail: 'Not found', code: 'not_found' });
  });

  it('reads the deprecated `{ error }` body an older control plane answers with', () => {
    expect(readProblem(JSON.stringify({ error: 'previews are available for private verticals only' }))).toEqual({
      detail: 'previews are available for private verticals only',
    });
  });

  it('prefers `detail` over the deprecated `error` duplicate when both are present', () => {
    // The migration window (#113): a problem document carries both, and they agree —
    // but `detail` is the member the contract defines, so it is the one that is read.
    const body = problemBody('permission_denied', 'you may not promote a listed vertical', {
      error: 'you may not promote a listed vertical',
    });
    expect(readProblem(body).detail).toBe('you may not promote a listed vertical');
  });

  it('shows a slice of a body that is not a recognisable error at all', () => {
    expect(readProblem('upstream connect error or disconnect').detail).toBe('upstream connect error or disconnect');
    expect(readProblem('x'.repeat(500)).detail).toHaveLength(300);
  });

  it('reads a JSON body with no readable member as the raw body', () => {
    expect(readProblem('{"ok":false}').detail).toBe('{"ok":false}');
  });

  it('answers an empty detail for an empty body rather than inventing one', () => {
    expect(readProblem('')).toEqual({ detail: '' });
    expect(readProblem('   \n ')).toEqual({ detail: '' });
  });
});

describe('failureMessage', () => {
  it('names the command, the status and the code', () => {
    const body = problemBody('conflict', 'a version with this digest is already registered');
    expect(failureMessage('push failed', 409, body)).toBe(
      'push failed (409 conflict): a version with this digest is already registered',
    );
  });

  it('lists the offending fields under the message', () => {
    const body = problemBody('validation_failed', 'invalid request', {
      errors: [
        { path: 'tag', message: 'expected string' },
        { path: '', message: 'unrecognized key' },
      ],
    });
    expect(failureMessage('preview failed', 400, body)).toBe(
      'preview failed (400 validation_failed): invalid request\n' +
        '  tag: expected string\n' +
        '  (root): unrecognized key',
    );
  });

  it('omits the code and the colon when the body says nothing', () => {
    expect(failureMessage('promote failed', 502, '')).toBe('promote failed (502)');
  });

  it('still appends the Cloudflare redacted-fault note on a 5xx (#559)', () => {
    const body = JSON.stringify({ error: 'internal error; reference = 8a3f21bc' });
    const message = failureMessage('push failed', 500, body);
    expect(message).toContain('push failed (500): internal error; reference = 8a3f21bc');
    expect(message).toContain('Cloudflare-side infrastructure fault');
  });

  it('does not append the fault note to an ordinary 4xx refusal', () => {
    expect(failureMessage('push failed', 403, problemBody('permission_denied', 'not your vertical'))).toBe(
      'push failed (403 permission_denied): not your vertical',
    );
  });
});
