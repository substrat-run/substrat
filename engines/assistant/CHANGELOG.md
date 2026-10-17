# @substrat-run/engine-assistant

## 0.1.1

### Patch Changes

- Updated dependencies [98f09fe]
- Updated dependencies [0292dc0]
- Updated dependencies [b190e40]
- Updated dependencies [eda31d1]
- Updated dependencies [af096c6]
- Updated dependencies [39ccfea]
- Updated dependencies [6f5f12b]
- Updated dependencies [754fc62]
- Updated dependencies [c7eb5fa]
- Updated dependencies [1df1b93]
- Updated dependencies [6c1e359]
- Updated dependencies [439efc1]
- Updated dependencies [e550dec]
- Updated dependencies [4574ab8]
- Updated dependencies [3025154]
- Updated dependencies [9ae6644]
- Updated dependencies [d6ba289]
- Updated dependencies [2e503da]
- Updated dependencies [3608db6]
- Updated dependencies [9ceb545]
  - @substrat-run/kernel@0.149.0
  - @substrat-run/contracts@0.149.0

## 0.1.0

### Minor Changes

- 288f93b: New engine, not yet published: the record of a chat between a person and an assistant. An append-only, numbered event log per thread; a single-writer run lease that fences a replaced run; and tool calls whose gated writes need an approval bound to the SHA-256 of the exact input, claimed once. Two keys: `assistant:use` for a person and `assistant:run` for the host that writes the assistant's side. Events are bounded, emit milestones only (no text or tool data), and every table holding a person's words declares its erasure by delete. Composed by call; it never talks to a model.

### Patch Changes

- Updated dependencies [ad3ca19]
- Updated dependencies [c4a0352]
- Updated dependencies [f855218]
- Updated dependencies [a8b0842]
- Updated dependencies [00253e0]
- Updated dependencies [a9cbb6d]
- Updated dependencies [7f8c6bf]
- Updated dependencies [d175d87]
- Updated dependencies [1bf5425]
  - @substrat-run/contracts@0.148.0
  - @substrat-run/kernel@0.148.0
