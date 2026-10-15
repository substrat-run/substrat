import { describe, it, expect } from 'vitest';
import { assertSignInPolicy } from '../src/sign-in-policy.js';
import {
  ANY_PROVIDER, PASSWORD_METHOD, describeFlow, draftFromStored, draftProblems, draftToStored, editDraft, everyMethod, newRoute,
  parseDomains, resolveAny, shownDraft, type PolicyDraft,
} from '../app/src/views/sign-in-draft.js';

const OFFERED = [{ id: 'microsoft', label: 'Microsoft' }, { id: 'bankid', label: 'BankID' }];

describe('the sign-in form writes what the server accepts', () => {
  it('round-trips the identifier-first policy through the form and the server schema', () => {
    const stored = {
      providers: ['bankid'], password: true, passwordSecondFactor: 'sms', identifierFirst: true,
      domainRoutes: [{ domains: ['acme.se', 'acme.com'], provider: 'microsoft' }],
    };
    const draft = draftFromStored(stored);
    expect(draftProblems(draft, OFFERED, false)).toEqual([]);
    const written = draftToStored(draft, OFFERED, false);
    expect(written).toEqual(stored);
    expect(() => assertSignInPolicy(written)).not.toThrow();
  });

  it('writes nothing when nothing is restricted — absent is the default', () => {
    expect(draftToStored(draftFromStored(undefined), OFFERED, false)).toBeUndefined();
  });

  it('expands "any provider" once the issuer list arrives', () => {
    const draft = draftFromStored({ password: true });
    expect(draft.methods.has(ANY_PROVIDER)).toBe(true);
    const resolved = resolveAny(draft, OFFERED);
    expect([...resolved.methods].sort()).toEqual(['bankid', 'microsoft', 'password']);
  });

  it('accepts the way people actually type domains', () => {
    expect(parseDomains('@Acme.se, acme.com\nacme.se')).toEqual(['acme.se', 'acme.com']);
  });

  it('says what is wrong, before the server has to', () => {
    const draft = draftFromStored({ providers: [], password: true, identifierFirst: true });
    draft.routes = [
      { ...newRoute('microsoft'), domains: 'anna@acme.se' },
      { ...newRoute(''), domains: 'acme.se' },
      { ...newRoute('microsoft'), domains: 'acme.se' },
    ];
    const problems = draftProblems(draft, OFFERED, false);
    expect(problems.some((p) => p.includes('not a domain name'))).toBe(true);
    expect(problems.some((p) => p.includes('choose the provider'))).toBe(true);
    expect(problems.some((p) => p.includes('already in rule'))).toBe(true);
  });

  it('never writes routes for the console, whose screen does not enforce them', () => {
    const draft = draftFromStored({ providers: ['microsoft'], password: true, identifierFirst: true, domainRoutes: [{ domains: ['acme.se'], provider: 'microsoft' }] });
    const written = draftToStored(draft, OFFERED, true);
    expect(written).not.toHaveProperty('domainRoutes');
    expect(written).not.toHaveProperty('identifierFirst');
  });

  it('previews the flow from the same draft, and warns about a dead end', () => {
    const draft = draftFromStored({ providers: ['bankid'], password: true, passwordSecondFactor: 'sms', identifierFirst: true, domainRoutes: [{ domains: ['acme.se'], provider: 'microsoft' }] });
    const flow = describeFlow(draft, OFFERED, false);
    expect(flow.first).toEqual(['BankID', 'Email address']);
    expect(flow.visitors[0]).toEqual({ who: 'Email @acme.se', what: 'Microsoft only' });
    expect(flow.visitors.find((v) => v.who === 'Any other email')?.what).toContain('SMS');
    expect(describeFlow(draftFromStored({ providers: [], password: false }), OFFERED, false).deadEnd).toBe(true);
  });
});

/** What the boxes on the form show for a draft, as the editor draws it (`shownDraft`). The SMS
 *  box is only drawn while password is ticked, so it only counts then. */
function onScreen(draft: PolicyDraft) {
  const shown = shownDraft(draft, OFFERED);
  const password = shown.methods.has(PASSWORD_METHOD);
  return {
    restrict: shown.restrict,
    methods: [...shown.methods].sort(),
    sms: password && shown.requireSms,
    identifierFirst: shown.identifierFirst,
    routes: shown.routes.map((r) => ({ domains: parseDomains(r.domains), provider: r.provider })),
  };
}

