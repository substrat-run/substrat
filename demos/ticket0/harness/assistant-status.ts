/**
 * Is the assistant answering? — the one read that needs both halves.
 *
 * The declared `ticket0/assistant-health` counts the failed turns; that is data and
 * lives in the module. Which model this install would run, whether the platform can
 * run it, and where inference happens are facts about the HOST — the desk's
 * `TICKET0_MODEL` resolved per install against the platform's model host (#1054) —
 * which module code cannot read and should not guess at. So both hosts mount this one
 * route, and it puts the two side by side.
 *
 * Authorised by doing, not by a check of its own: it invokes the declared operation,
 * which refuses anyone without `desk:configure`, and only then adds the model. That
 * keeps the label of a paid credential behind the same key as the failures it
 * explains.
 */
import type { Context, Hono } from 'hono';
import type { ResolveStub } from '@substrat-run/vertical-host';
import type { ModelDescription } from './assistant.js';

export interface AssistantStatus {
  /** The model's label as a turn would record it — `cloudflare/@cf/…` or `offline/extractive`. */
  readonly model: string;
  /** False when the desk is quoting the documentation because the platform cannot run its model. */
  readonly generative: boolean;
  /** The desk's `provider:model`, defaulted. */
  readonly spec: string;
  /** Whether the platform holds what that provider needs, and what it is missing when not. */
  readonly configured: boolean;
  readonly missing: readonly string[];
  /** Where inference runs and what is sent there — the D-54 disclosure. */
  readonly hosting: { vendor: string; location: string; host: string; dataNote: string } | null;
  readonly health: {
    since: string;
    turns: number;
    failed: number;
    /** Written and not sent. A supervised desk produces nothing else. */
    drafted: number;
    /** The desk answers through the supervised principal: it drafts, a person sends. */
    supervised: boolean;
    recent: {
      id: string;
      conversation_id: string;
      subject: string;
      model: string;
      error: string | null;
      created_at: string;
    }[];
    /** Waiting for a person, at ANY age — not only inside the window above. */
    waitingTotal: number;
    /** The newest drafted answers, so a panel can send somebody to them. */
    waiting: {
      id: string;
      conversation_id: string;
      subject: string;
      model: string;
      created_at: string;
    }[];
  };
}

/** `GET /api/assistant/status` → {@link AssistantStatus}, as the caller. */
export function mountAssistantStatus(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
  describe: (c: Context) => ModelDescription | Promise<ModelDescription>,
): void {
  app.get('/api/assistant/status', async (c) => {
    const scope = await resolveStub(c);
    const health = (await scope.invoke('ticket0/assistant-health', {})) as AssistantStatus['health'];
    const model = await describe(c);
    const status: AssistantStatus = {
      model: model.label,
      generative: model.generative,
      spec: model.spec,
      configured: model.configured,
      missing: model.missing,
      hosting: model.hosting,
      health,
    };
    return c.json(status);
  });
}
