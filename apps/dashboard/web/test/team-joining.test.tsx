import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Member } from '../src/lib/api';
import { Team } from '../src/views/Team';

/**
 * #1184: an accepted invite is 'joining' until the membership executor has applied it, and
 * 'refused' — with the reason — when it never will be. Both are removable rows, and neither
 * reads as an active member.
 */
const member = (over: Partial<Member>): Member => ({
  id: 'm',
  principal: 'p1',
  email: 'rae@acme.test',
  role_key: 'member',
  status: 'active',
  invitation_id: 'inv-1',
  invited_by: 'p0',
  invited_at: '2026-09-01T00:00:00.000Z',
  joined_at: '2026-09-02T00:00:00.000Z',
  ...over,
});

describe('Team: a membership still being applied, or refused', () => {
  let container: HTMLElement, root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (rows: Member[]) =>
    act(() => {
      root.render(
        <Team members={rows} meEmail="owner@acme.test" canManage onInvite={async () => undefined} onResend={() => undefined} onRevoke={() => undefined} onRemove={() => undefined} />,
      );
    });
  const removeButtons = () => [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Remove');

  it('shows a refused row as not applied, with its reason, and lets an admin remove it', () => {
    render([member({ id: 'r', status: 'refused', refusal: 'the inviter p0 no longer holds dashboard:manage-members' })]);
    expect(container.textContent).toContain('Not applied');
    expect(container.textContent).toContain('no longer holds dashboard:manage-members');
    expect(container.textContent).not.toContain('Active');
    expect(removeButtons()).toHaveLength(1);
  });

  it('shows a joining row as joining, not active', () => {
    render([member({ id: 'j', status: 'joining' })]);
    expect(container.textContent).toContain('Joining');
    expect(container.textContent).not.toContain('Active');
    expect(removeButtons()).toHaveLength(1);
  });
});
