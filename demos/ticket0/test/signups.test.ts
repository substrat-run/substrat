/**
 * The waiting list and the newsletter list — double opt-in, from the open internet.
 *
 * Every test here drives an OPERATION as the principal that would really make the
 * call: the desk's signup service for the public door, `desk-admin` for the list.
 * Nothing reads the table directly except the one place that has to stand in for a
 * mail client, and that is called out where it happens.
 *
 * Time moves on purpose, through a `manualClock`, because two of the rules this file
 * exists to hold are about elapsed time: the resend throttle, and the hour the new-
 * address ceiling counts over. Shrinking either window to zero to get a pass would
 * leave both untested, which is the state this suite was written to end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualClock, type ManualClock, type ScopeHost, type ScopeStub } from '@substrat-run/kernel';
import type { CountedPage } from '@substrat-run/contracts';
import { SIGNUP_HOURLY_MAX, SIGNUP_RESEND_SECONDS } from '../spec/model.js';
import { buildHost, seed, type Desk, type World } from '../src/seed.js';

let dir: string;
let host: ScopeHost;
let world: World;
let clock: ManualClock;

/** The origin the seeded Substrat desk actually lists. Anything else is refused. */
let origin = '';

interface Submitted {
  id: string;
  kind: 'waitlist' | 'newsletter';
  state: 'pending' | 'confirmed' | 'unsubscribed';
  confirmToken: string | null;
  unsubscribeToken: string;
}
interface SignupRow {
  id: string;
  kind: string;
  email: string;
  unsubscribe_token: string;
  note: string | null;
  state: string;
  origin: string;
  requested_at: string;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
}

/** The public door: the desk's signup service, which is what the host acts as. */
async function door(desk: Desk): Promise<ScopeStub> {
  return host.getScope(desk.signup.principal, desk.tenant, desk.scope);
}

/** The list, as the one role that may read it. */
async function admin(desk: Desk): Promise<ScopeStub> {
  return host.getScope(desk.admin.principal, desk.tenant, desk.scope);
}

async function submit(
  desk: Desk,
  input: { kind: 'waitlist' | 'newsletter'; email: string; note?: string | null; origin?: string },
): Promise<Submitted> {
  return (await (await door(desk)).invoke('ticket0/submit-signup', {
    kind: input.kind,
    email: input.email,
    note: input.note ?? null,
    origin: input.origin ?? origin,
  })) as Submitted;
}

/** Every row on a list, read the way the screen reads it. */
async function list(desk: Desk, filters: Record<string, string> = {}): Promise<SignupRow[]> {
  const page = (await (await admin(desk)).invoke('ticket0/list-signups', {
    ...filters,
    limit: 100,
  })) as CountedPage<SignupRow>;
  return page.entries;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ticket0-signups-'));
  clock = manualClock('2026-03-02T09:00:00.000Z');
  host = buildHost(dir, clock.read);
  world = await seed(host);
  const declared = (await (await door(world.substrat)).invoke('ticket0/signup-origins', {})) as {
    origins: string[];
  };
  origin = declared.origins[0] as string;
  expect(origin).toBeTruthy();
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the door', () => {
  it('refuses a page the desk has not listed', async () => {
    await expect(
      submit(world.substrat, {
        kind: 'waitlist',
        email: 'nowhere@example.com',
        origin: 'https://not-listed.example',
      }),
    ).rejects.toThrow(/takes no signups/);
  });

  /**
   * The two lists are separate doors into one table, and this is what says so: the
   * same address on both is two rows, and neither knows about the other.
   */
  it('lets one address be on both lists', async () => {
    const both = 'both@customer.example';
    const a = await submit(world.substrat, { kind: 'waitlist', email: both });
    const b = await submit(world.substrat, { kind: 'newsletter', email: both });
    expect(a.id).not.toBe(b.id);
    expect(a.confirmToken).toBeTruthy();
    expect(b.confirmToken).toBeTruthy();
  });

  /**
   * One desk cannot see another's list. Not a permission check — `desk-admin` on the
   * Substrat desk genuinely holds `signup:read` — but a SCOPE boundary, which is the
   * thing that would still hold if the permission were misconfigured.
   */
  it('keeps one desk’s list out of another desk’s reach', async () => {
    const kestrelRows = await list(world.kestrel);
    expect(kestrelRows.map((r) => r.email)).not.toContain('both@customer.example');
  });
});

