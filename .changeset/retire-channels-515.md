---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/cli': minor
---

Retire the `dev`/`staging` channels — a vertical has exactly ONE channel now (#509, #515,
Tier 4). `channelName` narrows to `z.enum(['prod'])`: `prod` is the serving pointer, and the
old `dev`/`staging` pointers were write-only (nothing ever served or read them, #509 §2). A
non-prod environment is a *scope with data* — a preview (`substrat preview create`) — not a
second pointer at the same code.

`prod` stays the wire name, so `--promote prod`, generated CI, and existing `channel_history`
rows keep working unchanged — this is a narrowing, not a rename.

- **Promote/history routes** refuse a non-prod channel with a `400` pointing at previews
  (`substrat preview create --tag <tag>`), instead of silently accepting a dead pointer.
- **`listChannels`** filters to the serving channel in both adapters, so an inert `dev`/`staging`
  row a pre-retirement push may have left never reaches the now-`prod`-only parse. `channel_history`
  is untouched (audit + the PITR anchor `at`).
- **CLI**: `substrat promote` no longer needs `--channel` (it defaults to `prod`); `--promote`
  documents `prod` only.
- **Console (dashboard + control-plane)**: channel types, pills, and the promote picker narrow
  to `prod` — the dead dev/staging buttons were already removed in #512.

The two human checkpoints are unchanged: the `--ack-permissions`/`--ack-migrations` gate still
fires on the `prod` promote (the digest-change consent), and the fork-before-promote snapshot
still runs at the bind. No migration is required — legacy dev/staging rows become inert data the
readers now skip.
