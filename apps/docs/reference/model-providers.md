# @substrat-run/model-providers

The model-provider seam. One `provider:model` grammar, one table of providers, one
hosting disclosure per provider, one generated rate card and the list-price math over
it. Anything on the platform that calls a language model — the builder studio today, a
hosted vertical's assistant next — resolves a model through this package, and **no
provider has a code path of its own**. Cloudflare is one row in the table, on par with
Anthropic, Scaleway or any other provider; its gateway features (unified billing,
per-request metadata, spend limits) are extras a host may layer on that row, never a
second design.

## The grammar

```text
anthropic:claude-opus-5
cloudflare:@cf/zai-org/glm-5.2
scaleway:llama-3.3-70b-instruct
qwen:auto                         # a declared {fast, strong} pair, resolved per tier
claude-opus-5                     # bare id ⇒ the default provider (anthropic)
```

`parseModelSpec` and `normalizeModelSpec` are the only place the default is applied, so
`claude-opus-5` and `anthropic:claude-opus-5` land on one meter rather than two.

## The table

`PROVIDERS` has two row shapes:

- **`direct`** — an AI SDK provider package (`@ai-sdk/anthropic`, `@ai-sdk/openai`, …).
  The package is *not* imported here: a Node host loads it dynamically, a Worker imports
  it statically, and both hand the `createX` factory to `createModel`. That is what keeps
  the table loadable everywhere.
- **`compatible`** — an OpenAI-compatible HTTP endpoint (`createOpenAICompatible`). One
  dependency covers Qwen/DashScope, Cloudflare, Scaleway, Ollama, vLLM, LM Studio,
  OpenRouter and anything else speaking that dialect, which is why most rows land here.

Every row names its credential env var, its endpoint (or the env var that must supply an
account-scoped one), where inference runs, and what a picker should suggest. Adding a
provider is one row — plus `pnpm add` for a direct one.

## Resolving a model

```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createModel } from '@substrat-run/model-providers';

const { model, label, endpoint } = createModel('cloudflare:@cf/zai-org/glm-5.2', env, {
  factories: { anthropic: createAnthropic },        // the direct rows this host wired
  hosted: true,                                     // refuse local rows (Ollama)
  describeMissing: (v) => `${v} is not set as a worker secret`,
});
```

`env` is a plain record — `process.env`, a Worker's bindings, or a test literal. The
resolver reads only the row's own variables (`CLOUDFLARE_AI_API_TOKEN`, never wrangler's
`CLOUDFLARE_API_TOKEN`), so an ambient deploy token is never silently used for inference.
Every refusal is a `ProviderError` that names the next step.

`credentialsFrom(provider, env)` is the same read without building a model — what a
settings screen uses to show *configured / not configured*.

## The disclosure

The model provider is a subprocessor of whatever is sent to it
(D-54 in the decision log), so a picker must say **where** inference happens, not just
which model:

```ts
providerCatalog(env, { hosted: true, sent: 'Conversation text' });
// → [{ name: 'scaleway', hosting: { vendor: 'Scaleway (Generative APIs)',
//      location: 'European Union (France, Paris)', host: 'api.scaleway.ai',
//      dataNote: 'Conversation text — sent to this provider.' },
//      credential: { envVar: 'SCALEWAY_API_KEY', set: false }, listable: true, … }, …]
```

Qwen's location is decoded from the effective host (DashScope keys are region- and
workspace-scoped). **The local claim follows the endpoint, not the row**: `ollama` is
declared local, but its endpoint is overridable, so `hosting.local` is true only when the
effective host is loopback — point `OLLAMA_BASE_URL` at a GPU box and the disclosure says
remote. The inference only ever runs one way: an endpoint can take the local claim away,
never grant one, so an unfamiliar or unparseable host reads as remote. Overstating where
data went is safe; understating it is the lie this disclosure exists to prevent. `listModels`
asks a compatible endpoint what it actually serves — Cloudflare's catalog lives on the
account API rather than `/models`, and that is a property of its row (`catalog`), not a
branch on its name.

## The rate card and list price

`rate-card.generated.ts` is a checked-in snapshot generated from models.dev × LiteLLM
with a failing cross-check (`pnpm --filter @substrat-run/model-providers update-rate-card`);
a price change is a reviewed PR diff. `listCostOfSteps(model, steps)` prices the AI SDK
usage shape per request — tier selection is all-or-nothing on a request's total input,
cache reads and writes bill at their own rates when the card has them — and returns a
USD decimal string, or `null` for a model the card does not know. Unpriced, never guessed.

**Margin is the caller's vocabulary.** The builder studio charges list × 1.2 for its own
spend; the platform will charge list × (1 + its margin) for inference it provides
([#1054](https://github.com/substrat-run/substrat/issues/1054)). The metering engine owns
quantities and never prices. Each is a one-line wrapper over `listCostOfSteps`.

## What is deliberately not here

- No `process.env` read, no `node:*` import, no dynamic `import()` — the package runs
  unchanged in Node, Workers and the browser.
- No provider-specific branch: Cloudflare's catalog endpoint and Qwen's cache markers are
  declared *on their rows* (`catalog`, `wire`) and dispatched on those fields.
- No margin, no ledger, no budget — those are the host's (builder metering today, the
  platform's model host for verticals next).
