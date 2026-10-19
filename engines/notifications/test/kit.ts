/**
 * What the node suites share: the platform's settle of one send, played the way its drain plays
 * it, the two reads every suite asserts on, and a `ctx` whose digest write fails for one person.
 * Nothing here sends mail.
 */
import {
  isPlatformRequest,
  platformRequestId,
  PLATFORM_REQUEST_ENTITY_TYPE,
  type DomainEventInput,
  type EntityRef,
  type Page,
  type PlatformRequest,
} from '@substrat-run/contracts';
import type { OperationContext } from '@substrat-run/kernel';
import type { EngineHarness } from '@substrat-run/engine-test-kit';
import { NOTIFICATIONS_PERM } from '../src/index.js';

/** Every send intent the scope wrote, oldest first. */
export const intentsOf = async (h: EngineHarness): Promise<PlatformRequest[]> =>
  (await h.host.listPlatformRequestHistory(h.tenant, h.scope)).filter(isPlatformRequest);

/** The delivery log, read as an administrator holding `notifications:read`. */
export async function deliveriesOf(h: EngineHarness, filter: { status?: string; topic?: string } = {}) {
  const admin = await h.as([NOTIFICATIONS_PERM.read]);
  return (await admin.invoke<Page<Record<string, unknown>>>('notifications/list-deliveries', filter)).entries;
}

/**
 * The platform's outcome for one send, through `settlePlatformRequest` — the settle the real
 * drain calls. Its event is about the mail's `about`, or the request itself when it has none.
 */
export const settleEmail = (
  h: EngineHarness,
  type: 'email.sent' | 'email.refused' | 'email.dead-lettered',
  request: string,
  { code = null, about = null }: { code?: string | null; about?: EntityRef | null } = {},
) =>
  h.host.settlePlatformRequest(h.tenant, h.scope, platformRequestId.parse(request), {
    status: type === 'email.sent' ? 'done' : 'failed',
    event: {
      type,
      entity: about ?? { entityType: PLATFORM_REQUEST_ENTITY_TYPE, entityId: request },
      payload: {
        request: platformRequestId.parse(request),
        about,
        sender: 'platform',
        messageId: type === 'email.sent' ? 'msg-1' : null,
        attempts: 1,
        code,
        status: null,
      },
    },
  });

/**
 * `ctx` with the `digest-sent` emit failing for one person — a failure AFTER that person's send,
 * delivery, settle and delete were written, which is what the per-person sub-transaction exists
 * to undo.
 */
export const failingFor =
  (victim: string) =>
  (ctx: OperationContext): OperationContext =>
    new Proxy(ctx, {
      get(target, prop) {
        if (prop === 'emit') {
          return (event: DomainEventInput) => {
            if (event.type === 'notifications.digest-sent' && (event.payload as { principal: string }).principal === victim) {
              throw new Error('the digest-sent write failed');
            }
            target.emit(event);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
