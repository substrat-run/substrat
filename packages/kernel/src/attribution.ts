import type { OnBehalfOf } from '@substrat-run/contracts';
import type { HostAdmin } from './scope-host.js';

/**
 * `ScopeHost.attributed` for a host whose admin rows read `this.onBehalfOf` (#977).
 *
 * The view is a Proxy over the host rather than a prototype child: reads of every
 * field fall through to the host, and so do WRITES — a method that assigns
 * `this.something` changes the host it was called on, exactly as it does without
 * attribution. Only `onBehalfOf` and `admin` answer from the view, which is what
 * keeps two concurrent attributed requests from seeing each other's person.
 *
 * `buildAdmin` is the host's own, invoked with the view as `this`, so every closure
 * it makes records through the view — as does every host method called on the view.
 */
export function attributedHost<H extends { admin: HostAdmin }>(
  host: H,
  onBehalfOf: OnBehalfOf,
  buildAdmin: (this: H) => HostAdmin,
): H {
  let viewAdmin: HostAdmin | undefined;
  const view = new Proxy(host, {
    get(target, prop) {
      if (prop === 'onBehalfOf') return onBehalfOf;
      if (prop === 'admin') return viewAdmin;
      return Reflect.get(target, prop, target);
    },
  });
  viewAdmin = buildAdmin.call(view);
  return view;
}
