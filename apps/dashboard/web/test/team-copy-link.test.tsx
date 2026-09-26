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

type Link = { acceptUrl: string; expiresAt: string };
const link = (acceptUrl: string): Link => ({ acceptUrl, expiresAt: '2026-10-10T12:00:00.000Z' });

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

  const render = (props: { canManage: boolean; members?: Member[]; onCopyLink?: (id: string) => Promise<Link> }) =>
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
    const onCopyLink = vi.fn(async () => link('https://x.test/invite/tok'));
    render({ canManage: true, onCopyLink });
    expect(copyButtons()).toHaveLength(1);
    await act(async () => copyButtons()[0]!.click());
    expect(onCopyLink).toHaveBeenCalledWith('inv-1');
    expect(writeText).toHaveBeenCalledWith('https://x.test/invite/tok');
    const input = document.querySelector('input[value="https://x.test/invite/tok"]');
    expect(input).not.toBeNull();
    expect(document.body.textContent).toContain('No email was sent');
    expect(document.body.textContent).toContain('Copied.');
    expect(document.body.textContent).toMatch(/expires .*2026/);
    expect(document.body.textContent).not.toContain('14 days');
  });

  it('is absent without manage rights', () => {
    render({ canManage: false, onCopyLink: async () => link('u') });
    expect(copyButtons()).toHaveLength(0);
  });

  it('is absent on an accepted or revoked row', () => {
    render({
      canManage: true,
      onCopyLink: async () => link('u'),
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

  it('says Copied only when the clipboard write succeeded', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    render({ canManage: true, onCopyLink: async () => link('https://x.test/invite/tok') });
    await act(async () => copyButtons()[0]!.click());
    expect(document.querySelector('input[value="https://x.test/invite/tok"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Copied');
    // The dialog's own Copy button: a refused write is not "Copied" either …
    writeText.mockRejectedValueOnce(new Error('denied'));
    const copy = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Copy')!;
    await act(async () => copy.click());
    expect(document.body.textContent).not.toContain('Copied');
    // … and its twin: a working one is.
    await act(async () => copy.click());
    expect(document.body.textContent).toContain('Copied');
  });

  it('ignores a late result once the dialog was closed', async () => {
    let resolve!: (l: Link) => void;
    const onCopyLink = vi.fn(() => new Promise<Link>((r) => (resolve = r)));
    render({ canManage: true, onCopyLink });
    await act(async () => copyButtons()[0]!.click());
    const done = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Done')!;
    await act(async () => done.click());
    await act(async () => resolve(link('https://x.test/invite/late')));
    expect(document.querySelector('input[value="https://x.test/invite/late"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Invite link');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('ignores a slow earlier request when another row was clicked', async () => {
    const two = [...ROSTER, member({ id: 'c', email: 'lee@acme.test', invitation_id: 'inv-2' })];
    const pending: Record<string, (l: Link) => void> = {};
    const onCopyLink = vi.fn((id: string) => new Promise<Link>((r) => (pending[id] = r)));
    render({ canManage: true, members: two, onCopyLink });
    await act(async () => copyButtons()[0]!.click());
    await act(async () => copyButtons()[1]!.click());
    await act(async () => pending['inv-2']!(link('https://x.test/invite/lee')));
    await act(async () => pending['inv-1']!(link('https://x.test/invite/rae')));
    expect(document.querySelector('input[value="https://x.test/invite/lee"]')).not.toBeNull();
    expect(document.querySelector('input[value="https://x.test/invite/rae"]')).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('announces the dialog’s loading, error and ready states through a polite live region', async () => {
    let resolve!: (l: Link) => void;
    render({ canManage: true, onCopyLink: () => new Promise<Link>((r) => (resolve = r)) });
    await act(async () => copyButtons()[0]!.click());
    const region = () => document.querySelector('[role="status"][aria-live="polite"]');
    expect(region()?.textContent).toContain('Reading the link');
    await act(async () => resolve(link('https://x.test/invite/tok')));
    expect(region()?.textContent).toContain('No email was sent');
  });
});
