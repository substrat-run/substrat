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
import { mountApi } from './routes.js';

export interface AppOptions {
  host: Pick<ScopeHost, 'getScope'>;
  login: Pick<DevLogin, 'handle'>;
  people: DevPeople;
}

/** What a signed-in person who is not let in is told. No answer says whether they exist. */
const REFUSED = 'the workspace this plugin belongs to does not let you in here';

export function createApp({ host, login, people }: AppOptions): Hono {
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

  mountApi(app, async (c) => {
    const caller = await callerOf(c.req.raw.headers);
    return host.getScope(caller.principal, caller.tenantId, caller.scopeId, { verifiedEmail: caller.verifiedEmail });
  });

  /** Who is signed in. The principal is the person's id in the other app too. */
  app.get('/api/me', async (c) => {
    const caller = await callerOf(c.req.raw.headers);
    return c.json({ principal: caller.principal, display: caller.display });
  });

  return app;
}
