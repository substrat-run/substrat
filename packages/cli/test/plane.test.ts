import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlaneError } from '@substrat-run/control-plane-client';
import { describe, expect, it } from 'vitest';
import { bodyOrStatus, refusalBody, viaPlane } from '../src/plane.js';

const refused = (e: ControlPlaneError) => new Error(`refused ${e.status}`);

describe('viaPlane — a failure the way the CLI has always put it', () => {
  it('passes a result through, and an error that is not the client’s untouched', async () => {
    await expect(viaPlane(async () => 7, refused)).resolves.toBe(7);
    const own = new RangeError('mine');
    await expect(viaPlane(() => Promise.reject(own), refused)).rejects.toBe(own);
  });

  it('a transport failure is the error fetch threw — or the client’s own when none was kept', async () => {
    const boom = new TypeError('fetch failed');
    await expect(
      viaPlane(() => Promise.reject(new ControlPlaneError(0, 'control plane unreachable: fetch failed', undefined, { cause: boom })), refused),
    ).rejects.toBe(boom);
    const bare = new ControlPlaneError(0, 'control plane unreachable: x');
    await expect(viaPlane(() => Promise.reject(bare), refused)).rejects.toBe(bare);
  });

  it('a 2xx that was not JSON is read through parseJsonBody, naming the URL', async () => {
    const e = new ControlPlaneError(200, 'got a non-JSON response', undefined, { body: '<html>', url: 'https://cp/x', malformed: true });
    await expect(viaPlane(() => Promise.reject(e), refused)).rejects.toThrow('got HTML, not JSON, from https://cp/x');
  });

  it('a refusal is handed to the command’s own message', async () => {
    await expect(viaPlane(() => Promise.reject(new ControlPlaneError(409, 'm')), refused)).rejects.toThrow('refused 409');
  });
});

describe('reading a refusal', () => {
  it('bodyOrStatus: the body, else the status phrase when the stream could not be read — an empty body stays empty', () => {
    expect(bodyOrStatus(new ControlPlaneError(502, 'm', undefined, { body: 'x', statusText: 'Bad Gateway' }))).toBe('x');
    expect(bodyOrStatus(new ControlPlaneError(502, 'm', undefined, { body: '', statusText: 'Bad Gateway' }))).toBe('');
    expect(bodyOrStatus(new ControlPlaneError(502, 'm', undefined, { statusText: 'Bad Gateway' }))).toBe('Bad Gateway');
  });

  it('refusalBody: the parsed JSON, else null — what `res.json().catch(() => null)` was', () => {
    expect(refusalBody(new ControlPlaneError(400, 'm', undefined, { body: '{"error":"x"}' }))).toEqual({ error: 'x' });
    expect(refusalBody(new ControlPlaneError(400, 'm', undefined, { body: '<html>' }))).toBeNull();
    expect(refusalBody(new ControlPlaneError(400, 'm'))).toBeNull();
  });
});

/**
 * One transport (#971): the CLI reaches the control plane through the client, so a request
 * the CLI writes by hand — a bare `fetch(` in a command — is a second transport, with its own
 * credential handling and its own idea of an error. The scan reads text, comments skipped.
 */
describe('no command calls fetch itself', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const bareFetch = (text: string): boolean =>
    text
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
      .some((line) => /(?<![.\w])fetch\(/.test(line));

  it('finds no `fetch(` in the CLI’s sources', () => {
    const offenders = readdirSync(SRC)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => bareFetch(readFileSync(join(SRC, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the scan sees one when there is one (the positive twin), and skips comment lines and methods', () => {
    expect(bareFetch('const r = await fetch(url, { headers });')).toBe(true);
    expect(bareFetch('  // a note about fetch(url)')).toBe(false);
    expect(bareFetch('env.ASSETS.fetch(request)')).toBe(false);
  });
});
