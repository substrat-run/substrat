/**
 * The model host's promise: one governed call, one honest line, no provider named.
 *
 * The model is the AI SDK's own mock, reached through an injected direct-provider
 * factory — the exact seam a Worker uses for `createAnthropic` — so what is under test
 * is the governance around the call, not any provider's wire format.
 */
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { scopeId, tenantId, type ModelUsageLine } from '@substrat-run/contracts';
import { createModelHost, stepTokensOf, type ModelIntent } from '../src/model.js';

const attribution = {
  tenant: tenantId.parse('01ARZ3NDEKTSV4RRFFQ69G5FAV'),
  scope: scopeId.parse('01BX5ZZKBKACTAV9WEVGEMMVRZ'),
  vertical: '@substrat-run/demo-ticket0',
  version: '0.1.0',
  operation: 'ticket0/answer',
};

const mockModel = (usage: Partial<{ input: number; output: number; cacheRead: number }> | null, text = 'Forty-two.') =>
  new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: {
          total: usage?.input,
          noCache: usage && usage.input !== undefined ? usage.input - (usage.cacheRead ?? 0) : undefined,
          cacheRead: usage?.cacheRead,
          cacheWrite: undefined,
        },
        outputTokens: { total: usage?.output, text: usage?.output, reasoning: undefined },
      },
      warnings: [],
    } as never,
  });

/** A host whose "anthropic" row is the mock — credentials present, factory injected. */
function hostWith(model: MockLanguageModelV3, extra: Partial<Parameters<typeof createModelHost>[0]> = {}) {
  let tick = 0;
  return createModelHost({
    env: { ANTHROPIC_API_KEY: 'k' },
    factories: { anthropic: () => () => model as never },
    now: () => new Date(1_700_000_000_000 + 250 * tick++),
    ...extra,
  });
}

describe('run', () => {
  it('prices the reported usage from the rate card and hands one line to the ledger', async () => {
    const lines: ModelUsageLine[] = [];
    const host = hostWith(mockModel({ input: 100_000, output: 10_000, cacheRead: 0 }), {
      record: (line) => void lines.push(line),
    });
    const run = await host.run({ spec: 'claude-opus-5', attribution, prompt: 'What is the answer?' });

    expect(run.text).toBe('Forty-two.');
    expect(run.label).toBe('anthropic/claude-opus-5');
    expect(lines).toHaveLength(1);
    expect(run.line).toBe(lines[0]);
    // 100k × $5/1M + 10k × $25/1M = 0.5 + 0.25 — the same list price the card gives the builder.
    expect(run.line).toMatchObject({
      model: 'anthropic:claude-opus-5',
      provider: 'anthropic',
      modelId: 'claude-opus-5',
      reported: true,
      inputTokens: 100_000,
      outputTokens: 10_000,
      listUsd: '0.75',
      attribution,
      elapsedMs: 250,
    });
    expect(run.line.at).toBe(new Date(1_700_000_000_250).toISOString());
  });

  it('never estimates: a provider that reports no usage yields zero tokens, reported:false, no price', async () => {
    const host = hostWith(mockModel(null));
    const run = await host.run({ spec: 'anthropic:claude-opus-5', attribution, prompt: 'hi' });
    expect(run.line).toMatchObject({ reported: false, inputTokens: 0, outputTokens: 0, listUsd: null });
  });

  it('is unpriced, not $0, for a model the card does not know', async () => {
    const host = hostWith(mockModel({ input: 10, output: 10 }));
    const run = await host.run({ spec: 'anthropic:claude-unknown-9', attribution, prompt: 'hi' });
    expect(run.line.listUsd).toBeNull();
    expect(run.line.reported).toBe(true);
  });

  it('consults the guard before the bytes go out, and a refusal runs nothing and records nothing', async () => {
    const model = mockModel({ input: 1, output: 1 });
    const seen: ModelIntent[] = [];
    const lines: ModelUsageLine[] = [];
    const host = hostWith(model, {
      guard: (intent) => {
        seen.push(intent);
        throw new Error('daily budget of $5.00 exhausted for this desk');
      },
      record: (line) => void lines.push(line),
    });
    await expect(host.run({ spec: 'claude-opus-5', attribution, prompt: 'hi' })).rejects.toThrow(/daily budget/);
    // The guard sees the CANONICAL spec, so a policy written against
    // `anthropic:claude-opus-5` cannot be dodged by passing the shorthand.
    expect(seen).toEqual([{ spec: 'anthropic:claude-opus-5', attribution }]);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(lines).toHaveLength(0);
  });

  it('a ledger that cannot write fails the run — a call that was not recorded must not look recorded', async () => {
    const host = hostWith(mockModel({ input: 1, output: 1 }), {
      record: () => {
        throw new Error('ledger unavailable');
      },
    });
    await expect(host.run({ spec: 'claude-opus-5', attribution, prompt: 'hi' })).rejects.toThrow(/ledger unavailable/);
  });

  it('refuses an unconfigured row before the guard, with the platform’s own words', async () => {
    let guarded = 0;
    const host = createModelHost({ env: {}, guard: () => void guarded++ });
    await expect(host.run({ spec: 'scaleway:llama-3.3-70b-instruct', attribution, prompt: 'hi' })).rejects.toThrow(
      /SCALEWAY_API_KEY is not set on the platform/,
    );
    expect(guarded).toBe(0);
  });

  it('refuses a local row: a hosted runtime cannot dial localhost', async () => {
    const host = createModelHost({ env: {} });
    await expect(host.run({ spec: 'ollama:qwen3-coder', attribution, prompt: 'hi' })).rejects.toThrow(/local-machine/);
  });

  it('a malformed attribution is refused BEFORE the call, so a sixth key costs nothing', async () => {
    const model = mockModel({ input: 1, output: 1 });
    const lines: ModelUsageLine[] = [];
    let guarded = 0;
    const host = hostWith(model, { guard: () => void guarded++, record: (l) => void lines.push(l) });
    await expect(
      host.run({
        spec: 'claude-opus-5',
        attribution: { ...attribution, install: 'x' } as never,
        prompt: 'hi',
      }),
    ).rejects.toThrow();
    // The point of moving the parse to the top: no provider call, no spend, and
    // nothing half-recorded. Validated after the fact, this cost a model call.
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(guarded).toBe(0);
    expect(lines).toHaveLength(0);
  });
});

