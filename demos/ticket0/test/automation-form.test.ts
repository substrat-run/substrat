/**
 * The Settings form's translation for the behaviours of #1083, and the roster rules the
 * screen applies — a leaf with no DOM, so the suite reaches it directly.
 *
 * The bounds are restated in the browser leaf because `spec/model.ts` is not browser code,
 * so this suite is what keeps the restatement honest: a second reader of one bound.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_CLOSE_MAX_DAYS,
  AUTO_CLOSE_MIN_DAYS,
  AUTO_TAG_RULES_MAX,
  AUTO_TAG_TEXT_MAX,
  NO_REPLY_MAX_HOURS,
  NO_REPLY_MIN_HOURS,
  autoTagRule,
  deskSettingsBlob,
} from '../spec/model.js';
import * as form from '../app/src/automation.js';
import { assignableStaff, deskPeople, ASSISTANT_DISPLAY_NAME } from '../app/src/staff.js';

describe('the form restates the desk’s bounds, and agrees with the schema that enforces them', () => {
  it('every bound is the model’s', () => {
    expect([form.AUTO_CLOSE_MIN_DAYS, form.AUTO_CLOSE_MAX_DAYS]).toEqual([AUTO_CLOSE_MIN_DAYS, AUTO_CLOSE_MAX_DAYS]);
    expect([form.NO_REPLY_MIN_HOURS, form.NO_REPLY_MAX_HOURS]).toEqual([NO_REPLY_MIN_HOURS, NO_REPLY_MAX_HOURS]);
    expect(form.AUTO_TAG_RULES_MAX).toBe(AUTO_TAG_RULES_MAX);
    expect(form.AUTO_TAG_TEXT_MAX).toBe(AUTO_TAG_TEXT_MAX);
  });

  it('what the form would send, the desk accepts — and what the form refuses, the desk refuses', () => {
    const blank = form.automationFormOf(null);
    expect(form.automationErrorOf(blank)).toBeNull();
    expect(deskSettingsBlob.safeParse(form.automationPayloadOf(blank)).success).toBe(true);

    const cases: [Partial<form.AutomationForm>, boolean][] = [
      [{ autoCloseDays: '1' }, true],
      [{ autoCloseDays: String(AUTO_CLOSE_MAX_DAYS) }, true],
      [{ autoCloseDays: '0' }, false],
      [{ autoCloseDays: String(AUTO_CLOSE_MAX_DAYS + 1) }, false],
      [{ autoCloseDays: '2.5' }, false],
      [{ noReplyHours: '1' }, true],
      [{ noReplyHours: String(NO_REPLY_MAX_HOURS) }, true],
      [{ noReplyHours: '0' }, false],
      [{ noReplyHours: String(NO_REPLY_MAX_HOURS + 1) }, false],
      [{ rules: [{ in: 'either', contains: 'refund', tag: 'billing' }] }, true],
      [{ rules: [{ in: 'either', contains: 'refund', tag: '' }] }, false],
      [{ rules: [{ in: 'either', contains: '', tag: 'billing' }] }, false],
      [{ rules: [{ in: 'either', contains: 'x'.repeat(AUTO_TAG_TEXT_MAX + 1), tag: 't' }] }, false],
      [
        {
          rules: Array.from({ length: AUTO_TAG_RULES_MAX + 1 }, (_, i) => ({
            in: 'body' as const,
            contains: `w${i}`,
            tag: 't',
          })),
        },
        false,
      ],
    ];
    for (const [patch, ok] of cases) {
      const f = { ...blank, ...patch };
      expect(form.automationErrorOf(f) === null, JSON.stringify(patch)).toBe(ok);
      if (ok) expect(deskSettingsBlob.safeParse(form.automationPayloadOf(f)).success, JSON.stringify(patch)).toBe(true);
    }
  });

  it('blank rule rows are nothing, and a whole blank form is three nulls — never an empty list', () => {
    const f = { ...form.automationFormOf(null), rules: [{ in: 'either' as const, contains: ' ', tag: '' }] };
    expect(form.automationErrorOf(f)).toBeNull();
    expect(form.automationPayloadOf(f)).toEqual({ autoClose: null, noReplyNotify: null, autoTag: null });
    expect(autoTagRule.safeParse({ in: 'either', contains: '', tag: '' }).success).toBe(false);
  });

  it('round-trips what the desk stores, and reads anything it cannot use as empty', () => {
    const stored = JSON.stringify({
      autoClose: { afterDays: 14 },
      noReplyNotify: { afterHours: 6 },
      autoTag: { rules: [{ in: 'subject', contains: 'refund', tag: 'billing' }] },
    });
    const f = form.automationFormOf(stored);
    expect(f).toEqual({
      autoCloseDays: '14',
      noReplyHours: '6',
      rules: [{ in: 'subject', contains: 'refund', tag: 'billing' }],
    });
    expect(form.automationPayloadOf(f)).toEqual(JSON.parse(stored));

    for (const raw of ['not json', '[]', '{"autoClose":{"afterDays":0}}', '{"autoTag":{"rules":"x"}}', null]) {
      expect(form.automationFormOf(raw)).toEqual({ autoCloseDays: '', noReplyHours: '', rules: [] });
    }
  });

  it('says when a behaviour last fired, and says so when it never has', () => {
    const now = Date.parse('2026-09-30T12:00:00.000Z');
    const runs = [{ behaviour: 'autoClose', last_fired_at: '2026-09-30T09:00:00.000Z', last_count: 3 }];
    expect(form.lastFiredLabel(runs, 'autoClose', now)).toBe('Last fired 3h ago, on 3 conversations.');
    expect(form.lastFiredLabel(runs, 'autoTag', now)).toBe('Has not fired yet.');
  });
});

describe('the roster and the picker', () => {
  const people = [
    { principal: 'a', display_name: 'Ada', offboarded_at: null },
    { principal: 'b', display_name: 'Bo', offboarded_at: '2026-09-01T00:00:00.000Z' },
    { principal: 'x', display_name: ASSISTANT_DISPLAY_NAME, offboarded_at: null },
  ];

  it('the picker offers only people on the desk — the server refuses the other two as an assignee', () => {
    expect(assignableStaff(people).map((p) => p.principal)).toEqual(['a']);
  });

  it('but keeps the conversation’s current holder, so a name is never turned into an id tail', () => {
    expect(assignableStaff(people, 'b').map((p) => p.principal)).toEqual(['a', 'b']);
    expect(assignableStaff(people, 'x').map((p) => p.principal)).toEqual(['a', 'x']);
  });

  it('the roster keeps somebody who left, so they can be put back, and never lists the assistant', () => {
    expect(deskPeople(people).map((p) => p.principal)).toEqual(['a', 'b']);
  });
});
