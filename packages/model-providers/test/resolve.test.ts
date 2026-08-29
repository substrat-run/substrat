/**
 * The seam's promise: a host differs from another only in WHERE credentials come
 * from and HOW direct packages load — both parameters — and no provider has a
 * path of its own. Cloudflare is exercised as an ordinary compatible row.
 */
import { describe, expect, it } from 'vitest';
import type { LanguageModel } from 'ai';
import {
	PROVIDERS,
	ProviderError,
	createModel,
	credentialsFrom,
	hostingInfo,
	parseModelSpec,
	providerCatalog,
	resolveAutoSpec,
} from '../src/index.js';

const fakeModel = (id: string) => ({ modelId: id, provider: 'fake' }) as unknown as LanguageModel;

describe('parseModelSpec', () => {
	it('defaults the provider and keeps colons inside the model id', () => {
		expect(parseModelSpec('claude-opus-5')).toEqual({ provider: 'anthropic', modelId: 'claude-opus-5' });
		expect(parseModelSpec('cloudflare:@cf/zai-org/glm-5.2')).toEqual({
			provider: 'cloudflare',
			modelId: '@cf/zai-org/glm-5.2',
		});
	});
});

describe('credentialsFrom', () => {
	it('reads the row’s own env vars and nothing ambient', () => {
		const c = credentialsFrom('cloudflare', {
			CLOUDFLARE_AI_BASE_URL: 'https://api.cloudflare.com/client/v4/accounts/abc/ai/v1',
			CLOUDFLARE_AI_API_TOKEN: 't',
			CLOUDFLARE_API_TOKEN: 'the deploy token — must never be picked up',
		});
		expect(c.apiKey).toBe('t');
		expect(c.baseUrlSource).toBe('CLOUDFLARE_AI_BASE_URL');
		expect(c.missing).toEqual([]);
	});

	it('names every missing variable, endpoint included for account-scoped rows', () => {
		expect(credentialsFrom('cloudflare', {}).missing).toEqual(['CLOUDFLARE_AI_API_TOKEN', 'CLOUDFLARE_AI_BASE_URL']);
		expect(credentialsFrom('scaleway', {}).missing).toEqual(['SCALEWAY_API_KEY']);
		expect(credentialsFrom('ollama', {}).missing).toEqual([]);
	});

	it('refuses an unknown provider by name', () => {
		expect(() => credentialsFrom('opencode', {})).toThrow(ProviderError);
	});
});

