---
'@substrat-run/adapter-cloudflare': patch
---

A live-reads subscriber's keep-alive ping (#938, `pingMs: 45_000`) is now answered by the
runtime's `setWebSocketAutoResponse`, set once per scope Durable Object, instead of waking the
object to run `webSocketMessage`. Before this, an idle tab still watching a scope kept its
Durable Object warm every 45 seconds for no reason — the ping carries no information the
handler acts on, only `pong` back. The `webSocketMessage` `'ping'` branch stays as a documented
fallback for an older client build. Not included: the issue's optional client-side "close the
socket while the tab is hidden" — that is a `demos/ticket0/app` change and belongs with #1856's
work in that area, not this one.
