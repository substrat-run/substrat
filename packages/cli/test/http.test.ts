import { describe, it, expect } from 'vitest';
import { explainPlatformFault, parseJsonBody, readJson } from '../src/http.js';

/**
 * The HTML-instead-of-JSON diagnosis (#387): a control-plane URL pointing at the
 * console SPA (missing `/api`) returns an HTML page with status 200, and every command
 * used to die on `Unexpected token '<' … is not valid JSON` — a parser error naming
 * neither the URL nor the fix. The helper names both.
 */
describe('parseJsonBody', () => {
  it('parses JSON through unchanged', () => {
    expect(parseJsonBody<{ a: number }>('{"a":1}', 'https://cp/api/x')).toEqual({ a: 1 });
  });

  it('names the URL and the /api-base fix when the body is HTML', () => {
    const html = '<!doctype html><html><head><title>Substrat Console</title></head></html>';
    expect(() => parseJsonBody(html, 'https://console.substrat.net/verticals')).toThrowError(
      /got HTML, not JSON, from https:\/\/console\.substrat\.net\/verticals.*API base.*SUBSTRAT_CP_URL/s,
    );
  });

  it('treats leading whitespace before a tag as HTML too', () => {
    expect(() => parseJsonBody('\n  <html></html>', 'https://cp/x')).toThrowError(/got HTML, not JSON/);
  });

  it('shows a snippet of a non-JSON, non-HTML body instead of a bare parser error', () => {
    expect(() => parseJsonBody('service unavailable', 'https://cp/x')).toThrowError(
      /non-JSON response from https:\/\/cp\/x: service unavailable/,
    );
  });

  it('readJson reads a Response body through the same diagnosis', async () => {
    const html = new Response('<!doctype html><html></html>', { status: 200 });
    await expect(readJson(html, 'https://cp/x')).rejects.toThrowError(/got HTML, not JSON/);
    const ok = new Response('{"ok":true}', { status: 200 });
    await expect(readJson<{ ok: boolean }>(ok, 'https://cp/x')).resolves.toEqual({ ok: true });
  });
});

/**
 * The #559 (7) messaging fix: a 5xx carrying Cloudflare's redacted-fault shape used to
 * reach CI as "a control-plane trace only its operator can resolve" — wrong operator.
 * The explainer names what it is (a Cloudflare-side fault) and where the handle goes
 * (Cloudflare support, via the platform operator's Failures view).
 */
describe('explainPlatformFault', () => {
  const fault = 'internal error; reference = 242sg7l0st8ldln5uqu8ei58';

  it('explains a 5xx redacted fault as Cloudflare-side, with the handle routed right', () => {
    const note = explainPlatformFault(502, fault);
    expect(note).toMatch(/Cloudflare-side infrastructure fault/);
    expect(note).toMatch(/not a problem with your push or your code/);
    expect(note).toMatch(/Operations → Failures/);
  });

  it('stays silent for a 4xx carrying the same text — an honest refusal keeps its message', () => {
    expect(explainPlatformFault(422, fault)).toBe('');
  });

  it('stays silent for a 5xx without the redacted-fault shape', () => {
    expect(explainPlatformFault(502, 'deploy upload failed: namespace unreachable')).toBe('');
  });
});