describe('createModel', () => {
	it('builds a compatible row with no injection — Cloudflare, Scaleway, Qwen alike', () => {
		for (const [spec, env] of [
			['cloudflare:@cf/zai-org/glm-5.2', { CLOUDFLARE_AI_BASE_URL: 'https://x/ai/v1', CLOUDFLARE_AI_API_TOKEN: 't' }],
			['scaleway:llama-3.3-70b-instruct', { SCALEWAY_API_KEY: 'k' }],
			['qwen:qwen3.8-max', { DASHSCOPE_API_KEY: 'k' }],
		] as const) {
			const r = createModel(spec, env);
			expect(r.label).toBe(spec.replace(':', '/'));
			expect(r.endpoint).toBeTruthy();
			expect(r.model).toBeTruthy();
		}
	});

	it('hands a direct row to the host-supplied factory, with the override only when set', () => {
		const seen: unknown[] = [];
		const createAnthropic = (cfg: { apiKey?: string; baseURL?: string }) => {
			seen.push(cfg);
			return fakeModel;
		};
		const r = createModel('anthropic:claude-opus-5', { ANTHROPIC_API_KEY: 'k' }, { factories: { anthropic: createAnthropic } });
		expect(r.label).toBe('anthropic/claude-opus-5');
		expect(seen).toEqual([{ apiKey: 'k' }]);
		expect(r.endpoint).toBeUndefined();

		createModel(
			'claude-opus-5',
			{ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' },
			{ factories: { anthropic: createAnthropic } },
		);
		expect(seen[1]).toEqual({ apiKey: 'k', baseURL: 'https://gateway.example/anthropic' });
	});

	it('refuses a direct row the host did not wire, naming the package', () => {
		expect(() => createModel('anthropic:claude-opus-5', { ANTHROPIC_API_KEY: 'k' })).toThrow(/@ai-sdk\/anthropic/);
	});

	it('refuses a missing credential with the host’s own advice', () => {
		expect(() =>
			createModel('scaleway:x', {}, { describeMissing: (v) => `${v} is not set as a worker secret` }),
		).toThrow(/SCALEWAY_API_KEY is not set as a worker secret/);
	});

	it('refuses local rows on a hosted runtime', () => {
		expect(() => createModel('ollama:qwen3-coder', {}, { hosted: true })).toThrow(/local-machine/);
		expect(() => createModel('ollama:qwen3-coder', {})).not.toThrow();
	});
});

describe('the disclosure', () => {
	it('decodes the qwen region from the effective host', () => {
		expect(hostingInfo('qwen', {}).location).toBe('Singapore (international endpoint)');
		expect(
			hostingInfo('qwen', { DASHSCOPE_BASE_URL: 'https://ws1.eu-central-1.maas.aliyuncs.com/compatible-mode/v1' })
				.location,
		).toBe('workspace "ws1" · region eu-central-1');
	});

	it('says what is sent, in the host’s words, and that local rows send nothing', () => {
		expect(hostingInfo('scaleway', {}, { sent: 'Conversation text' }).dataNote).toBe(
			'Conversation text — sent to this provider.',
		);
		expect(hostingInfo('ollama', {}, { sent: 'Conversation text' }).dataNote).toBe(
			'Conversation text — never leaves this machine.',
		);
	});

	it('credential.set means the row can run here, and missing says what stops it', () => {
		const cf = providerCatalog({ CLOUDFLARE_AI_API_TOKEN: 't' }).find((e) => e.name === 'cloudflare')!;
		expect(cf.credential).toEqual({ envVar: 'CLOUDFLARE_AI_API_TOKEN', set: false, missing: ['CLOUDFLARE_AI_BASE_URL'] });
		const ok = providerCatalog({ CLOUDFLARE_AI_API_TOKEN: 't', CLOUDFLARE_AI_BASE_URL: 'https://x/ai/v1' }).find(
			(e) => e.name === 'cloudflare',
		)!;
		expect(ok.credential.set).toBe(true);
	});

	it('a hosted catalog drops local rows and can be narrowed to what the host wired', () => {
		const names = providerCatalog({}, { hosted: true }).map((e) => e.name);
		expect(names).not.toContain('ollama');
		expect(names).toContain('cloudflare');
		expect(names).toContain('scaleway');
		expect(providerCatalog({}, { only: ['anthropic', 'qwen'] }).map((e) => e.name)).toEqual(['anthropic', 'qwen']);
	});

	it('every row states vendor and location — no provider is undisclosed', () => {
		for (const name of Object.keys(PROVIDERS)) {
			const h = hostingInfo(name, {});
			expect(h.vendor, name).toBeTruthy();
			expect(h.location, name).not.toBe('unknown');
		}
	});
});

describe('resolveAutoSpec', () => {
	it('resolves a declared pair per tier and passes everything else through', () => {
		expect(resolveAutoSpec('qwen:auto', 'fast')).toBe('qwen:qwen3.6-flash');
		expect(resolveAutoSpec('qwen:auto', 'strong')).toBe('qwen:qwen3.8-max');
		expect(resolveAutoSpec('cloudflare:auto', 'strong')).toBe('cloudflare:auto');
		expect(resolveAutoSpec('qwen:qwen3.8-max', 'fast')).toBe('qwen:qwen3.8-max');
	});
});
