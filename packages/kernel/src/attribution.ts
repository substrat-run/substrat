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
 * A view of a view keeps what the inner one carries unless it names that key itself.
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
      if (prop === 'admin') return viewAdmin;
      return Reflect.get(target, prop, target);
    },
  });
  viewAdmin = buildAdmin.call(view);
  return view;
}

/** `ScopeHost.attributed` for a host whose admin rows read `this.onBehalfOf` (#977). */
export function attributedHost<H extends { admin: HostAdmin }>(
  host: H,
  onBehalfOf: OnBehalfOf,
  buildAdmin: (this: H) => HostAdmin,
): H {
  return attributedView(host, { onBehalfOf }, buildAdmin);
}
