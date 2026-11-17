---
'@substrat-run/vertical-host': minor
'@substrat-run/model-providers': patch
'@substrat-run/control-plane': patch
---

The model host takes `stream: true`: the reply is streamed and assembled into the same run and usage line, so an upstream that closes a long unstreamed call keeps a streamed one open; a stream that fails partway throws the provider's own error and records nothing. An OpenAI-compatible row asks for usage on a streamed call. The code review reader streams its call and has a higher output cap.