/** Save the draft, then open the application again: what the form shows afterwards. */
function afterSaving(draft: PolicyDraft) {
  expect(draftProblems(draft, OFFERED, false)).toEqual([]);
  return onScreen(resolveAny(draftFromStored(draftToStored(draft, OFFERED, false)), OFFERED));
}

describe('the sign-in form shows what saving stores', () => {
  const noPolicy = () => resolveAny(draftFromStored(undefined), OFFERED);

  it('shows every method ticked and nothing else for an application with no policy', () => {
    expect(onScreen(noPolicy())).toEqual({
      restrict: false, methods: ['bankid', 'microsoft', 'password'], sms: false, identifierFirst: false, routes: [],
    });
    expect(afterSaving(noPolicy())).toEqual(onScreen(noPolicy()));
  });

  it('turns the first change into an explicit list of what was shown, plus the change', () => {
    const sms = editDraft(noPolicy(), OFFERED, { requireSms: true });
    expect(onScreen(sms)).toEqual({
      restrict: true, methods: ['bankid', 'microsoft', 'password'], sms: true, identifierFirst: false, routes: [],
    });
    expect(draftToStored(sms, OFFERED, false)).toMatchObject({ passwordSecondFactor: 'sms' });
    expect(afterSaving(sms)).toEqual(onScreen(sms));
  });

  it('clears the SMS step, email-first and domain rules on "Back to every method"', () => {
    let draft = editDraft(noPolicy(), OFFERED, { requireSms: true });
    draft = editDraft(draft, OFFERED, { identifierFirst: true });
    draft = editDraft(draft, OFFERED, { routes: [{ ...newRoute('microsoft'), domains: 'acme.se' }] });
    expect(onScreen(draft)).toMatchObject({ sms: true, identifierFirst: true, routes: [{ domains: ['acme.se'], provider: 'microsoft' }] });

    const back = everyMethod();
    // The fault this pins: the SMS box stayed ticked under "every method" while saving stored
    // no policy — no second factor — so the form claimed a protection that was not in force.
    expect(onScreen(back)).toEqual(onScreen(noPolicy()));
    expect(draftToStored(back, OFFERED, false)).toBeUndefined();
    expect(afterSaving(back)).toEqual(onScreen(back));
  });

  it('shows the defaults for an unrestricted draft even if it still carries old choices', () => {
    // A draft the editor never produces any more, held to the same rule anyway: with no policy,
    // nothing but `restrict` decides what is drawn.
    const stale: PolicyDraft = { ...editDraft(noPolicy(), OFFERED, { requireSms: true, identifierFirst: true }), restrict: false };
    expect(onScreen(stale)).toEqual(onScreen(noPolicy()));
    // …and the next change starts from those defaults, not from the stale choices.
    expect(onScreen(editDraft(stale, OFFERED, { methods: new Set([PASSWORD_METHOD]) }))).toMatchObject({ sms: false, identifierFirst: false });
  });

  it('keeps the SMS step through unticking and reticking password, exactly as it saves', () => {
    const sms = editDraft(noPolicy(), OFFERED, { requireSms: true });
    const off = editDraft(sms, OFFERED, { methods: new Set(['bankid', 'microsoft']) });
    expect(onScreen(off)).toMatchObject({ methods: ['bankid', 'microsoft'], sms: false });
    expect(afterSaving(off)).toEqual(onScreen(off));
    const on = editDraft(off, OFFERED, { methods: new Set(['bankid', 'microsoft', PASSWORD_METHOD]) });
    expect(onScreen(on)).toMatchObject({ sms: true });
    expect(afterSaving(on)).toEqual(onScreen(on));
  });

  it('round-trips an explicit list that unticks a provider and ticks it again', () => {
    const off = editDraft(noPolicy(), OFFERED, { methods: new Set([PASSWORD_METHOD, 'bankid']) });
    expect(afterSaving(off)).toEqual(onScreen(off));
    const on = editDraft(off, OFFERED, { methods: new Set([PASSWORD_METHOD, 'bankid', 'microsoft']) });
    // Every method ticked again is still an explicit list: providers added later are not in it.
    expect(onScreen(on)).toMatchObject({ restrict: true, methods: ['bankid', 'microsoft', 'password'] });
    expect(afterSaving(on)).toEqual(onScreen(on));
  });
});
