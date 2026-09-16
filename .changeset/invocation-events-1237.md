---
'@substrat-run/contracts': minor
'@substrat-run/kernel': minor
'@substrat-run/adapter-sqlite': minor
'@substrat-run/adapter-cloudflare': minor
'@substrat-run/contract-tests': minor
'@substrat-run/control-plane-api': minor
'@substrat-run/vertical-host': minor
---

Any event in an app's history can now show **the rest of the request it came from**: **Same call** lists everything that request recorded, in order.

**Why?** and **What did it do?** both follow cause, so neither can show two things one request did side by side — placing an order and reserving its stock, say, when neither caused the other. **Same call** can, and it marks which entries were raised by a handler reacting to another event in the same request.

It shows only what the request recorded. A read, or a check that changed nothing, leaves no record, so it isn't listed, and the view says so rather than letting a short list pass for a quiet request. A request that recorded more than one read shows says that it did. Events from seeds and internal calls, and events from before requests were recorded, carry no request, and the button says why it is unavailable instead of opening onto nothing.
