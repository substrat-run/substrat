import type { OnBehalfOf } from '@substrat-run/contracts';
import type { HostAdmin } from './scope-host.js';

/**
 * What an admin-log row written through a view says about why it was written: the person
 * the actor acted for (#977), and the event whose effect the write is (K-22, `causedBy`).
 * A key left out is inherited from the host the view was made over.
 */
export interface HostAttribution {
  onBehalfOf?: OnBehalfOf;
  causedBy?: string;
}

/**
 * The delivery a consumer's or an import's context runs for (#1237, #1901, #2055): the event
 * whatever it emits was caused by, and the id its log lines join — a unit of async work with
 * no call around it. Passed into the context, never kept on the scope: a field read across
 * the handler's awaits is right only while nothing else in the scope can emit meanwhile.
 * `ctx.log` alone reads the id; an event a consumer emits outside a call still records no
 * invocation (#1525).
 */
export interface ConsumerDelivery {
  causedBy: string;
  invocationId: string;
}

/**
 * A view of a host whose admin rows read `this.onBehalfOf` and `this.causedBy` (#977, #2055).
 *
 * The view is a Proxy over the host rather than a prototype child: reads of every
 * field fall through to the host, and so do WRITES — a method that assigns
 * `this.something` changes the host it was called on, exactly as it does without
 * attribution. Only the attribution and `admin` answer from the view, which is what
 * keeps two concurrent calls from seeing each other's person or each other's event.
 * Never a field set on the host around an `await`: the host is shared, and anything
 * else it serves while the await is suspended would be stamped with it (#2055).
 *
 * `buildAdmin` is the host's own, invoked with the view as `this`, so every closure
 * it makes records through the view — as does every host method called on the view.
 * It runs on the first read of the view's `admin`, not before: a view is made per
 * executor delivery, and most never read it. A view of a view keeps what the inner one
 * carries unless it names that key itself.
 */
export function attributedView<H extends { admin: HostAdmin }>(
  host: H,
  attribution: HostAttribution,
  buildAdmin: (this: H) => HostAdmin,
): H {
  let viewAdmin: HostAdmin | undefined;
  const view = new Proxy(host, {
    get(target, prop) {
      if (prop === 'onBehalfOf' && attribution.onBehalfOf !== undefined) return attribution.onBehalfOf;
      if (prop === 'causedBy' && attribution.causedBy !== undefined) return attribution.causedBy;
      if (prop === 'admin') return (viewAdmin ??= buildAdmin.call(view));
      return Reflect.get(target, prop, target);
    },
  });
  return view;
}

