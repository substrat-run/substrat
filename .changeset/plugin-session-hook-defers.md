---
'create-substrat': patch
---

The SessionStart hook now knows whether it is the project's copy or the plugin's.

The Substrat agent plugin (#753) reaches the projects the scaffold never did — someone who
opens an agent on a directory we did not generate — and it ships this same hook, because a
script is the one thing an adapter cannot route to: it has to be somewhere the client can
execute. That matters most for a project scaffolded before the hook existed, which today is
nearly all of them.

Two copies of a hook that both fire would announce the project twice, so the script now asks
where it is running from. The project's copy always wins: it ships beside the playbook it
points at, so it is the one that matches what is actually checked out. The plugin's exits
silently whenever the project owns one.

Asked positionally rather than through a flag, deliberately — the two copies must stay
byte-identical for `pnpm lint:plugin --check` to have anything to compare, and a copy that is
invoked differently is a copy that can be edited differently.
