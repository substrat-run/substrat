import { describe, it, expect } from 'vitest';
import {
  IssuerUnreachable,
  isIssuerState,
  isSessionOrNull,
  readIssuerJson,
  type ReadResponse,
} from '../app/src/wire.js';

/**
 * THE TWO PRE-AUTH READS, and what they are allowed to believe.
 *
 * `/api/setup-state` and `/api/session` gate every screen this app has: until both answer,
 * `App.tsx` cannot pick one, so the page says "Loading…" and nothing else. That made them the
 * two reads where an unchecked answer did not degrade — it HUNG, silently, for as long as the
 * person was willing to look at it.
 *
 * Each case below is a shape a deployed issuer actually answers with, and each one used to end
 * somewhere worse than an error message:
 *
 *   a non-JSON body   → `res.json()` rejected inside a `refresh()` with no catch → "Loading…"
 *                       forever, which is the bug a user reports as a stuck spinner
 *   an `{ error }`    → parsed FINE and was handed on: as a session it made the console tell an
 *                       administrator they were not one, and as the issuer state it left
 *                       `providers` undefined for a screen that reads `providers.length`
 *
 * The last test is the one that matters most and is the least obvious: a failed session read
 * must never be reported as "signed out". Signing out someone who is signed in sends them to a
 * login screen, and for a client restricted to one provider that screen redirects straight back
 * out — so the cheap answer turns one failed read into a loop through a working directory.
 */

const answer = (status: number, body: string): ReadResponse => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(body),
});

const readState = (res: ReadResponse) => readIssuerJson(res, 'The issuer state', isIssuerState);
const readSession = (res: ReadResponse) => readIssuerJson(res, 'The current session', isSessionOrNull);

describe('an answer that is not an answer', () => {
  it('names the status instead of rejecting with a parser error', async () => {
    // What an intermediary substitutes, and what a worker exception page is: HTML.
    const res = answer(502, '<!doctype html><title>502 Bad Gateway</title>');

    await expect(readState(res)).rejects.toThrow(IssuerUnreachable);
    await expect(readState(res)).rejects.toThrow(/502/);
  });

  it('says so even when the failure arrives with a 200 and an HTML body', async () => {
    // The shape that is easiest to get wrong: status says fine, body does not parse.
    await expect(readState(answer(200, '<html>maintenance</html>'))).rejects.toThrow(
      /other than an answer/,
    );
  });
});

describe("the issuer's own error envelope", () => {
  it('is reported with the words it carries, never passed on as data', async () => {
    const res = answer(400, JSON.stringify({ error: "unknown table 'x'" }));

    await expect(readSession(res)).rejects.toThrow(/unknown table 'x'/);
  });

  it('is not mistaken for a session — the mistake that told an administrator they were not one', async () => {
    // `{ error: … }` is a truthy object with no `role`, which is exactly how it used to read.
    expect(isSessionOrNull({ error: 'nope' })).toBe(false);
  });

  it('is not mistaken for the issuer state — the one that left `providers` undefined', async () => {
    expect(isIssuerState({ error: 'nope' })).toBe(false);
  });
});

describe('what a good answer still has to carry', () => {
  it('accepts the issuer state only with the three fields the screens read', async () => {
    const good = { needsSetup: false, signupEnabled: true, providers: [{ id: 'microsoft', label: 'Microsoft' }] };
    await expect(readState(answer(200, JSON.stringify(good)))).resolves.toMatchObject(good);

    // `providers` absent is the shape that crashes the sign-in screen's render, so it is a
    // refusal here rather than a value that fails later and somewhere else.
    expect(isIssuerState({ needsSetup: false, signupEnabled: true })).toBe(false);
  });

  it('keeps "nobody is signed in" and "the read failed" as different answers', async () => {
    // `null` is a real, valid answer — the signed-out case — and must stay one.
    await expect(readSession(answer(200, 'null'))).resolves.toBeNull();
    // A failure must NOT arrive as that same null. If it did, a signed-in person would be sent
    // to a login screen that, for a restricted client, redirects them straight back out.
    await expect(readSession(answer(500, 'null'))).rejects.toThrow(IssuerUnreachable);
    await expect(readSession(answer(200, '<html>'))).rejects.toThrow(IssuerUnreachable);
  });

  it('carries the status, so a screen can tell a refusal from an outage', async () => {
    await expect(readSession(answer(503, ''))).rejects.toMatchObject({ status: 503 });
  });
});