describe('nobody is on a list until they click', () => {
  const address = 'quiet@customer.example';
  let token = '';

  it('starts pending, and says so', async () => {
    const result = await submit(world.substrat, {
      kind: 'waitlist',
      email: address,
      note: 'A field-service app for lift inspections.',
    });
    expect(result.state).toBe('pending');
    token = result.confirmToken as string;
    expect(token).toBeTruthy();

    const row = (await list(world.substrat, { kind: 'waitlist', state: 'pending' })).find(
      (r) => r.email === address,
    );
    expect(row).toBeDefined();
    expect(row?.note).toBe('A field-service app for lift inspections.');
  });

  /**
   * The read is what a screen and an export both go through. It must not hand back the
   * capability that MANUFACTURES a consent record — and it must hand back the one that
   * only removes, because the Monday send needs a way out for every recipient and a
   * sender that cannot see the token cannot put one in the mail.
   */
  it('withholds the confirm hash and returns the unsubscribe token', async () => {
    const row = (await list(world.substrat, { kind: 'waitlist', state: 'pending' })).find(
      (r) => r.email === address,
    );
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('confirm_token_hash');
    expect(row?.unsubscribe_token).toBeTruthy();
  });

  it('confirms when the link is clicked', async () => {
    const confirmed = (await (await door(world.substrat)).invoke('ticket0/confirm-signup', {
      token,
    })) as SignupRow;
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.confirmed_at).not.toBeNull();
  });

  /**
   * The link works ONCE. The hash is nulled when it is spent, so a second click finds
   * nothing — which is also why a spent link and a forged one are the same answer.
   */
  it('refuses the same link a second time', async () => {
    await expect(
      (await door(world.substrat)).invoke('ticket0/confirm-signup', { token }),
    ).rejects.toThrow(/not valid/);
  });

  it('refuses a token nobody ever issued', async () => {
    await expect(
      (await door(world.substrat)).invoke('ticket0/confirm-signup', { token: 'not-a-real-token' }),
    ).rejects.toThrow(/not valid/);
  });
});

describe('a second submission', () => {
  const address = 'again@customer.example';

  it('re-issues nothing inside the throttle', async () => {
    const first = await submit(world.substrat, { kind: 'newsletter', email: address });
    expect(first.confirmToken).toBeTruthy();

    // Same person, same minute — a double click, a back button, an impatient reload.
    const second = await submit(world.substrat, { kind: 'newsletter', email: address });
    expect(second.id).toBe(first.id);
    expect(second.confirmToken).toBeNull();

    // And still one row, not two.
    const rows = await list(world.substrat, { kind: 'newsletter' });
    expect(rows.filter((r) => r.email === address)).toHaveLength(1);
  });

  it('re-issues once the throttle has lapsed — the mail never arrived', async () => {
    clock.advance((SIGNUP_RESEND_SECONDS + 1) * 1000);
    const third = await submit(world.substrat, { kind: 'newsletter', email: address });
    expect(third.confirmToken).toBeTruthy();
  });

  /**
   * The membership oracle, closed. An address already confirmed gets the same shaped
   * answer as a first-time one — no error, no token, nothing a stranger could use to
   * ask this form who is on the list one address at a time.
   */
  it('says nothing about an address that is already confirmed', async () => {
    const confirmed = 'known@customer.example';
    const first = await submit(world.substrat, { kind: 'newsletter', email: confirmed });
    await (await door(world.substrat)).invoke('ticket0/confirm-signup', {
      token: first.confirmToken,
    });

    const again = await submit(world.substrat, { kind: 'newsletter', email: confirmed });
    expect(again.state).toBe('confirmed');
    expect(again.confirmToken).toBeNull();
  });
});

