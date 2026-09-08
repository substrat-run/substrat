/**
 * Who the desk offers as somebody to hand a conversation to (#1154).
 *
 * `ticket0_agent_profiles` is two things at once, and the bug was a screen forgetting
 * which one it held: the assistant has a row so its messages carry a name instead of a
 * ULID, and that same row put it in the assignee picker and on the "On the desk"
 * roster. The app narrows the second use and leaves the first alone.
 *
 * It narrows by DISPLAY NAME, because a browser has nothing else to go on — module code
 * cannot ask which role a principal holds, which is why `post-public-reply` decides an
 * author's kind and `notifyStaff` decides who to tell the same way. One rule about who
 * the assistant is, spelled on both sides of the wire; the first case here is what stops
 * the two spellings drifting apart in silence.
 */
import { describe, expect, it } from 'vitest';
import { ASSISTANT_NAME } from '../src/module.js';
import { ASSISTANT_DISPLAY_NAME, assignableStaff } from '../app/src/staff.js';

const profile = (principal: string, display_name: string) => ({ principal, display_name });

describe('the assignee directory', () => {
  it('spells the assistant the same way the module does', () => {
    // A rename that only lands on one side puts the assistant back in the picker and
    // breaks nothing visible — exactly the failure nobody would notice.
    expect(ASSISTANT_DISPLAY_NAME).toBe(ASSISTANT_NAME);
  });

  it('offers the people and not the assistant', () => {
    const staff = [
      profile('01AGENT', 'Rae Okonjo'),
      profile('01ASSISTANT', ASSISTANT_NAME),
      profile('01OTHER', 'Sam Delaney'),
    ];
    expect(assignableStaff(staff).map((a) => a.principal)).toEqual(['01AGENT', '01OTHER']);
  });

  it('leaves the directory it was given alone, so names still resolve', () => {
    // The half that must NOT change: `agentName` reads the same map to give an
    // assistant-authored message a byline, so the filter has to be a copy.
    const staff = new Map([
      ['01ASSISTANT', profile('01ASSISTANT', ASSISTANT_NAME)],
      ['01AGENT', profile('01AGENT', 'Rae Okonjo')],
    ]);
    expect(assignableStaff(staff.values())).toHaveLength(1);
    expect(staff.get('01ASSISTANT')?.display_name).toBe(ASSISTANT_NAME);
  });
});
