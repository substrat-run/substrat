import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type AppRow } from '../src/lib/api';
import { AppMembers } from '../src/views/AppDetail';

/**
 * #2064: a member change that went through but whose admin-log row could not be written arrives
 * as a SUCCESS carrying `auditWarning`. The invite's one-time link must be shown, with a warning
 * that says nothing needs redoing, and never as the red error a user retries into a second invite.
 */
describe('AppMembers: a change whose audit row was lost', () => {
  let container: HTMLDivElement;
  let root: Root;
  const app = { app_scope_id: 'scope-1' } as AppRow;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.spyOn(api, 'appMembers').mockResolvedValue({ roles: ['agent'], members: [], invites: [] });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const invite = async () => {
    await act(async () => root.render(<AppMembers app={app} />));
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Create invite link')!;
    await act(async () => button.click());
  };

  it('shows the link and a warning that the change was made — no error', async () => {
    vi.spyOn(api, 'appInviteMember').mockResolvedValue({
      principal: 'p1', roleKey: 'agent', email: null, acceptUrl: 'https://desk.example/?invite=once',
      operationId: 'op-1', auditWarning: 'the invite completed, but its outcome could not be written to the admin log: log down',
    });
    await invite();
    expect(container.textContent).toContain('https://desk.example/?invite=once');
    const warning = container.querySelector('[role="status"]');
    expect(warning?.textContent).toMatch(/The change was made/);
    expect(warning?.textContent).toMatch(/nothing to redo/);
    expect(warning?.textContent).toMatch(/outcome could not be written/);
    expect(api.appInviteMember).toHaveBeenCalledTimes(1);
  });

  it('twin: a plain success shows the link and no warning', async () => {
    vi.spyOn(api, 'appInviteMember').mockResolvedValue({
      principal: 'p1', roleKey: 'agent', email: null, acceptUrl: 'https://desk.example/?invite=once', operationId: 'op-2',
    });
    await invite();
    expect(container.textContent).toContain('https://desk.example/?invite=once');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
