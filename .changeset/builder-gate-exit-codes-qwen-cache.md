---
"@substrat-run/builder": patch
"@substrat-run/builder-workspace": minor
"@substrat-run/builder-generator": patch
---

Two fixes from the truncated todo-app run, plus the skill gap behind its typecheck red.

**tsc's exit 2 no longer mutes the repair loop.** The 0/1/2 "exit 2 = blocked"
convention belongs to Substrat's own checkers and is now opt-in per gate
(`exitConvention: 'substrat'` — boundary-lint and the diff linters). It had been
applied to every gate, and tsc exits 2 on ordinary type errors — so the gate
that fails most reported `blocked`, `repairNeeded()` saw nothing to repair,
`gateReport()` carried nothing into the next turn, and the model was explicitly
told its own type errors were "NOT a code problem". External tools now fail on
any nonzero exit; the tri-state convention survives only where a tool actually
speaks it.

**qwen gets a working prompt cache (explicit markers at the wire).** DashScope's
context cache is per-model: qwen3.8-max caches implicitly, but the flash tier
caches only with explicit Anthropic-style `cache_control` markers on content
blocks — which `@ai-sdk/openai-compatible` cannot emit (its providerOptions
spread lands message-level; verified silently ignored). New `qwenCacheFetch`
(apps/builder/src/qwen-cache.ts) rewrites each chat/completions body at the
wire — markers on the system prefix and the request's tail, stateless per
request, so the moving-breakpoint strategy comes free — and both provider hosts
wire it in. The generator treats `qwen/*` as a cache-stable dialect: no
stale-payload pruning, same reasoning as the Anthropic branch. Verified
end-to-end against the token-plan gateway: 99.97% of a tool-loop-shaped prompt
read from cache on the warm request (reads bill at 10%, creation at 125%,
5-minute TTL). A 1M-input build turn on flash drops roughly 85–90% in input
cost.

**scaffold.md teaches the branded-id boundary.** The todo-app red was the model
guessing `getScope(tenantId, scopeId, principal)` (it takes the principal
FIRST) and hand-rolling an `as`-cast for a zod-branded `PrincipalId`. The
server-harness section now shows the exact call shape and the rule: re-brand
serialized ids with `principalId.parse(...)` at the boundary, pass through ids
minted in-process.
