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
        inputPer1M: '0.1', outputPer1M: '0.2',
      }]}
    />,
  );
  expect(html).toContain('Unlisted: cloudflare:@cf/meta/llama-3.1-8b-instruct-fast');
  expect(html).toContain('Llama 3.1 8B Instruct fp8');
  expect(html).toContain('Cloudflare Workers AI');
});
