import { useEffect } from 'react';

/**
 * The support desk's chat bubble, embedded on a platform app with the signed-in
 * user already vouched for.
 *
 * Two halves, and only one of them is here. The server half mints an identity
 * claim — `HMAC-SHA-256(desk secret, email)`, `signVisitorIdentity` in
 * `@substrat-run/oidc-rp` — from a secret this component never sees; the browser
 * only carries it. That is the whole mechanism: the desk knows who is asking
 * because THIS deployment vouched for them, and nobody can claim somebody else's
 * identity by editing an attribute in devtools.
 *
 * It renders nothing. The desk's `widget.js` appends its own host element to
 * `document.body` and draws into a shadow root, so neither app's CSS reaches into
 * the widget nor the widget's into the app. What this component owns is the tag's
 * lifetime — which matters because both apps are client-side-routed SPAs, and a
 * removed `<script>` undoes nothing it already did. `widget.js` offers one verb for
 * that, `window.ticket0.unmount()`, and the cleanup below calls it. The same
 * contract the docs site's Vue component holds up (`Ticket0Widget.vue`).
 *
 * No endpoint, no session, or a deployment with no desk configured ⇒ no widget and
 * no error: the endpoint answers `{ desk: null }` and this quietly renders nothing.
 * A support bubble is not worth an error card.
 */
export interface SupportWidgetProps {
  /**
   * Same-origin path that answers who to embed and how to prove who is asking:
   * `{ desk, user, signature }`, or `{ desk: null }` when this deployment has no
   * desk. Same-origin on purpose — the claim rides the app's own session cookie,
   * so it is never fetched cross-origin and never cached.
   */
  endpoint?: string;
}

/** What the identity endpoint answers. `desk: null` = this deployment has no desk. */
interface SupportIdentity {
  desk: string | null;
  user?: string;
  signature?: string;
}

declare global {
  interface Window {
    ticket0?: { unmount(): void };
  }
}

export function SupportWidget({ endpoint = '/api/support/identity' }: SupportWidgetProps = {}) {
  useEffect(() => {
    // Set on the way out. The fetch, and then the script, can still be in flight at
    // that point — a fast unmount on a slow network is the case that leaves a second
    // bubble and an orphaned poll behind if nothing checks.
    let disposed = false;
    let tag: HTMLScriptElement | undefined;

    void (async () => {
      let identity: SupportIdentity | null = null;
      try {
        const res = await fetch(endpoint, { credentials: 'include' });
        if (res.ok) identity = (await res.json()) as SupportIdentity;
      } catch {
        identity = null; // offline, or the app is being torn down — not worth surfacing
      }
      if (disposed || !identity?.desk || !identity.user || !identity.signature) return;

      const script = document.createElement('script');
      script.src = `${identity.desk.replace(/\/+$/, '')}/widget.js`;
      // The desk reads both off `document.currentScript`, so they must be attributes
      // on the tag before it is appended — not arguments to a call afterwards.
      script.dataset['user'] = identity.user;
      script.dataset['signature'] = identity.signature;
      script.addEventListener('load', () => {
        if (disposed) window.ticket0?.unmount();
      });
      document.body.appendChild(script);
      tag = script;
    })();

    return () => {
      disposed = true;
      window.ticket0?.unmount();
      tag?.remove();
      tag = undefined;
    };
  }, [endpoint]);

  return null;
}
