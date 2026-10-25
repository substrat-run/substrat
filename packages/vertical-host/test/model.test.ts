/**
 * The model host's promise: one governed call, one honest line, no provider named.
 *
 * The model is the AI SDK's own mock, reached through an injected direct-provider
 * factory — the exact seam a Worker uses for `createAnthropic` — so what is under test
 * is the governance around the call, not any provider's wire format.
 */
import { describe, expect, it } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { scopeId, tenantId, z, type ModelUsageLine } from '@substrat-run/contracts';
import { createModelHost, MODEL_MAX_STEPS, stepTokensOf, type ModelIntent } from '../src/model.js';

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

  it('does NOT treat a direct row’s factory as credential-free — status must not outrun run()', async () => {
    // `createAnthropic` is the package, not a capability: the row still needs its key.
    // Reported as configured, a settings screen would call this runnable and the call
    // would then fail — status lying about the one thing it exists to answer.
    const host = createModelHost({ env: {}, factories: { anthropic: (() => () => null) as never } });
    expect(host.status('anthropic:claude-opus-5')).toMatchObject({
      configured: false,
      missing: ['ANTHROPIC_API_KEY'],
    });
    // And run() agrees, which is the property that was broken.
    await expect(host.run({ spec: 'anthropic:claude-opus-5', attribution, prompt: 'hi' })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
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

describe('run with tools (#2283)', () => {
  const usage = (input: number, output: number) => ({
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  });
  /** A model that calls `lookup` once, then answers from what it returned. */
  const toolModel = () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options: { prompt: unknown }) => {
        prompts.push(options.prompt);
        return (prompts.length === 1
          ? {
              content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: JSON.stringify({ id: 'F1' }) }],
              finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              usage: usage(1_000, 50),
              warnings: [],
            }
          : {
              content: [{ type: 'text', text: 'F1 failed 3 times.' }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: usage(1_200, 20),
              warnings: [],
            }) as never;
      },
    });
    return { model, prompts };
  };
  const lookup = (seen: unknown[]) => ({
    description: 'Look up a finding',
    input: z.object({ id: z.string() }),
    execute: async (input: { id: string }) => {
      seen.push(input);
      return { id: input.id, count: 3 };
    },
  });

  it('runs a tool the model calls, hands its result back, and reports each step', async () => {
    const { model, prompts } = toolModel();
    const seen: unknown[] = [];
    const lines: ModelUsageLine[] = [];
    let guarded = 0;
    const host = hostWith(model, { record: (l) => void lines.push(l), guard: () => void guarded++ });
    const run = await host.run({
      spec: 'claude-opus-5',
      attribution,
      messages: [
        { role: 'user', content: 'What is F1?' },
      ],
      tools: { lookup: lookup(seen) },
    });

    expect(seen).toEqual([{ id: 'F1' }]);
    expect(run.text).toBe('F1 failed 3 times.');
    expect(run.steps).toEqual([
      { text: '', toolCalls: [{ callId: 'c1', tool: 'lookup', input: { id: 'F1' } }], toolResults: [{ callId: 'c1', tool: 'lookup', output: { id: 'F1', count: 3 } }], toolErrors: [] },
      { text: 'F1 failed 3 times.', toolCalls: [], toolResults: [], toolErrors: [] },
    ]);
    // The second model call saw the tool's output.
    expect(JSON.stringify(prompts[1])).toContain('"count":3');
    // One decision to spend, one line, both steps' tokens in it.
    expect(guarded).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ inputTokens: 2_200, outputTokens: 70, reported: true });
    expect(lines[0]!.listUsd).not.toBeNull();
  });

  it('stops at maxSteps, so a model that keeps calling tools cannot run on', async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        return {
          content: [{ type: 'tool-call', toolCallId: `c${calls}`, toolName: 'lookup', input: JSON.stringify({ id: 'F1' }) }],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: usage(10, 1),
          warnings: [],
        } as never;
      },
    });
    const run = await hostWith(model).run({ spec: 'claude-opus-5', attribution, prompt: 'loop', tools: { lookup: lookup([]) }, maxSteps: 2 });
    expect(calls).toBe(2);
    expect(run.steps).toHaveLength(2);
  });

  it('refuses a malformed request before the guard, so nothing is spent on it', async () => {
    let guarded = 0;
    const host = hostWith(mockModel({ input: 1, output: 1 }), { guard: () => void guarded++ });
    await expect(host.run({ spec: 'claude-opus-5', attribution })).rejects.toThrow(/exactly one of `prompt` and `messages`/);
    await expect(
      host.run({ spec: 'claude-opus-5', attribution, prompt: 'a', messages: [{ role: 'user', content: 'b' }] }),
    ).rejects.toThrow(/exactly one/);
    await expect(host.run({ spec: 'claude-opus-5', attribution, prompt: 'a', maxSteps: MODEL_MAX_STEPS + 1 })).rejects.toThrow(/maxSteps/);
    expect(guarded).toBe(0);
  });
});
