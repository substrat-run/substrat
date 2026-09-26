import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member } from '../src/lib/api';
import { Team } from '../src/views/Team';

const member = (over: Partial<Member>): Member => ({
  id: 'm',
  principal: null,
  email: 'x@acme.test',
  role_key: 'member',
  status: 'invited',
  invitation_id: 'inv-1',
  invited_by: 'p',
  invited_at: '2026-09-01T00:00:00.000Z',
  joined_at: null,
  ...over,
});
const ROSTER = [
  member({ id: 'a', email: 'owner@acme.test', role_key: 'owner', status: 'active', invitation_id: null, principal: 'p0' }),
  member({ id: 'b', email: 'rae@acme.test', invitation_id: 'inv-1' }),
];

describe('Team: Copy link on a pending invite', () => {
  let container: HTMLElement;
  let root: Root;
  const writeText = vi.fn(async () => undefined);

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    writeText.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  const render = (props: { canManage: boolean; members?: Member[]; onCopyLink?: (id: string) => Promise<string> }) =>
    act(() => {
      root.render(
        <Team
          members={props.members ?? ROSTER}
          meEmail="owner@acme.test"
          canManage={props.canManage}
          onInvite={async () => undefined}
          onCopyLink={props.onCopyLink}
          onResend={() => undefined}
          onRevoke={() => undefined}
          onRemove={() => undefined}
        />,
      );
    });
  const copyButtons = () => [...document.querySelectorAll('button')].filter((b) => b.textContent === 'Copy link');

  it('shows once, on the invited row only, and clicking it shows and copies the link', async () => {
    const onCopyLink = vi.fn(async () => 'https://x.test/invite/tok');
    render({ canManage: true, onCopyLink });
    expect(copyButtons()).toHaveLength(1);
    await act(async () => copyButtons()[0]!.click());
    expect(onCopyLink).toHaveBeenCalledWith('inv-1');
    expect(writeText).toHaveBeenCalledWith('https://x.test/invite/tok');
    const input = document.querySelector('input[value="https://x.test/invite/tok"]');
    expect(input).not.toBeNull();
    expect(document.body.textContent).toContain('No email was sent');
  });

  it('is absent without manage rights', () => {
    render({ canManage: false, onCopyLink: async () => 'u' });
    expect(copyButtons()).toHaveLength(0);
  });

  it('is absent on an accepted or revoked row', () => {
    render({
      canManage: true,
      onCopyLink: async () => 'u',
      members: [member({ status: 'active', principal: 'p' }), member({ id: 'c', status: 'revoked' })],
    });
    expect(copyButtons()).toHaveLength(0);
  });

  it('a failed read says so and shows no link', async () => {
    render({ canManage: true, onCopyLink: async () => { throw new Error('boom'); } });
    await act(async () => copyButtons()[0]!.click());
    expect(document.body.textContent).toContain('Could not read the invite link: boom');
    expect(writeText).not.toHaveBeenCalled();
  });
});
