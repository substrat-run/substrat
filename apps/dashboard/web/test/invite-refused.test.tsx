import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InviteBlocked } from '../src/views/SignIn';

/**
 * #1184: an accept the membership executor refused answers 409 with a sentence for the
 * invitee. The block says THAT, not "this invite is for a different email", which is what
 * every failed accept used to read as.
 */
describe('InviteBlocked', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const draw = (refusal?: string) =>
    act(async () =>
      root.render(
        <InviteBlocked teamName="Acme" invitedEmail="rae@acme.test" signedInAs="rae@acme.test" refusal={refusal} onSignOut={vi.fn()} onContinue={vi.fn()} />,
      ),
    );

  it('a refusal shows the server’s reason, and no wrong-email advice', async () => {
    await draw('this invite can no longer be applied: whoever sent it no longer has the access it grants.');
    expect(container.textContent).toMatch(/can’t be applied/);
    expect(container.textContent).toMatch(/no longer has the access it grants/);
    expect(container.textContent).not.toMatch(/different email/);
  });

  it('twin: with no refusal it is the wrong-email block it always was', async () => {
    await draw();
    expect(container.textContent).toMatch(/different email/);
  });
});