describe('leaving, and coming back', () => {
  const address = 'left@customer.example';
  let unsubscribe = '';

  it('takes the address off the list', async () => {
    const joined = await submit(world.substrat, { kind: 'newsletter', email: address });
    await (await door(world.substrat)).invoke('ticket0/confirm-signup', {
      token: joined.confirmToken,
    });

    // Straight off the submission, which is where the host gets it too. It used to be
    // hashed and dropped, which made the unsubscribe link unbuildable in production and
    // forced this test to write a known hash into the row to have anything to click.
    unsubscribe = joined.unsubscribeToken;
    expect(unsubscribe).toBeTruthy();

    const gone = (await (await door(world.substrat)).invoke('ticket0/unsubscribe-signup', {
      token: unsubscribe,
    })) as SignupRow;
    expect(gone.state).toBe('unsubscribed');
    expect(gone.unsubscribed_at).not.toBeNull();
  });

  /**
   * The property an unsubscribe link must have: it is read out of a mail archive by
   * somebody who is annoyed, and clicking it twice must not greet them with an error.
   */
  it('is safe to click twice', async () => {
    const again = (await (await door(world.substrat)).invoke('ticket0/unsubscribe-signup', {
      token: unsubscribe,
    })) as SignupRow;
    expect(again.state).toBe('unsubscribed');
  });

  /**
   * `unsubscribed` is not terminal, and this is why. Somebody who left and typed
   * their address in again is asking a second time — and the honest way to honour it
   * is a fresh confirmation rather than a silent re-add.
   */
  it('lets somebody sign up again, with a fresh confirmation', async () => {
    clock.advance((SIGNUP_RESEND_SECONDS + 1) * 1000);
    const back = await submit(world.substrat, { kind: 'newsletter', email: address });
    expect(back.state).toBe('pending');
    expect(back.confirmToken).toBeTruthy();

    const rows = await list(world.substrat, { kind: 'newsletter' });
    const row = rows.find((r) => r.email === address);
    // The contradiction that must not survive the way back in: a row reading `pending`
    // while a date beside it says the person left.
    expect(row?.state).toBe('pending');
    expect(row?.unsubscribed_at).toBeNull();
  });
});

describe('the ceiling on new addresses', () => {
  /**
   * The flood this guards against is not one address hammered — that is the throttle —
   * but a script naming ten thousand DIFFERENT people, every one of whom would get a
   * confirmation email from the platform's own sending domain.
   */
  it('refuses new addresses once the hour’s allowance is spent', async () => {
    const desk = world.kestrel;
    const kestrelOrigin = (
      (await (await door(desk)).invoke('ticket0/signup-origins', {})) as { origins: string[] }
    ).origins[0] as string;

    const existing = (await list(desk)).length;
    for (let i = existing; i < SIGNUP_HOURLY_MAX; i += 1) {
      await submit(desk, { kind: 'newsletter', email: `flood${i}@example.com`, origin: kestrelOrigin });
    }

    await expect(
      submit(desk, { kind: 'newsletter', email: 'one-too-many@example.com', origin: kestrelOrigin }),
    ).rejects.toThrow(/as many new signups this hour as it will/);
  });

  /**
   * And it is a ceiling on NEW addresses only. Somebody already on the list must still
   * be able to ask for their confirmation again while the desk is full — otherwise a
   * flood locks out the very people it did not affect.
   */
  it('still re-issues for an address already on the list', async () => {
    const desk = world.kestrel;
    clock.advance((SIGNUP_RESEND_SECONDS + 1) * 1000);
    const kestrelOrigin = (
      (await (await door(desk)).invoke('ticket0/signup-origins', {})) as { origins: string[] }
    ).origins[0] as string;
    const again = await submit(desk, {
      kind: 'newsletter',
      email: 'flood0@example.com',
      origin: kestrelOrigin,
    });
    expect(again.confirmToken).toBeTruthy();
  });

  it('lets new addresses in again once the hour has passed', async () => {
    const desk = world.kestrel;
    clock.advance(61 * 60 * 1000);
    const kestrelOrigin = (
      (await (await door(desk)).invoke('ticket0/signup-origins', {})) as { origins: string[] }
    ).origins[0] as string;
    const fresh = await submit(desk, {
      kind: 'newsletter',
      email: 'after-the-hour@example.com',
      origin: kestrelOrigin,
    });
    expect(fresh.state).toBe('pending');
  });
});

