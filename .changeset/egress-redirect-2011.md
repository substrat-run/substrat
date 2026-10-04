---
'@substrat-run/vertical-egress': patch
---

The egress worker no longer lets a redirect take a vertical's request outside its declared outbound surface (#2011). Every request it lets out, whether to a declared host, the platform loopback, the relay or an unenforced version, leaves with `redirect: 'manual'`. The 3xx goes back to the vertical, and the vertical's own `fetch` follows it as a new request that the egress worker checks like any other. Code that relies on `fetch` following redirects between hosts it declared sees the same response, `url` and `redirected` as before. A redirect to an undeclared host now gets the same refusal a direct call there would.

Each 3xx is also metered as a `redirect` datapoint in `substrat_egress`, beside the verdict that let the request out. Its fourth blob is the host the redirect pointed at.
