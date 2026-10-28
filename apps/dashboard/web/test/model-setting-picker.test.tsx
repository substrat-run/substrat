import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ModelSettingPicker } from '../src/views/ModelSettingPicker';

it('renders an existing unlisted value beside priced catalog choices', () => {
  const html = renderToStaticMarkup(
    <ModelSettingPicker
      value="cloudflare:@cf/meta/llama-3.1-8b-instruct-fast"
      onChange={() => {}}
      catalog={[{
        id: 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8',
        label: 'Llama 3.1 8B Instruct fp8', status: 'active', servedBy: 'Cloudflare Workers AI',
        tiers: [{ upToInputTokens: null, inputPer1M: '0.1', outputPer1M: '0.2', cacheReadPer1M: null, cacheWritePer1M: null }],
      }]}
    />,
  );
  expect(html).toContain('Unlisted: cloudflare:@cf/meta/llama-3.1-8b-instruct-fast');
  expect(html).toContain('Llama 3.1 8B Instruct fp8');
  expect(html).toContain('Cloudflare Workers AI');

  const singleTier = renderToStaticMarkup(
    <ModelSettingPicker
      value="cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8"
      onChange={() => {}}
      catalog={[{
        id: 'cloudflare:@cf/meta/llama-3.1-8b-instruct-fp8',
        label: 'Llama 3.1 8B Instruct fp8', status: 'active', servedBy: 'Cloudflare Workers AI',
        tiers: [{ upToInputTokens: null, inputPer1M: '0.1', outputPer1M: '0.2', cacheReadPer1M: null, cacheWritePer1M: null }],
      }]}
    />,
  );
  expect(singleTier).toContain('List price from $0.1 input / $0.2 output per 1M tokens');

  const tiered = renderToStaticMarkup(
    <ModelSettingPicker
      value="qwen:qwen3.6-flash"
      onChange={() => {}}
      catalog={[{
        id: 'qwen:qwen3.6-flash',
        label: 'Qwen 3.6 Flash', status: 'active', servedBy: 'Alibaba Cloud Model Studio',
        tiers: [
          { upToInputTokens: 256_000, inputPer1M: '0.25', outputPer1M: '1.5', cacheReadPer1M: '0.025', cacheWritePer1M: '0.3125' },
          { upToInputTokens: null, inputPer1M: '1', outputPer1M: '4', cacheReadPer1M: '0.1', cacheWritePer1M: '1.25' },
        ],
      }]}
    />,
  );
  expect(tiered).toContain('$0.25 input / $1.5 output up to 256k input');
  expect(tiered).toContain('$1 input / $4 output above 256k input');
});
