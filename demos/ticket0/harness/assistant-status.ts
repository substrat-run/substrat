/**
 * Is the assistant answering? — the one read that needs both halves.
 *
 * The declared `ticket0/assistant-health` counts the failed turns; that is data and
 * lives in the module. Which model this install would run, and whether it is a model
 * at all, is a fact about the HOST's environment — `CF_ACCOUNT_ID` and `CF_AI_TOKEN`
 * resolved per install — which module code cannot read and should not guess at. So
 * both hosts mount this one route, and it puts the two side by side.
 *
 * Authorised by doing, not by a check of its own: it invokes the declared operation,
 * which refuses anyone without `desk:configure`, and only then adds the model. That
 * keeps the label of a paid credential behind the same key as the failures it
 * explains.
 */
import type { Context, Hono } from 'hono';
import type { ResolveStub } from '@substrat-run/vertical-host';
import type { Model } from './assistant.js';

export interface AssistantStatus {
  /** The model's label as a turn would record it — `workers-ai/…` or `offline/extractive`. */
  readonly model: string;
  /** False when the desk is quoting the documentation because it has no credential to generate. */
  readonly generative: boolean;
  readonly health: {
    since: string;
    turns: number;
    failed: number;
    recent: {
      id: string;
      conversation_id: string;
      subject: string;
      model: string;
      error: string | null;
      created_at: string;
    }[];
  };
}

/** `GET /api/assistant/status` → {@link AssistantStatus}, as the caller. */
export function mountAssistantStatus(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any, any, any>,
  resolveStub: ResolveStub,
  modelFor: (c: Context) => Model | Promise<Model>,
): void {
  app.get('/api/assistant/status', async (c) => {
    const scope = await resolveStub(c);
    const health = (await scope.invoke('ticket0/assistant-health', {})) as AssistantStatus['health'];
    const model = await modelFor(c);
    const status: AssistantStatus = {
      model: model.label,
      generative: !model.label.startsWith('offline/'),
      health,
    };
    return c.json(status);
  });
}