describe('the Workers AI binding', () => {
  /** A stand-in for `env.AI` — `workers-ai-provider` only needs an object to wrap. */
  const aiBinding = { run: async () => ({ response: 'bound' }) };

  it('makes the cloudflare row runnable with NO credential in the environment', () => {
    const bare = createModelHost({ env: {} });
    expect(bare.status('cloudflare:@cf/meta/llama-3.1-8b-instruct-fast')).toMatchObject({
      configured: false,
      missing: ['CLOUDFLARE_AI_API_TOKEN', 'CLOUDFLARE_AI_BASE_URL'],
    });

    // The binding IS the configuration: nothing is missing, because nothing is needed.
    const bound = createModelHost({ env: {}, aiBinding });
    expect(bound.status('cloudflare:@cf/meta/llama-3.1-8b-instruct-fast')).toMatchObject({
      configured: true,
      missing: [],
    });
  });

  it('leaves every other row alone — the binding is one row’s transport, not a global', () => {
    const bound = createModelHost({ env: {}, aiBinding });
    expect(bound.status('scaleway:llama-3.3-70b-instruct')).toMatchObject({
      configured: false,
      missing: ['SCALEWAY_API_KEY'],
    });
    expect(bound.status('anthropic:claude-opus-5').configured).toBe(false);
  });
});

describe('status', () => {
  it('says whether the platform holds what the row needs, without running anything', () => {
    const host = createModelHost({ env: { CLOUDFLARE_AI_BASE_URL: 'https://x/ai/v1' } });
    expect(host.status('cloudflare:@cf/meta/llama-3.1-8b-instruct-fast')).toEqual({
      spec: 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fast',
      label: 'cloudflare/@cf/meta/llama-3.1-8b-instruct-fast',
      provider: 'cloudflare',
      modelId: '@cf/meta/llama-3.1-8b-instruct-fast',
      configured: false,
      missing: ['CLOUDFLARE_AI_API_TOKEN'],
      hosting: {
        vendor: 'Cloudflare (Workers AI)',
        location: 'global (Cloudflare network) · vendor/model ids partner-served',
        host: 'x',
        // A platform row is never local, whatever its endpoint says.
        local: false,
        dataNote: 'Inputs — sent to this provider.',
      },
    });
    expect(host.status('claude-opus-5').spec).toBe('anthropic:claude-opus-5');
  });
});

describe('stepTokensOf', () => {
  it('maps the AI SDK usage shape onto the rate card’s, cache slices included', () => {
    expect(
      stepTokensOf({
        inputTokens: 1000,
        outputTokens: 50,
        totalTokens: 1050,
        inputTokenDetails: { noCacheTokens: 200, cacheReadTokens: 800, cacheWriteTokens: undefined },
        outputTokenDetails: { textTokens: 50, reasoningTokens: undefined },
      } as never),
    ).toEqual({ reported: true, inputTokens: 1000, outputTokens: 50, cachedInputTokens: 800, cacheWriteTokens: 0 });
  });
});
