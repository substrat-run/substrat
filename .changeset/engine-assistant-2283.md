---
'@substrat-run/engine-assistant': minor
---

New engine, not yet published: the record of a chat between a person and an assistant. An append-only, numbered event log per thread; a single-writer run lease that fences a replaced run; and tool calls whose gated writes need an approval bound to the SHA-256 of the exact input, claimed once. Two keys: `assistant:use` for a person and `assistant:run` for the host that writes the assistant's side. Events are bounded, emit milestones only (no text or tool data), and every table holding a person's words declares its erasure by delete. Composed by call; it never talks to a model.
