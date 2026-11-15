/**
 * Todo calling Notes AS the person signed in to Todo (#3161): the routes Todo's dev app mounts
 * through its `routes` option. Harness code, on Todo's side of the pair.
 *
 * Todo holds the person's session; `devDelegate` trades its refresh token for a token addressed to
 * Notes at the issuer, and the broker carries the call with it. Notes' own door says who the
 * person is and what they hold there, and the token's keys (`delegations` in `src/manifest.ts`) are
 * a ceiling over that. Nothing here names a principal: the person is whoever the session is.
 */
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { DevDelegate } from '@substrat-run/dev-issuer';
import { z } from 'zod';

export const NOTES_VIA_TODO = '/api/plugins/notes/notes';

export function notesCallRoutes(delegate: Pick<DevDelegate, 'invoke'>): (app: Hono) => void {
  return (app) => {
    /** The notepad, read as the person: `{ entries, nextCursor }`, one page. */
    app.get(NOTES_VIA_TODO, async (c) =>
      c.json(await delegate.invoke(c.req.raw.headers, 'notes', 'notes/list-notes', {})),
    );

    /** A note written as the person: Notes records them as its author. */
    app.post(NOTES_VIA_TODO, async (c) => {
      const body = z.object({ text: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
      if (!body.success) throw new HTTPException(400, { message: 'text is required' });
      return c.json(await delegate.invoke(c.req.raw.headers, 'notes', 'notes/add-note', { text: body.data.text }));
    });
  };
}
