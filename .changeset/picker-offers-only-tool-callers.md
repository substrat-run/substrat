---
'@substrat-run/model-providers': minor
---

The Cloudflare model list now offers only models that can run a tool call. A build turn is a tool
loop from end to end, so a model without function calling could be picked and then fail mid-run.
The account catalog is asked for the filters it applies itself — a text-generation task, no
experimental rows, no deprecated ones — and the per-row `function_calling` flag decides the rest.
It fails soft in both directions: a row carrying no capability data at all is kept, and if the
filter would empty an answer that was not empty, the unfiltered list is returned rather than a
picker that reads as an outage.
