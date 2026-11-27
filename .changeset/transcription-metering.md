---
'@substrat-run/contracts': minor
'@substrat-run/model-providers': minor
'@substrat-run/vertical-host': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
---

Speech-to-text calls are metered (#3321): `createModelHost(...).transcribe` runs a transcription on the Workers AI binding through AI Gateway and records one `ModelUsageLine` counting the audio bytes sent (`unit: 'audio-byte'`, `quantity`), priced from the new unit rate card at a stated bytes-per-second basis. The line and the model-usage ledger carry `unit` and `quantity`, NULL on token lines.
