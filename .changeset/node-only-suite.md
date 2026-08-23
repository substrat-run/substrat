---
'@substrat-run/contract-tests': minor
---

`nodeOnlySuite` — a module that narrows nowhere says so, and can stop being true loudly

`entityCheckConformanceSuite` reads an operation's declaration and drives the behavioural
pair that proves the handler honours it. Seven packages in this repo have no declared
operation surface for it to read, and they carry the failure mode #865 named: **absence
reading as coverage**. Zero narrowed declarations is indistinguishable from nobody having
looked, and the packages where nobody looked are the ones worth looking at.

So a module that genuinely checks only at the node states it, wired to something that goes
red the day that changes:

```ts
nodeOnlySuite('engine-metering', {
  sources: [new URL('../src/index.ts', import.meta.url).pathname],
});
```

Its header is explicit about being a much weaker instrument than the conformance kit: it
proves an absence rather than a behaviour, it is lexical (a check assembled indirectly is
invisible to it), and it says nothing about whether node-only is *right* — that judgement is
the prose each caller writes above it. What it buys is that narrowing an operation in one of
these packages turns the suite red, so the assessment cannot quietly become a comment that
was true once.
