---
"@substrat-run/demo-ticket0": minor
"@substrat-run/vertical-host": patch
---

ticket0 answers through the platform's model host (#1054, step 4). The per-install `CF_ACCOUNT_ID` / `CF_AI_TOKEN` settings are gone; a desk's setting is only `TICKET0_MODEL`, a `provider:model` from the platform catalog (default `cloudflare:@cf/meta/llama-3.1-8b-instruct`), run on the platform's credential. `record-answer` takes the host's usage line beside the token counts and raises it to the platform ledger as a `model-usage` intent in the same transaction as the meter entries. Settings → Assistant shows where inference runs (vendor, location, what is sent) and, when the platform cannot run the chosen model, exactly which credential it is missing. `ModelHost.status` now carries that hosting disclosure.