describe('the things a review found', () => {
  /**
   * Casing. `z.string().email()` accepts any, so `Markus@Example.com` and
   * `markus@example.com` used to become two rows — two confirmation emails to one
   * person, and a resend throttle that applied to neither of them.
   */
  it('treats one address as one person whatever they capitalised', async () => {
    const first = await submit(world.substrat, { kind: 'waitlist', email: 'Mixed.Case@Customer.Example' });
    const second = await submit(world.substrat, { kind: 'waitlist', email: 'mixed.case@customer.example' });
    expect(second.id).toBe(first.id);
    // Inside the throttle, so no second mail either — which is the consequence that
    // matters and the one the two-row bug silently removed.
    expect(second.confirmToken).toBeNull();

    const rows = (await list(world.substrat, { kind: 'waitlist' })).filter(
      (r) => r.email.toLowerCase() === 'mixed.case@customer.example',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email).toBe('mixed.case@customer.example');
  });

  /**
   * The unsubscribe token has to be READABLE, or the "unsubscribe link that always
   * works" the signup form promises can never be put in an email. It was hashed and
   * the plaintext dropped, so no host could build one.
   */
  it('hands back an unsubscribe token even when there is nothing to confirm', async () => {
    const address = 'settled@customer.example';
    const first = await submit(world.substrat, { kind: 'newsletter', email: address });
    await (await door(world.substrat)).invoke('ticket0/confirm-signup', {
      token: first.confirmToken,
    });

    const again = await submit(world.substrat, { kind: 'newsletter', email: address });
    expect(again.confirmToken).toBeNull();
    // Every mail needs a way out, including one sent to somebody already confirmed.
    expect(again.unsubscribeToken).toBe(first.unsubscribeToken);
  });

  /**
   * And it must be STABLE. Re-minting it on a re-submission would silently break every
   * copy of the link the person still has in their mail archive.
   */
  it('keeps the same unsubscribe token across a re-issued confirmation', async () => {
    const address = 'stable@customer.example';
    const first = await submit(world.substrat, { kind: 'waitlist', email: address });
    clock.advance((SIGNUP_RESEND_SECONDS + 1) * 1000);
    const reissued = await submit(world.substrat, { kind: 'waitlist', email: address });

    expect(reissued.confirmToken).toBeTruthy();
    expect(reissued.confirmToken).not.toBe(first.confirmToken);
    expect(reissued.unsubscribeToken).toBe(first.unsubscribeToken);
  });
});

describe('who may read the list', () => {
  it('is not the service that writes to it', async () => {
    await expect((await door(world.substrat)).invoke('ticket0/list-signups', {})).rejects.toThrow();
  });

  it('is not an agent working the inbox', async () => {
    const desk = world.substrat;
    const agent = await host.getScope(desk.agent.principal, desk.tenant, desk.scope);
    await expect(agent.invoke('ticket0/list-signups', {})).rejects.toThrow();
  });

  it('is desk-admin, who also gets the counts the screen needs', async () => {
    const { counts } = (await (await admin(world.substrat)).invoke(
      'ticket0/signup-counts',
      {},
    )) as { counts: { kind: string; state: string; count: number }[] };
    const confirmed = counts.filter((c) => c.state === 'confirmed');
    expect(confirmed.length).toBeGreaterThan(0);
    // The counts and the rows are the same table asked two ways, so they agree.
    const rows = await list(world.substrat, { state: 'confirmed' });
    const total = confirmed.reduce((sum, c) => sum + c.count, 0);
    expect(total).toBe(rows.length);
  });
});
