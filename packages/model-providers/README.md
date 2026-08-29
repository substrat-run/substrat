# @substrat-run/model-providers

The model-provider seam: one `provider:model` grammar, a table of providers, the
hosting disclosure per provider, the generated rate card and the list-price math over
it. Hosts differ only in *where credentials come from* and *how provider packages get
loaded* — both are parameters. Cloudflare is one row, not the design (issue #1054).

**Full documentation: https://substrat.net/reference/model-providers**

## Usage

```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createModel, providerCatalog, listCostOfSteps } from '@substrat-run/model-providers';

// A Worker: bindings in, statically imported factories in.
const { model, label } = createModel('cloudflare:@cf/zai-org/glm-5.2', env, {
  factories: { anthropic: createAnthropic },
  hosted: true,
  describeMissing: (v) => `${v} is not set as a worker secret`,
});

// What a picker shows — vendor, location, host, and whether this environment can run it.
providerCatalog(env, { hosted: true, sent: 'Conversation text' });

// List price from the AI SDK usage shape; margin is the caller's vocabulary.
listCostOfSteps('anthropic:claude-opus-5', [{ inputTokens: 100_000, outputTokens: 10_000 }]);
```

The rate card is generated (`pnpm --filter @substrat-run/model-providers update-rate-card`)
from models.dev × LiteLLM with a failing cross-check, and reviewed as a PR diff.
