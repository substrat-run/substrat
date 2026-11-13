/**
 * The HTTP app the dev server serves — built here so a test drives the same wiring a browser
 * does.
 *
 * The one thing that differs from a vertical that owns its people is who answers "who is
 * calling". There is no directory lookup and no join: `people` asks the app that owns the
 * people (`devPeople`, the person contract's door), and its three answers are the three
 * statuses below.
 */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { invocationLog } from '@substrat-run/vertical-host';
import type { DevCaller, DevLogin, DevPeople } from '@substrat-run/dev-issuer';
import type { ScopeHost } from '@substrat-run/kernel';
import { z } from 'zod';
import { mountApi } from './routes.js';

/** What Todo answers when asked whether a person may see a list or an item (`todo/vouch-access`). */
export interface Vouch {
  visible: boolean;
  listId: string | null;
}

export interface AppOptions {
  host: Pick<ScopeHost, 'getScope'>;
  login: Pick<DevLogin, 'handle'>;
  people: DevPeople;
  /** Ask Todo whether `principal` may see the list or item: the peer call to `todo/vouch-access`. */
  vouch: (principal: string, at: { listId: string } | { itemId: string }) => Promise<unknown>;
}

const vouchAnswer = z.object({ visible: z.boolean(), listId: z.string().nullable() });

/** What a signed-in person who is not let in is told. No answer says whether they exist. */
const REFUSED = 'the workspace this plugin belongs to does not let you in here';

export function createApp({ host, login, people, vouch }: AppOptions): Hono {
  const app = new Hono();
  app.use('*', invocationLog());

  // The relying-party endpoints. Accounts live at the issuer, and people in the other app.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => login.handle(c.req.raw));

  /** 401 for nobody, 403 for a login the other app does not let in, 503 when it did not answer. */
  const callerOf = async (headers: Headers): Promise<DevCaller> => {
    const answer = await people.caller(headers);
    if (answer === null) throw new HTTPException(401, { message: 'unauthorized' });
    if ('refused' in answer) {
      if (answer.refused === 'unavailable') {
        throw new HTTPException(503, { message: 'the workspace this plugin belongs to did not answer' });
      }
      throw new HTTPException(403, { message: REFUSED });
    }
    return answer.caller;
  };

  const scopeOf = (caller: DevCaller) =>
    host.getScope(caller.principal, caller.tenantId, caller.scopeId, { verifiedEmail: caller.verifiedEmail });

  /**
   * Notes on Todo's items, behind Todo's word. A note on an item is for the people who may see
   * that item, and only Todo knows who they are, so both routes ask it first and answer 403 for
   * a list or item the caller may not see, or that does not exist: the same answer, so nobody
   * learns which ids are real. Todo not answering is 503, as for sign-in. The operations
   * behind these have no route of their own.
   */
  const vouched = async (caller: DevCaller, at: { listId: string } | { itemId: string }): Promise<string> => {
    let answer: Vouch;
    try {
      answer = vouchAnswer.parse(await vouch(caller.principal, at));
    } catch (error) {
      console.warn(`notes: todo did not vouch for ${caller.principal}: ${error instanceof Error ? error.message : String(error)}`);
      throw new HTTPException(503, { message: 'the workspace this plugin belongs to did not answer' });
    }
    if (!answer.visible || answer.listId === null) throw new HTTPException(403, { message: 'not a list or item you may see' });
    return answer.listId;
  };

  app.get('/api/lists/:listId/item-notes', async (c) => {
    const caller = await callerOf(c.req.raw.headers);
    const listId = await vouched(caller, { listId: c.req.param('listId') });
    // One page, at the ceiling: a list's notes are read together, and the screen says if there are more.
    const page = await (await scopeOf(caller)).invoke<{ entries: unknown[] }, unknown>('notes/list-item-notes', { listId, limit: 100 });
    return c.json(page);
  });

  app.post('/api/items/:itemId/notes', async (c) => {
    const caller = await callerOf(c.req.raw.headers);
    const body = z.object({ text: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) throw new HTTPException(400, { message: 'text is required' });
    const itemId = c.req.param('itemId');
    const listId = await vouched(caller, { itemId });
    return c.json(await (await scopeOf(caller)).invoke('notes/add-item-note', { itemId, listId, text: body.data.text }));
  });

  mountApi(app, async (c) => scopeOf(await callerOf(c.req.raw.headers)));

  /** Who is signed in. The principal is the person's id in the other app too. */
  app.get('/api/me', async (c) => {
    const caller = await callerOf(c.req.raw.headers);
    return c.json({ principal: caller.principal, display: caller.display });
  });

  return app;
}
