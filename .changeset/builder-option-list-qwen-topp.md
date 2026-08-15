---
"@substrat-run/builder-web": patch
"@substrat-run/builder": patch
"@substrat-run/builder-generator": patch
---

Builder studio: readable interview options + a lid on Qwen's repetition loops.

**Interview options stack, one per row.** ask_user options (and the inline
numbered-prose fallback) rendered in the model picker's wrapping pill row —
right for short model ids, wrong for sentence-length answers: later options
started mid-line and read as randomly indented. They now get their own
`.option-list` (column, left-aligned); the model picker keeps its wrapping row.

**Qwen sampling gains `topP: 0.8`.** The chat pane streaming long runs of
underscores (rendered as an `<hr>` once the run landed on its own line) is the
qwen family falling into a single-token repetition loop mid-turn. The harness
already pins temperature 0.55 for qwen; it now also sends Qwen's published
qwen3-coder nucleus setting, plumbed through a new `topP` generator option on
the same host-declares-per-model path as temperature (H4).
